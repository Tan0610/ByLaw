import { listAllJobs } from '@bylaw/near-client';
import type { Agent, AgentContext } from '../runtime.ts';

/** Sales: accept_job on Posted jobs, award_job after the bid window, expire_job on stale jobs. */
export class SalesAgent implements Agent {
  readonly kind = 'Sales' as const;
  readonly name: string;
  private ctx: AgentContext;
  constructor(ctx: AgentContext) { this.ctx = ctx; this.name = ctx.name; }

  async tick(): Promise<void> {
    const { client, ledger, log } = this.ctx;
    const now = await client.nowNs();
    for (const j of await listAllJobs(client)) {
      const jl = log.child({ job_id: j.id });
      if (j.state === 'Posted') {
        if (await ledger.once(`${j.id}:accept`, jl, () => client.acceptJob(j.id))) jl.info('accept_job', { price: j.price, target: j.target });
      } else if (j.state === 'Open' && now >= BigInt(j.deadline_ns)) {
        if (await ledger.once(`${j.id}:award:${j.attempts}`, jl, () => client.awardJob(j.id))) {
          const after = await client.getJob(j.id);
          jl.info('award_job', { bids: j.bids.length, state: after?.state, winner: after?.winner, reviewer: after?.reviewer });
        }
      } else if ((j.state === 'Awarded' || j.state === 'Submitted') && now > BigInt(j.deadline_ns)) {
        if (await ledger.once(`${j.id}:expire:${j.state}:${j.attempts}`, jl, () => client.expireJob(j.id))) jl.warn('expire_job', { state: j.state });
      }
    }
  }
}
