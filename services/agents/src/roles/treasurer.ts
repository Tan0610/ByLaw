import { budgetFor, listAllJobs } from '@bylaw/near-client';
import type { ContractClient } from '@bylaw/near-client';
import type { Agent, AgentContext } from '../runtime.ts';
import { whoAmI } from '../runtime.ts';

/** Treasurer: buys a vendor service (e.g. RPC credits) for each settled job via request_spend. */
export class TreasurerAgent implements Agent {
  readonly kind = 'Treasurer' as const;
  readonly name: string;
  private ctx: AgentContext;
  private vendor: string;
  private amount: bigint;
  constructor(ctx: AgentContext, o: { vendor: string; amountPerJob: bigint }) {
    this.ctx = ctx; this.name = ctx.name; this.vendor = o.vendor; this.amount = o.amountPerJob;
  }

  async tick(): Promise<void> {
    const { client, ledger, log } = this.ctx;
    const me = await whoAmI(client);
    if (me.state !== 'Active') return;
    for (const j of await listAllJobs(client, 'Settled')) {
      const jl = log.child({ job_id: j.id });
      await ledger.once(`${j.id}:purchase`, jl, async () => {
        // At most once per job, checked against the chain. A spend is a real payment, so a retry must never
        // pay twice: an earlier attempt may have succeeded on-chain even though this step was marked failed
        // (for example the read-back below hit an RPC rate limit). Any record for this job counts, whatever its state.
        const already = (await client.listSpends()).find((x) => x.job === j.id && x.agent === me.token_id);
        if (already) { jl.info('purchase already recorded, not paying again', { request_id: already.id, state: already.state }); return; }
        const id = await client.requestSpend(this.vendor, this.amount.toString(), j.id, `rpc credits for job ${j.id}`);
        // The payment is made. Reading it back is only for the log: failing here must not make the step retry.
        try {
          const s = await client.getSpend(id);
          jl.info('request_spend', { request_id: id, vendor: this.vendor, amount: this.amount.toString(), state: s?.state, reason: s?.reason });
        } catch (e) {
          jl.warn('request_spend sent; could not read it back', { request_id: id, error: e instanceof Error ? e.message : String(e) });
        }
      });
    }
  }
}

export interface AttackResult { name: string; request_id: string; expected: string; state: string; reason: string; ok: boolean }

/**
 * The "attack" scene: a treasurer tries (1) an overspend above per_tx_cap, (2) a window-budget overspend,
 * (3) a non-allowlisted vendor. Each must come back as a RECORDED denial (state Rejected), never a payment.
 */
export async function runTreasurerAttack(client: ContractClient, allowlistedVendor: string, rogueVendor = 'attacker-wallet.testnet'): Promise<AttackResult[]> {
  const bylaw = await client.getByLaw();
  const me = await whoAmI(client);
  const out: AttackResult[] = [];
  const attempt = async (name: string, vendor: string, amount: bigint, expected: string) => {
    const id = await client.requestSpend(vendor, amount.toString(), null, `attack:${name}`);
    const s = await client.getSpend(id);
    out.push({ name, request_id: id, expected, state: s?.state ?? 'unknown', reason: s?.reason ?? '', ok: s?.state === 'Rejected' && (s?.reason ?? '').includes(expected) });
  };
  await attempt('overspend_per_tx_cap', allowlistedVendor, BigInt(bylaw.per_tx_cap) + 1n, 'per_tx_cap');
  const budget = budgetFor(bylaw, me.rep);
  const remaining = budget - BigInt(me.win_spent);
  if (remaining + 1n <= BigInt(bylaw.per_tx_cap)) await attempt('overspend_budget_window', allowlistedVendor, remaining + 1n, 'budget');
  await attempt('non_allowlisted_vendor', rogueVendor, 1_000_000n, 'vendor');
  return out;
}
