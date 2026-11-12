import { listAllJobs } from '@charter/near-client';
import type { Agent, AgentContext } from '../runtime.ts';
import { whoAmI } from '../runtime.ts';
import { bidPrice } from '../strategy.ts';
import type { FactsProvider } from '../facts.ts';
import type { Summarizer } from '../llm.ts';
import { buildReport } from '../report.ts';
import type { ArtifactStore } from '../report.ts';

export interface AnalystOptions {
  facts: FactsProvider;
  summarizer: Summarizer;
  store: ArtifactStore;
  uriFor: (hash: string) => string;
  aggressionBps: number;
  costFloor: bigint;
  /** Demo/testing only: corrupt facts before hashing, so the reviewer must reject. */
  tamper?: boolean;
}

/** Analyst: place_bid with the reputation-aware strategy; when awarded, build the report and submit_work. */
export class AnalystAgent implements Agent {
  readonly kind = 'Analyst' as const;
  readonly name: string;
  private ctx: AgentContext;
  private o: AnalystOptions;
  constructor(ctx: AgentContext, o: AnalystOptions) { this.ctx = ctx; this.o = o; this.name = ctx.name; }

  async tick(): Promise<void> {
    const { client, ledger, log } = this.ctx;
    const me = await whoAmI(client);
    if (me.state !== 'Active') { log.debug('not active, idle', { state: me.state }); return; }
    const now = await client.nowNs();
    const charter = await client.getCharter();
    for (const j of await listAllJobs(client)) {
      const jl = log.child({ job_id: j.id });
      if (j.state === 'Open' && now < BigInt(j.deadline_ns) && !j.bids.some((b) => b.agent === me.token_id)) {
        const price = bidPrice({
          jobPrice: BigInt(j.price), maxBidBps: charter.max_bid_bps, rep: me.rep, repBaseline: charter.rep_start,
          aggressionBps: this.o.aggressionBps, costFloor: this.o.costFloor,
        });
        if (price === null) { jl.info('skip bid: cap below cost floor'); continue; }
        if (await ledger.once(`${j.id}:bid`, jl, () => client.placeBid(j.id, price.toString()))) jl.info('place_bid', { price: price.toString(), rep: me.rep });
      } else if (j.state === 'Awarded' && j.winner === me.token_id) {
        await ledger.once(`${j.id}:submit:${j.attempts}`, jl, async () => {
          const facts = await this.o.facts.getFacts(j.target);
          const { summary, model } = await this.o.summarizer.summarize(j.target, facts);
          const report = buildReport({ target: j.target, facts, summary, model });
          if (this.o.tamper) {
            report.facts = { ...report.facts, full_access_keys: 0, upgradeable: false, storage_usage: report.facts.storage_usage + 1 };
            jl.warn('TAMPER enabled: submitting falsified facts');
          }
          const hash = await this.o.store.put(report);
          await client.submitWork(j.id, hash, this.o.uriFor(hash), null);
          jl.info('submit_work', { deliverable_hash: hash, model, fetched_at_block: report.facts.fetched_at_block });
        });
      }
    }
  }
}
