// Shapes of the indexer REST responses (docs/INTERFACES.md section 3).
// u128/u64 values are decimal strings. tUSD has 6 decimals.

export type Kind = "Sales" | "Analyst" | "Reviewer" | "Treasurer";
export type AgentState = "Active" | "Frozen" | "Retired";
export type JobState =
  | "Posted" | "Open" | "Awarded" | "Submitted" | "Accepted"
  | "Rejected" | "Settled" | "Refunded" | "Expired";

export interface Split { reviewer: number; producer: number; sales: number; treasury: number; seats: number }

export interface CharterParams {
  version: number;
  text: string;
  text_hash: string;
  min_price: string; max_price: string;
  bid_window_ns: string; submit_window_ns: string; review_window_ns: string;
  max_bid_bps: number;
  split: Split;
  rep_start: number; rep_gain: number; rep_loss: number; rep_expire_loss: number; rep_freeze_below: number;
  base_budget: string; per_rep_budget: string; max_budget: string; budget_window_ns: string;
  per_tx_cap: string; approval_threshold: string;
}

export interface CharterVersion {
  version: number;
  text: string;
  text_hash: string;
  changed_at_iso: string;
  proposal_id?: number;
  note?: string;
}

export interface AppConfig {
  contract_id: string; dao_id: string; token_id: string; guardians: string[];
  charter: { version: number; text_hash: string };
}

export interface Health { near_height: number; indexer_lag_s: number; agents_alive: string[]; llm_ok: boolean }

export interface Agent {
  token_id: string; account: string; kind: Kind; state: AgentState;
  owner: string; rep: number; delivered: number; rejected: number;
  budget: string; win_spent: string; win_start_iso: string;
  earnings: string;
  frozen_reason?: string;
}

export interface Bid { agent: string; agent_account: string; price: string; score: number; ts_iso: string }

export interface Credits { reviewer: string; producer: string; sales: string; seats: string; treasury: string }

export interface Job {
  id: string; customer: string; target: string; price: string; state: JobState;
  created_iso: string; deadline_iso?: string;
  sales?: string | null; bids: Bid[]; winner?: string | null; reviewer?: string | null;
  deliverable_hash?: string | null; uri?: string | null; attestation?: string | null;
  attempts: number;
  review?: { approve: boolean; reason?: string } | null;
  credits?: Credits | null;
}

export interface TimelineEvent { event: string; ts_iso: string; data: Record<string, unknown> }

export interface Spend {
  id: string; agent: string; agent_account: string; vendor: string; amount: string;
  job?: string | null; memo?: string; state: "Pending" | "Approved" | "Rejected" | "Paid";
  reason: string; ts_iso: string;
}

export interface Seat { token_id: string; owner: string; weight: number; pending: string }

export interface Stats {
  treasury: string; escrow: string; claimable_total: string;
  total_in: string; total_out: string; jobs_settled: number;
  solvency_ok: boolean;
}

export interface Report {
  schema: string; target: string;
  facts: {
    code_hash: string; storage_usage: number; balance: string;
    full_access_keys: number; function_call_keys: number; upgradeable: boolean; fetched_at_block: number;
  };
  summary: string; model: string; attestation: string | null;
}

// Sputnik DAO (read straight from the DAO contract, not the indexer)
export interface DaoProposal {
  id: number; proposer: string; description: string;
  kind: Record<string, unknown>;
  status: "InProgress" | "Approved" | "Rejected" | "Removed" | "Expired" | "Moved" | "Failed";
  vote_counts: Record<string, [string, string, string]>;
  votes: Record<string, "Approve" | "Reject" | "Remove">;
  submission_time: string;
}

export interface ProposalTemplate {
  name: string; method: string; description: string;
  args: Record<string, unknown>; deposit?: string; gas?: string;
}
