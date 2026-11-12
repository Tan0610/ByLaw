import { listAllJobs } from '@charter/near-client';
import type { Agent, AgentContext } from '../runtime.ts';
import { whoAmI } from '../runtime.ts';
import type { FactsProvider } from '../facts.ts';
import { reasonHash, verifyReport } from '../report.ts';
import type { ArtifactStore } from '../report.ts';

/** Reviewer: for jobs assigned to it, RECOMPUTE facts at the same block and review_work(approve iff identical). */
export class ReviewerAgent implements Agent {
  readonly kind = 'Reviewer' as const;
  readonly name: string;
  private ctx: AgentContext;
  private facts: FactsProvider;
  private store: ArtifactStore;
  readonly verdicts: { job_id: string; approve: boolean; reasons: string[] }[] = [];
  constructor(ctx: AgentContext, o: { facts: FactsProvider; store: ArtifactStore }) {
    this.ctx = ctx; this.name = ctx.name; this.facts = o.facts; this.store = o.store;
  }

  async tick(): Promise<void> {
    const { client, ledger, log } = this.ctx;
    const me = await whoAmI(client);
    if (me.state !== 'Active') return;
    for (const j of await listAllJobs(client, 'Submitted')) {
      if (j.reviewer !== me.token_id || !j.deliverable_hash) continue;
      const jl = log.child({ job_id: j.id });
      await ledger.once(`${j.id}:review:${j.attempts}:${j.deliverable_hash}`, jl, async () => {
        const report = await this.store.get(j.deliverable_hash!);
        const v = await verifyReport(j, report, this.facts); // throws on RPC failure -> retried next tick
        await client.reviewWork(j.id, v.approve, reasonHash(v));
        this.verdicts.push({ job_id: j.id, approve: v.approve, reasons: v.reasons });
        (v.approve ? jl.info : jl.warn)('review_work', { approve: v.approve, reasons: v.reasons, deliverable_hash: j.deliverable_hash });
      });
    }
  }
}
