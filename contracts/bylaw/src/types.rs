//! Domain types (Borsh in storage) and JSON views (u64/u128 as decimal strings).
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId};

pub type Hash = [u8; 32];

pub const BPS: u128 = 10_000;
/// Seat accumulator scale (seat_accumulator is scaled by 1e18).
pub const ACC_SCALE: u128 = 1_000_000_000_000_000_000;
pub const MAX_TEXT_BYTES: usize = 8192;
pub const MAX_BIDS: usize = 16;
pub const MAX_AGENTS: u32 = 32;
pub const MAX_SEATS: u32 = 64;
pub const MAX_GUARDIANS: usize = 16;
pub const MAX_SEAT_WEIGHT: u32 = 1_000_000;
/// Max price accepted by bylaw validation: 1e9 tUSD (6 decimals). Keeps the
/// seat_accumulator math (`seats * 1e18`) far below u128::MAX.
pub const MAX_PRICE_CAP: u128 = 1_000_000_000_000_000;
/// Sliding-window spend log capacity per agent.
pub const MAX_SPEND_LOG: usize = 64;
/// A `Posted` job not accepted within 24h can be expired (refunded) by anyone.
pub const POSTED_TTL_NS: u64 = 24 * 3600 * 1_000_000_000;
pub const MAX_URI_LEN: usize = 512;
pub const MAX_ATTESTATION_LEN: usize = 2048;
pub const MAX_MEMO_LEN: usize = 256;
pub const MAX_REASON_LEN: usize = 256;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Sales,
    Analyst,
    Reviewer,
    Treasurer,
}

impl Kind {
    /// Role -> method_names table used for the agent's function-call key.
    /// Pools (open_pool, contribute_pool) are not implemented in this build (see NOTES.md).
    pub fn method_names(&self) -> &'static str {
        match self {
            Kind::Sales => "accept_job,award_job",
            Kind::Analyst => "place_bid,submit_work",
            Kind::Reviewer => "review_work",
            Kind::Treasurer => "request_spend",
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Kind::Sales => "Sales",
            Kind::Analyst => "Analyst",
            Kind::Reviewer => "Reviewer",
            Kind::Treasurer => "Treasurer",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentState {
    Active,
    Frozen,
    Retired,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    pub token_id: u64,
    pub account: AccountId,
    pub kind: Kind,
    pub state: AgentState,
    pub rep: u32,
    pub delivered: u32,
    pub rejected: u32,
    /// Oldest entry still inside the sliding window (0 if none).
    pub win_start_ns: u64,
    /// Spent within the sliding window as of the last update (views recompute live).
    pub win_spent: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Split {
    pub reviewer: u16,
    pub producer: u16,
    pub sales: u16,
    pub treasury: u16,
    pub seats: u16,
}

impl Split {
    pub fn sum(&self) -> u32 {
        self.reviewer as u32
            + self.producer as u32
            + self.sales as u32
            + self.treasury as u32
            + self.seats as u32
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct ByLawParams {
    pub version: u32,
    pub text: String,
    pub text_hash: Hash,
    pub min_price: u128,
    pub max_price: u128,
    pub bid_window_ns: u64,
    pub submit_window_ns: u64,
    pub review_window_ns: u64,
    pub max_bid_bps: u16,
    pub split: Split,
    pub rep_start: u32,
    pub rep_gain: u32,
    pub rep_loss: u32,
    pub rep_expire_loss: u32,
    pub rep_freeze_below: u32,
    pub base_budget: u128,
    pub per_rep_budget: u128,
    pub max_budget: u128,
    pub budget_window_ns: u64,
    pub per_tx_cap: u128,
    pub approval_threshold: u128,
}

/// JSON form of ByLawParams (input to `new`/`set_bylaw`, output of `get_bylaw`).
/// `version` is ignored on input (the contract sets old+1).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ByLawParamsJson {
    pub version: Option<u32>,
    pub text: String,
    /// "0x" + 64 hex, must equal sha256(text)
    pub text_hash: String,
    pub min_price: U128,
    pub max_price: U128,
    pub bid_window_ns: U64,
    pub submit_window_ns: U64,
    pub review_window_ns: U64,
    pub max_bid_bps: u16,
    pub split: Split,
    pub rep_start: u32,
    pub rep_gain: u32,
    pub rep_loss: u32,
    pub rep_expire_loss: u32,
    pub rep_freeze_below: u32,
    pub base_budget: U128,
    pub per_rep_budget: U128,
    pub max_budget: U128,
    pub budget_window_ns: U64,
    pub per_tx_cap: U128,
    pub approval_threshold: U128,
}

impl ByLawParamsJson {
    pub fn into_params(self, version: u32) -> ByLawParams {
        ByLawParams {
            version,
            text_hash: parse_hash(&self.text_hash),
            text: self.text,
            min_price: self.min_price.0,
            max_price: self.max_price.0,
            bid_window_ns: self.bid_window_ns.0,
            submit_window_ns: self.submit_window_ns.0,
            review_window_ns: self.review_window_ns.0,
            max_bid_bps: self.max_bid_bps,
            split: self.split,
            rep_start: self.rep_start,
            rep_gain: self.rep_gain,
            rep_loss: self.rep_loss,
            rep_expire_loss: self.rep_expire_loss,
            rep_freeze_below: self.rep_freeze_below,
            base_budget: self.base_budget.0,
            per_rep_budget: self.per_rep_budget.0,
            max_budget: self.max_budget.0,
            budget_window_ns: self.budget_window_ns.0,
            per_tx_cap: self.per_tx_cap.0,
            approval_threshold: self.approval_threshold.0,
        }
    }

    pub fn from_params(p: &ByLawParams) -> Self {
        ByLawParamsJson {
            version: Some(p.version),
            text: p.text.clone(),
            text_hash: hex32(&p.text_hash),
            min_price: U128(p.min_price),
            max_price: U128(p.max_price),
            bid_window_ns: U64(p.bid_window_ns),
            submit_window_ns: U64(p.submit_window_ns),
            review_window_ns: U64(p.review_window_ns),
            max_bid_bps: p.max_bid_bps,
            split: p.split,
            rep_start: p.rep_start,
            rep_gain: p.rep_gain,
            rep_loss: p.rep_loss,
            rep_expire_loss: p.rep_expire_loss,
            rep_freeze_below: p.rep_freeze_below,
            base_budget: U128(p.base_budget),
            per_rep_budget: U128(p.per_rep_budget),
            max_budget: U128(p.max_budget),
            budget_window_ns: U64(p.budget_window_ns),
            per_tx_cap: U128(p.per_tx_cap),
            approval_threshold: U128(p.approval_threshold),
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JobState {
    Posted,
    Open,
    Awarded,
    Submitted,
    Accepted,
    Rejected,
    Settled,
    Refunded,
    Expired,
}

impl JobState {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobState::Posted => "Posted",
            JobState::Open => "Open",
            JobState::Awarded => "Awarded",
            JobState::Submitted => "Submitted",
            JobState::Accepted => "Accepted",
            JobState::Rejected => "Rejected",
            JobState::Settled => "Settled",
            JobState::Refunded => "Refunded",
            JobState::Expired => "Expired",
        }
    }
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            JobState::Settled | JobState::Refunded | JobState::Expired | JobState::Rejected
        )
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Bid {
    pub agent: u64,
    pub price: u128,
    pub ts_ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    pub id: u64,
    pub customer: AccountId,
    pub target: String,
    pub price: u128,
    pub state: JobState,
    pub created_ns: u64,
    pub sales: Option<u64>,
    pub bids: Vec<Bid>,
    pub winner: Option<u64>,
    pub reviewer: Option<u64>,
    pub deliverable_hash: Option<Hash>,
    pub uri: Option<String>,
    pub attestation: Option<String>,
    pub attempts: u8,
    /// Deadline of the current phase (Posted: TTL, Open: bid window, Awarded: submit, Submitted: review).
    pub deadline_ns: u64,
    /// Review timed out and was escalated to the DAO `override_review` queue.
    pub escalated: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SpendState {
    Pending,
    Approved,
    Rejected,
    Paid,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendRequest {
    pub id: u64,
    pub agent: u64,
    pub vendor: AccountId,
    pub amount: u128,
    pub job: Option<u64>,
    pub state: SpendState,
    pub reason: String,
    pub memo: String,
    pub ts_ns: u64,
    /// true if this request consumed an entry in the agent's sliding_window log
    pub logged: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Seat {
    pub token_id: u64,
    pub weight: u32,
    pub last_acc: u128,
}

// ---------------------------------------------------------------- views

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AgentView {
    pub token_id: U64,
    pub account: AccountId,
    pub kind: Kind,
    pub state: AgentState,
    pub owner: AccountId,
    pub rep: u32,
    pub delivered: u32,
    pub rejected: u32,
    pub win_start_ns: U64,
    pub win_spent: U128,
    pub budget: U128,
    pub method_names: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BidView {
    pub agent: U64,
    pub price: U128,
    pub ts_ns: U64,
    /// score = price * 1000 / (1000 + rep), lowest wins, tie -> earlier ts
    pub score: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct JobView {
    pub id: U64,
    pub customer: AccountId,
    pub target: String,
    pub price: U128,
    pub state: JobState,
    pub created_ns: U64,
    pub sales: Option<U64>,
    pub bids: Vec<BidView>,
    pub winner: Option<U64>,
    pub reviewer: Option<U64>,
    pub deliverable_hash: Option<String>,
    pub uri: Option<String>,
    pub attestation: Option<String>,
    pub attempts: u8,
    pub deadline_ns: U64,
    pub escalated: bool,
    pub escrow: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SpendView {
    pub id: U64,
    pub agent: U64,
    pub vendor: AccountId,
    pub amount: U128,
    pub job: Option<U64>,
    pub state: SpendState,
    pub reason: String,
    pub memo: String,
    pub ts_ns: U64,
}

impl SpendView {
    pub fn from(s: &SpendRequest) -> Self {
        SpendView {
            id: U64(s.id),
            agent: U64(s.agent),
            vendor: s.vendor.clone(),
            amount: U128(s.amount),
            job: s.job.map(U64),
            state: s.state,
            reason: s.reason.clone(),
            memo: s.memo.clone(),
            ts_ns: U64(s.ts_ns),
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BudgetView {
    pub token_id: U64,
    pub budget: U128,
    /// spent within the sliding window ending now
    pub win_spent: U128,
    pub remaining: U128,
    pub window_ns: U64,
    pub log_len: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SeatView {
    pub token_id: U64,
    pub owner: AccountId,
    pub weight: u32,
    /// seat_accumulator value at the last checkpoint (scaled 1e18)
    pub last_acc: U128,
    pub pending: U128,
}

/// Field names follow the Lane B request in INTERFACES.md section 7.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct StatsView {
    pub treasury: U128,
    pub escrow_total: U128,
    pub claimable_total: U128,
    /// pools are not implemented in this build: always "0"
    pub pools_total: U128,
    pub seat_pool: U128,
    pub seat_accumulator: U128,
    pub total_seat_weight: U64,
    pub total_in: U128,
    pub total_out: U128,
    pub solvent: bool,
    pub jobs_total: U64,
    pub jobs_settled: U64,
    pub spends_total: U64,
    pub agents_total: u32,
    pub seats_total: u32,
    pub paused: bool,
    pub bylaw_version: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ConfigView {
    pub owner: AccountId,
    pub token: AccountId,
    pub guardians: Vec<AccountId>,
    pub paused: bool,
    pub bylaw_version: u32,
    pub text_hash: String,
}

// ---------------------------------------------------------------- hex helpers

const HEX: &[u8; 16] = b"0123456789abcdef";

pub fn hex32(h: &Hash) -> String {
    let mut s = String::with_capacity(66);
    s.push_str("0x");
    for b in h.iter() {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn nib(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Parses "0x" + 64 hex (the 0x prefix is optional). Panics with an explicit message.
pub fn parse_hash(s: &str) -> Hash {
    try_parse_hash(s).unwrap_or_else(|| env::panic_str("hash must be 0x + 64 hex chars"))
}

pub fn try_parse_hash(s: &str) -> Option<Hash> {
    let s = s.strip_prefix("0x").unwrap_or(s).as_bytes();
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = (nib(s[2 * i])? << 4) | nib(s[2 * i + 1])?;
    }
    Some(out)
}
