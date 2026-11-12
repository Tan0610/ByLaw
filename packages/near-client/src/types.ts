// Types follow CONTRACT_SPEC.md section 2. u64/u128 are decimal strings, ids are strings.
export type Kind = 'Sales' | 'Analyst' | 'Reviewer' | 'Treasurer';
export type AgentState = 'Active' | 'Frozen' | 'Retired';
export type JobState =
  | 'Posted' | 'Open' | 'Awarded' | 'Submitted' | 'Accepted' | 'Rejected' | 'Settled' | 'Refunded' | 'Expired';
export type SpendState = 'Pending' | 'Approved' | 'Rejected' | 'Paid';

export interface Agent {
  token_id: string;
  account: string;
  owner: string; // NFT owner (earnings go here); INTERFACES.md agent view has `owner`
  kind: Kind;
  state: AgentState;
  rep: number;
  delivered: number;
  rejected: number;
  win_start_ns: string;
  win_spent: string;
}

export interface Split { reviewer: number; producer: number; sales: number; treasury: number; seats: number }

export interface ByLawParams {
  version: number;
  text: string;
  text_hash: string; // 0x sha256(text)
  min_price: string; max_price: string;
  bid_window_ns: string; submit_window_ns: string; review_window_ns: string;
  max_bid_bps: number;
  split: Split;
  rep_start: number; rep_gain: number; rep_loss: number; rep_expire_loss: number; rep_freeze_below: number;
  base_budget: string; per_rep_budget: string; max_budget: string; budget_window_ns: string;
  per_tx_cap: string; approval_threshold: string;
}

export interface Bid { agent: string; price: string; ts_ns: string }

export interface Job {
  id: string;
  customer: string;
  target: string;
  price: string;
  state: JobState;
  created_ns: string;
  sales: string | null;
  bids: Bid[];
  winner: string | null;
  reviewer: string | null;
  deliverable_hash: string | null;
  uri: string | null;
  attestation: string | null;
  attempts: number;
  deadline_ns: string;
}

export interface SpendRequest {
  id: string; agent: string; vendor: string; amount: string; job: string | null;
  state: SpendState; reason: string; memo?: string; ts_ns?: string;
}

export interface Seat { token_id: string; owner: string; weight: number; last_acc: string }

export interface Stats {
  treasury: string;
  escrow_total: string;
  claimable_total: string;
  pools_total: string;
  seat_pool: string; // seat dividends accrued but not yet checkpointed to claimable
  total_in: string;
  total_out: string;
  jobs_total: number;
  jobs_settled: number;
  agents_total: number;
  seats_total: number;
  total_seat_weight: string;
}

export interface JobListOpts { from?: number; limit?: number; state?: JobState }

export interface ContractEvent { standard: 'bylaw'; version: '1.0.0'; event: string; data: Record<string, unknown>[] }
