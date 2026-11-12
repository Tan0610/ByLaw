import type { Agent, Bid, CharterParams, Split } from './types.ts';

export const ACC_SCALE = 10n ** 18n;

/** score = price * 1000 / (1000 + rep). Lower wins. (CONTRACT_SPEC 4.4) */
export function scoreBid(price: bigint | string, rep: number): bigint {
  return (BigInt(price) * 1000n) / (1000n + BigInt(rep));
}

/** Lowest score wins; tie -> earlier ts_ns; then lower agent id (determinism). */
export function pickWinner(bids: Bid[], repOf: (agentId: string) => number, exclude: Set<string> = new Set()): Bid | null {
  const cands = bids.filter((b) => !exclude.has(b.agent));
  if (cands.length === 0) return null;
  const sorted = [...cands].sort((a, b) => {
    const sa = scoreBid(a.price, repOf(a.agent));
    const sb = scoreBid(b.price, repOf(b.agent));
    if (sa !== sb) return sa < sb ? -1 : 1;
    const ta = BigInt(a.ts_ns), tb = BigInt(b.ts_ns);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return BigInt(a.agent) < BigInt(b.agent) ? -1 : 1;
  });
  return sorted[0];
}

/** reviewers[job_id % n] whose owner != winner owner, else next. (CONTRACT_SPEC 4.4) */
export function pickReviewer(jobId: string, reviewers: Agent[], winnerOwner: string): Agent | null {
  const rs = reviewers.filter((r) => r.state === 'Active').sort((a, b) => Number(BigInt(a.token_id) - BigInt(b.token_id)));
  const n = rs.length;
  if (n === 0) return null;
  const start = Number(BigInt(jobId) % BigInt(n));
  for (let i = 0; i < n; i++) {
    const r = rs[(start + i) % n];
    if (r.owner !== winnerOwner) return r;
  }
  return null;
}

export interface Waterfall {
  reviewer: bigint; producer: bigint; sales: bigint; seats: bigint; treasury: bigint; acc_delta: bigint;
}

/** Deterministic waterfall (CONTRACT_SPEC 4.9). Treasury gets all rounding. credits sum == price. */
export function computeWaterfall(price: bigint, split: Split, totalSeatWeight: bigint): Waterfall {
  const part = (bps: number) => (price * BigInt(bps)) / 10000n;
  const reviewer = part(split.reviewer);
  const producer = part(split.producer);
  const sales = part(split.sales);
  const seatsShare = part(split.seats);
  let seats = 0n;
  let acc_delta = 0n;
  if (totalSeatWeight > 0n) {
    acc_delta = (seatsShare * ACC_SCALE) / totalSeatWeight;
    seats = (acc_delta * totalSeatWeight) / ACC_SCALE;
  }
  const treasury = price - reviewer - producer - sales - seats;
  return { reviewer, producer, sales, seats, treasury, acc_delta };
}

/** budget(agent) = min(max_budget, base_budget + per_rep_budget * rep / 100). (CONTRACT_SPEC 4.10) */
export function budgetFor(p: CharterParams, rep: number): bigint {
  const b = BigInt(p.base_budget) + (BigInt(p.per_rep_budget) * BigInt(rep)) / 100n;
  const max = BigInt(p.max_budget);
  return b < max ? b : max;
}

export function maxBidFor(p: CharterParams, jobPrice: bigint | string): bigint {
  return (BigInt(jobPrice) * BigInt(p.max_bid_bps)) / 10000n;
}

export function validateSplit(s: Split): boolean {
  return s.reviewer + s.producer + s.sales + s.treasury + s.seats === 10000;
}
