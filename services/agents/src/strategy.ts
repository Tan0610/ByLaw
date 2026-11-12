/**
 * Analyst bid strategy. The contract scores bids as price*1000/(1000+rep) (lower wins), so an analyst
 * with reputation above the baseline (rep_start) can ask proportionally more for the same score.
 *   target = job_price * aggression_bps / 10000 * (1000 + rep) / (1000 + rep_baseline)
 *   bid    = clamp(target, cost_floor, job_price * max_bid_bps / 10000)
 * Returns null if the cap is below the cost floor (not worth bidding).
 */
export interface BidInput {
  jobPrice: bigint;
  maxBidBps: number;
  rep: number;
  repBaseline: number;
  aggressionBps: number; // e.g. 5500 = bid ~55% of job price at baseline rep
  costFloor: bigint;
}

export function bidPrice(i: BidInput): bigint | null {
  const cap = (i.jobPrice * BigInt(i.maxBidBps)) / 10000n;
  if (cap < i.costFloor || cap <= 0n) return null;
  let target = (i.jobPrice * BigInt(i.aggressionBps)) / 10000n;
  target = (target * BigInt(1000 + i.rep)) / BigInt(1000 + i.repBaseline);
  if (target < i.costFloor) target = i.costFloor;
  if (target > cap) target = cap;
  return target;
}
