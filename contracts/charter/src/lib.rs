//! Charter: an executable company constitution on NEAR.
//!
//! Owner = a Sputnik DAO. Agents are sub-accounts `<name>.<this>` holding only a function-call
//! key restricted to their role's `method_names` (see `register_agent`). Money lives in the
//! contract ledger (escrow, treasury, claimable, seat pool) and is pulled with `claim`.
//!
//! Solvency invariant (C2):
//!   total_claimable + total_escrow + treasury + seat_pool == total_in - total_out
//! (pools are not implemented in this build, so their term is 0.)

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseOrValue, PublicKey,
};

pub mod events;
pub mod nft;
pub mod types;

#[cfg(test)]
mod tests;

use events::emit;
use types::*;

/// Minimum attached deposit for `register_agent` / `rotate_agent` (gas funding + account storage).
pub const MIN_AGENT_DEPOSIT: u128 = 500_000_000_000_000_000_000_000; // 0.5 NEAR
/// Allowance of the agent's function-call key ("generous").
pub const AGENT_KEY_ALLOWANCE: u128 = 10_000_000_000_000_000_000_000_000; // 10 NEAR
const ONE_YOCTO: u128 = 1;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_REGISTER_CB: Gas = Gas::from_tgas(20);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
pub enum StorageKey {
    Agents,
    AgentByAccount,
    Seats,
    NftOwner,
    Jobs,
    Escrow,
    Spends,
    Vendors,
    Claimable,
    SpendLog,
    CharterHistory,
}

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub(crate) owner: AccountId,
    pub(crate) token: AccountId,
    pub(crate) guardians: Vec<AccountId>,
    pub(crate) paused: bool,
    pub(crate) params: CharterParams,
    pub(crate) next_token_id: u64,
    pub(crate) next_job_id: u64,
    pub(crate) next_spend_id: u64,
    pub(crate) pending_registrations: u32,
    pub(crate) agents: IterableMap<u64, Agent>,
    pub(crate) agent_by_account: LookupMap<AccountId, u64>,
    pub(crate) seats: IterableMap<u64, Seat>,
    pub(crate) nft_owner: IterableMap<u64, AccountId>,
    pub(crate) jobs: LookupMap<u64, Job>,
    pub(crate) escrow: LookupMap<u64, u128>,
    pub(crate) spends: LookupMap<u64, SpendRequest>,
    pub(crate) vendors: LookupSet<AccountId>,
    pub(crate) claimable: LookupMap<AccountId, u128>,
    /// sliding_window spend log per agent: up to MAX_SPEND_LOG (timestamp_ns, amount) entries.
    pub(crate) spend_log: LookupMap<u64, Vec<(u64, u128)>>,
    pub(crate) treasury: u128,
    pub(crate) total_escrow: u128,
    pub(crate) total_claimable: u128,
    /// Amount distributed through the seat_accumulator and not yet checkpointed to claimable.
    pub(crate) seat_pool: u128,
    /// seat_accumulator, scaled by ACC_SCALE (1e18).
    pub(crate) acc: u128,
    pub(crate) total_seat_weight: u64,
    pub(crate) total_in: u128,
    pub(crate) total_out: u128,
    pub(crate) jobs_settled: u64,
    /// Previous charter versions (text + params), for `get_charter_version`.
    pub(crate) charter_history: LookupMap<u32, CharterParams>,
}

#[near]
impl Contract {
    // ================================================================ init / owner

    #[init]
    pub fn new(owner: AccountId, token: AccountId, params: CharterParamsJson) -> Self {
        let p = params.into_params(1);
        Self::validate_params(&p);
        let mut c = Self {
            owner,
            token,
            guardians: Vec::new(),
            paused: false,
            params: p,
            next_token_id: 1,
            next_job_id: 1,
            next_spend_id: 1,
            pending_registrations: 0,
            agents: IterableMap::new(StorageKey::Agents),
            agent_by_account: LookupMap::new(StorageKey::AgentByAccount),
            seats: IterableMap::new(StorageKey::Seats),
            nft_owner: IterableMap::new(StorageKey::NftOwner),
            jobs: LookupMap::new(StorageKey::Jobs),
            escrow: LookupMap::new(StorageKey::Escrow),
            spends: LookupMap::new(StorageKey::Spends),
            vendors: LookupSet::new(StorageKey::Vendors),
            claimable: LookupMap::new(StorageKey::Claimable),
            spend_log: LookupMap::new(StorageKey::SpendLog),
            treasury: 0,
            total_escrow: 0,
            total_claimable: 0,
            seat_pool: 0,
            acc: 0,
            total_seat_weight: 0,
            total_in: 0,
            total_out: 0,
            jobs_settled: 0,
            charter_history: LookupMap::new(StorageKey::CharterHistory),
        };
        let h = hex32(&c.params.text_hash);
        emit(
            "charter_updated",
            json!({"version": c.params.version, "old_hash": hex32(&[0u8; 32]), "new_hash": h}),
        );
        c.paused = false;
        c
    }

    /// Owner: replace charter text + params. version = old + 1; text_hash must equal sha256(text).
    pub fn set_charter(&mut self, params: CharterParamsJson) {
        self.require_owner();
        let old_hash = self.params.text_hash;
        let p = params.into_params(self.params.version + 1);
        Self::validate_params(&p);
        let old = std::mem::replace(&mut self.params, p);
        self.charter_history.insert(old.version, old);
        emit(
            "charter_updated",
            json!({
                "version": self.params.version,
                "old_hash": hex32(&old_hash),
                "new_hash": hex32(&self.params.text_hash),
            }),
        );
    }

    pub fn set_guardians(&mut self, guardians: Vec<AccountId>) {
        self.require_owner();
        require!(
            guardians.len() <= MAX_GUARDIANS,
            "too many guardians (max 16)"
        );
        let mut g: Vec<AccountId> = Vec::new();
        for a in guardians {
            if !g.contains(&a) {
                g.push(a);
            }
        }
        self.guardians = g;
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.require_owner();
        self.paused = paused;
    }

    pub fn set_vendor(&mut self, vendor: AccountId, allowed: bool) {
        self.require_owner();
        if allowed {
            self.vendors.insert(vendor);
        } else {
            self.vendors.remove(&vendor);
        }
    }

    /// Owner: send treasury funds out. State is debited before the promise and restored on failure.
    pub fn treasury_withdraw(&mut self, to: AccountId, amount: U128) -> Promise {
        self.require_owner();
        let a = amount.0;
        require!(a > 0, "amount must be positive");
        require!(a <= self.treasury, "treasury insufficient");
        self.treasury -= a;
        self.total_out += a;
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(ONE_YOCTO))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(
                to.clone(),
                U128(a),
                Some("charter treasury_withdraw".to_string()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_withdraw(to, U128(a)),
            )
    }

    #[private]
    pub fn on_withdraw(&mut self, to: AccountId, amount: U128) -> bool {
        let ok = promise_ok();
        if !ok {
            self.treasury += amount.0;
            self.total_out -= amount.0;
        }
        let _ = to;
        ok
    }

    // ================================================================ agents

    /// Owner: create `<name>.<this>`, fund it with the attached deposit, add a function-call key
    /// (receiver = this contract, method_names = role set, generous allowance; no full-access key),
    /// then the callback mints the agent NFT to `owner_account`.
    #[payable]
    pub fn register_agent(
        &mut self,
        kind: Kind,
        name: String,
        owner_account: AccountId,
        pubkey: PublicKey,
    ) -> Promise {
        self.require_owner();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            deposit >= MIN_AGENT_DEPOSIT,
            "attach at least 0.5 NEAR to fund the agent account"
        );
        require!(
            self.agents.len() + self.pending_registrations < MAX_AGENTS,
            "agent limit reached (max 32)"
        );
        let account = Self::sub_account(&name);
        require!(
            !self.agent_by_account.contains_key(&account),
            "agent account already registered"
        );
        self.pending_registrations += 1;
        Self::create_agent_account(account.clone(), deposit, pubkey, kind).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_REGISTER_CB)
                .on_agent_created(
                    kind,
                    account,
                    owner_account,
                    U128(deposit),
                    env::predecessor_account_id(),
                ),
        )
    }

    #[private]
    pub fn on_agent_created(
        &mut self,
        kind: Kind,
        account: AccountId,
        owner_account: AccountId,
        deposit: U128,
        refund_to: AccountId,
    ) -> Option<U64> {
        self.pending_registrations = self.pending_registrations.saturating_sub(1);
        if !promise_ok() || self.agent_by_account.contains_key(&account) {
            refund(&refund_to, deposit.0);
            return None;
        }
        Some(U64(self.internal_add_agent(kind, account, owner_account)))
    }

    /// Owner: issue a fresh identity (new sub-account + key) for an existing agent NFT.
    /// The old account is unbound in the callback (its key can no longer act: the contract
    /// rejects it). Reputation, counters and the NFT owner carry over.
    #[payable]
    pub fn rotate_agent(&mut self, token_id: U64, new_name: String, pubkey: PublicKey) -> Promise {
        self.require_owner();
        let a = self.agent(token_id.0);
        require!(a.state != AgentState::Retired, "agent is retired");
        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            deposit >= MIN_AGENT_DEPOSIT,
            "attach at least 0.5 NEAR to fund the agent account"
        );
        let account = Self::sub_account(&new_name);
        require!(
            !self.agent_by_account.contains_key(&account),
            "agent account already registered"
        );
        Self::create_agent_account(account.clone(), deposit, pubkey, a.kind).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_REGISTER_CB)
                .on_agent_rotated(
                    token_id,
                    account,
                    U128(deposit),
                    env::predecessor_account_id(),
                ),
        )
    }

    #[private]
    pub fn on_agent_rotated(
        &mut self,
        token_id: U64,
        new_account: AccountId,
        deposit: U128,
        refund_to: AccountId,
    ) -> bool {
        let still_ok = self
            .agents
            .get(&token_id.0)
            .map(|a| a.state != AgentState::Retired)
            .unwrap_or(false);
        if !promise_ok() || !still_ok || self.agent_by_account.contains_key(&new_account) {
            refund(&refund_to, deposit.0);
            return false;
        }
        let mut a = self.agent(token_id.0);
        let old = a.account.clone();
        self.agent_by_account.remove(&old);
        a.account = new_account.clone();
        self.agent_by_account
            .insert(new_account.clone(), a.token_id);
        self.agents.insert(a.token_id, a);
        emit(
            "agent_rotated",
            json!({"token_id": token_id.0.to_string(), "old_account": old, "new_account": new_account}),
        );
        true
    }

    /// Guardian or owner: freeze an Active agent. Guardians cannot unfreeze.
    pub fn freeze_agent(&mut self, token_id: U64, reason: String) {
        let by = env::predecessor_account_id();
        require!(
            by == self.owner || self.guardians.contains(&by),
            "only a guardian or the owner can freeze"
        );
        require!(reason.len() <= MAX_REASON_LEN, "reason too long");
        let mut a = self.agent(token_id.0);
        require!(a.state == AgentState::Active, "agent is not active");
        a.state = AgentState::Frozen;
        self.agents.insert(a.token_id, a);
        emit(
            "agent_frozen",
            json!({"token_id": token_id.0.to_string(), "by": by, "reason": reason}),
        );
    }

    pub fn unfreeze_agent(&mut self, token_id: U64) {
        self.require_owner();
        let mut a = self.agent(token_id.0);
        require!(a.state == AgentState::Frozen, "agent is not frozen");
        a.state = AgentState::Active;
        self.agents.insert(a.token_id, a);
        emit(
            "agent_unfrozen",
            json!({"token_id": token_id.0.to_string(), "by": env::predecessor_account_id()}),
        );
    }

    pub fn retire_agent(&mut self, token_id: U64, reason: Option<String>) {
        self.require_owner();
        let mut a = self.agent(token_id.0);
        require!(a.state != AgentState::Retired, "agent already retired");
        a.state = AgentState::Retired;
        self.agents.insert(a.token_id, a);
        emit(
            "agent_retired",
            json!({"token_id": token_id.0.to_string(), "by": env::predecessor_account_id(), "reason": reason}),
        );
    }

    // ================================================================ seats

    pub fn mint_seat(&mut self, owner: AccountId, weight: u32) -> U64 {
        self.require_owner();
        require!(self.seats.len() < MAX_SEATS, "seat limit reached (max 64)");
        require!(
            weight > 0 && weight <= MAX_SEAT_WEIGHT,
            "weight must be in 1..=1000000"
        );
        let id = self.next_token_id;
        self.next_token_id += 1;
        self.seats.insert(
            id,
            Seat {
                token_id: id,
                weight,
                last_acc: self.acc,
            },
        );
        self.nft_owner.insert(id, owner.clone());
        self.total_seat_weight += weight as u64;
        events::nft_mint(owner.as_str(), id);
        emit(
            "seat_minted",
            json!({"token_id": id.to_string(), "owner": owner, "weight": weight}),
        );
        U64(id)
    }

    pub fn set_seat_weight(&mut self, token_id: U64, weight: u32) {
        self.require_owner();
        require!(weight <= MAX_SEAT_WEIGHT, "weight must be <= 1000000");
        self.internal_checkpoint(token_id.0);
        let mut s = self.seat(token_id.0);
        self.total_seat_weight = self.total_seat_weight - s.weight as u64 + weight as u64;
        s.weight = weight;
        self.seats.insert(s.token_id, s);
    }

    /// Anyone: credit a seat's pending dividends to its owner's claimable balance.
    pub fn checkpoint_seat(&mut self, token_id: U64) -> U128 {
        U128(self.internal_checkpoint(token_id.0))
    }

    // ================================================================ customer (via token)

    /// NEP-141 receiver. msg: {"action":"post_job","target":"<account>"} or {"action":"fund_treasury"}.
    /// Returns the unused amount (full refund on any invalid input).
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.token,
            "only the configured token can call ft_on_transfer"
        );
        let a = amount.0;
        let v: Value = match serde_json::from_str(&msg) {
            Ok(v) => v,
            Err(_) => return PromiseOrValue::Value(amount),
        };
        let action = v.get("action").and_then(|x| x.as_str()).unwrap_or("");
        match action {
            "post_job" => {
                if self.paused || a < self.params.min_price || a > self.params.max_price {
                    return PromiseOrValue::Value(amount);
                }
                let target = match v.get("target").and_then(|x| x.as_str()) {
                    Some(t) if t.parse::<AccountId>().is_ok() => t.to_string(),
                    _ => return PromiseOrValue::Value(amount),
                };
                let now = env::block_timestamp();
                let id = self.next_job_id;
                self.next_job_id += 1;
                let job = Job {
                    id,
                    customer: sender_id.clone(),
                    target: target.clone(),
                    price: a,
                    state: JobState::Posted,
                    created_ns: now,
                    sales: None,
                    bids: Vec::new(),
                    winner: None,
                    reviewer: None,
                    deliverable_hash: None,
                    uri: None,
                    attestation: None,
                    attempts: 0,
                    deadline_ns: now + POSTED_TTL_NS,
                    escalated: false,
                };
                self.jobs.insert(id, job);
                self.escrow.insert(id, a);
                self.total_escrow += a;
                self.total_in += a;
                emit(
                    "job_posted",
                    json!({"job_id": id.to_string(), "customer": sender_id, "target": target, "price": a.to_string()}),
                );
                PromiseOrValue::Value(U128(0))
            }
            "fund_treasury" => {
                if a == 0 {
                    return PromiseOrValue::Value(amount);
                }
                self.treasury += a;
                self.total_in += a;
                emit(
                    "treasury_funded",
                    json!({"from": sender_id, "amount": a.to_string()}),
                );
                PromiseOrValue::Value(U128(0))
            }
            _ => PromiseOrValue::Value(amount),
        }
    }

    // ================================================================ sales

    pub fn accept_job(&mut self, job: U64) {
        let ag = self.caller_agent(Kind::Sales);
        let mut j = self.job(job.0);
        require!(j.state == JobState::Posted, "job is not Posted");
        let now = env::block_timestamp();
        require!(now <= j.deadline_ns, "job posting expired");
        j.state = JobState::Open;
        j.sales = Some(ag.token_id);
        j.deadline_ns = now + self.params.bid_window_ns;
        emit(
            "job_opened",
            json!({"job_id": j.id.to_string(), "sales_token_id": ag.token_id.to_string(), "bid_deadline_ns": j.deadline_ns.to_string()}),
        );
        self.jobs.insert(j.id, j);
    }

    /// After the bid window: lowest score = price*1000/(1000+rep) wins (tie: earlier bid); a reviewer
    /// is picked as reviewers[job.id % n] (Active, sorted by token id) whose owner != winner owner.
    /// No eligible bid -> refund to the customer's claimable balance.
    pub fn award_job(&mut self, job: U64) {
        let ag = self.caller_agent(Kind::Sales);
        let mut j = self.job(job.0);
        require!(j.state == JobState::Open, "job is not Open");
        require!(
            j.sales == Some(ag.token_id),
            "only the job's sales agent can award"
        );
        require!(
            env::block_timestamp() > j.deadline_ns,
            "bid window still open"
        );
        if !self.internal_assign(&mut j, &[]) {
            self.internal_refund(&mut j, JobState::Refunded, "no_eligible_bid");
        }
        self.jobs.insert(j.id, j);
    }

    // ================================================================ analyst

    pub fn place_bid(&mut self, job: U64, price: U128) {
        let ag = self.caller_agent(Kind::Analyst);
        let mut j = self.job(job.0);
        require!(j.state == JobState::Open, "job is not Open");
        let now = env::block_timestamp();
        require!(now <= j.deadline_ns, "bid window closed");
        require!(price.0 > 0, "bid must be positive");
        let cap = j.price * self.params.max_bid_bps as u128 / BPS;
        require!(price.0 <= cap, "bid exceeds price * max_bid_bps / 10000");
        require!(
            !j.bids.iter().any(|b| b.agent == ag.token_id),
            "agent already bid"
        );
        require!(j.bids.len() < MAX_BIDS, "bid limit reached (max 16)");
        j.bids.push(Bid {
            agent: ag.token_id,
            price: price.0,
            ts_ns: now,
        });
        emit(
            "bid_placed",
            json!({"job_id": j.id.to_string(), "agent": ag.token_id.to_string(), "price": price.0.to_string()}),
        );
        self.jobs.insert(j.id, j);
    }

    pub fn submit_work(
        &mut self,
        job: U64,
        hash: String,
        uri: String,
        attestation: Option<String>,
    ) {
        let ag = self.caller_agent(Kind::Analyst);
        let mut j = self.job(job.0);
        require!(j.state == JobState::Awarded, "job is not Awarded");
        require!(j.winner == Some(ag.token_id), "only the winner can submit");
        let now = env::block_timestamp();
        require!(now <= j.deadline_ns, "submit deadline passed");
        require!(uri.len() <= MAX_URI_LEN, "uri too long");
        if let Some(a) = &attestation {
            require!(a.len() <= MAX_ATTESTATION_LEN, "attestation too long");
        }
        let h = parse_hash(&hash);
        j.deliverable_hash = Some(h);
        j.uri = Some(uri.clone());
        j.attestation = attestation.clone();
        j.state = JobState::Submitted;
        j.deadline_ns = now + self.params.review_window_ns;
        emit(
            "work_submitted",
            json!({"job_id": j.id.to_string(), "deliverable_hash": hex32(&h), "uri": uri, "attestation": attestation}),
        );
        self.jobs.insert(j.id, j);
    }

    // ================================================================ reviewer

    pub fn review_work(&mut self, job: U64, approve: bool, reason_hash: String) {
        let ag = self.caller_agent(Kind::Reviewer);
        let mut j = self.job(job.0);
        require!(j.state == JobState::Submitted, "job is not Submitted");
        require!(
            j.reviewer == Some(ag.token_id),
            "only the assigned reviewer can review"
        );
        require!(!j.escalated, "review escalated to the DAO");
        require!(
            env::block_timestamp() <= j.deadline_ns,
            "review deadline passed"
        );
        let winner = j
            .winner
            .unwrap_or_else(|| env::panic_str("job has no winner"));
        require!(
            self.owner_of(ag.token_id) != self.owner_of(winner),
            "owner conflict: reviewer and producer have the same owner"
        );
        let rh = parse_hash(&reason_hash);
        emit(
            "work_reviewed",
            json!({"job_id": j.id.to_string(), "reviewer": ag.token_id.to_string(), "approve": approve, "reason_hash": hex32(&rh)}),
        );
        self.internal_resolve_review(&mut j, approve, "review");
        self.jobs.insert(j.id, j);
    }

    /// Owner (DAO): decide a Submitted job (e.g. after a review timeout escalation).
    pub fn override_review(&mut self, job: U64, approve: bool) {
        self.require_owner();
        let mut j = self.job(job.0);
        require!(j.state == JobState::Submitted, "job is not Submitted");
        emit(
            "review_overridden",
            json!({"job_id": j.id.to_string(), "approve": approve}),
        );
        self.internal_resolve_review(&mut j, approve, "override");
        self.jobs.insert(j.id, j);
    }

    // ================================================================ anyone

    /// Anyone: enforce timeouts.
    /// Posted past 24h -> refund. Open past bid window + submit window with no award -> refund.
    /// Awarded past deadline -> winner loses rep_expire_loss; re-open once to the next-best bid, else refund.
    /// Submitted past review deadline -> escalate to the DAO override queue (event), once.
    pub fn expire_job(&mut self, job: U64) {
        let mut j = self.job(job.0);
        let now = env::block_timestamp();
        require!(now > j.deadline_ns, "deadline not reached");
        match j.state {
            JobState::Posted => {
                emit(
                    "job_expired",
                    json!({"job_id": j.id.to_string(), "reason": "posted_timeout"}),
                );
                self.internal_refund(&mut j, JobState::Expired, "posted_timeout");
            }
            JobState::Open => {
                require!(
                    now > j.deadline_ns + self.params.submit_window_ns,
                    "award grace period not over"
                );
                emit(
                    "job_expired",
                    json!({"job_id": j.id.to_string(), "reason": "award_timeout"}),
                );
                self.internal_refund(&mut j, JobState::Expired, "award_timeout");
            }
            JobState::Awarded => {
                let w = j
                    .winner
                    .unwrap_or_else(|| env::panic_str("job has no winner"));
                let mut wa = self.agent(w);
                let new_rep = wa.rep.saturating_sub(self.params.rep_expire_loss);
                self.internal_set_rep(&mut wa, new_rep, "expired");
                self.agents.insert(wa.token_id, wa);
                emit(
                    "job_expired",
                    json!({"job_id": j.id.to_string(), "reason": "submit_timeout"}),
                );
                self.internal_reopen_or_refund(&mut j, w, JobState::Expired, "submit_timeout");
            }
            JobState::Submitted => {
                require!(!j.escalated, "already escalated");
                j.escalated = true;
                emit(
                    "job_expired",
                    json!({"job_id": j.id.to_string(), "reason": "review_timeout"}),
                );
            }
            _ => env::panic_str("job cannot expire in this state"),
        }
        self.jobs.insert(j.id, j);
    }

    /// Pays claimable[caller] via ft_transfer (after checkpointing the caller's seats).
    /// Balance is zeroed before the call and restored in `on_claim` if the transfer fails (C11).
    pub fn claim(&mut self, token: Option<AccountId>) -> Promise {
        if let Some(t) = &token {
            require!(t == &self.token, "unknown token");
        }
        let who = env::predecessor_account_id();
        let owned: Vec<u64> = self
            .seats
            .keys()
            .copied()
            .filter(|id| self.nft_owner.get(id) == Some(&who))
            .collect();
        for id in owned {
            self.internal_checkpoint(id);
        }
        let amt = self.claimable.get(&who).copied().unwrap_or(0);
        require!(amt > 0, "nothing to claim");
        self.claimable.remove(&who);
        self.total_claimable -= amt;
        self.total_out += amt;
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(ONE_YOCTO))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(who.clone(), U128(amt), Some("charter claim".to_string()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_claim(who, U128(amt)),
            )
    }

    #[private]
    pub fn on_claim(&mut self, account: AccountId, amount: U128) -> bool {
        if promise_ok() {
            emit(
                "claimed",
                json!({"account": account, "amount": amount.0.to_string()}),
            );
            true
        } else {
            self.total_out -= amount.0;
            self.internal_credit(&account, amount.0);
            false
        }
    }

    // ================================================================ treasurer / spends

    /// Treasurer: request a vendor payment. Policy failures never panic; they are recorded as
    /// `Rejected` with a reason and emitted as `spend_recorded` (outcome "Rejected:<reason>").
    /// Wrong role / unknown caller still panics (C4).
    pub fn request_spend(
        &mut self,
        vendor: AccountId,
        amount: U128,
        job: Option<U64>,
        memo: String,
    ) -> U64 {
        let by = env::predecessor_account_id();
        let aid = *self
            .agent_by_account
            .get(&by)
            .unwrap_or_else(|| env::panic_str("caller is not a registered agent"));
        let mut ag = self.agent(aid);
        require!(ag.kind == Kind::Treasurer, "wrong role: Treasurer required");
        let now = env::block_timestamp();
        let a = amount.0;
        let id = self.next_spend_id;
        self.next_spend_id += 1;
        let mut memo = memo;
        memo.truncate(MAX_MEMO_LEN);

        let mut log = self.pruned_log(aid, now);
        let spent: u128 = log.iter().map(|e| e.1).sum();
        let budget = self.budget(&ag);
        let reason: Option<&str> = if ag.state != AgentState::Active {
            Some("agent_not_active")
        } else if self.paused {
            Some("paused")
        } else if a == 0 {
            Some("zero_amount")
        } else if !self.vendors.contains(&vendor) {
            Some("vendor_not_allowlisted")
        } else if a > self.params.per_tx_cap {
            Some("per_tx_cap_exceeded")
        } else if spent + a > budget {
            Some("budget_exceeded")
        } else if log.len() >= MAX_SPEND_LOG {
            Some("budget_log_full")
        } else if a > self.treasury {
            Some("treasury_insufficient")
        } else {
            None
        };

        let mut req = SpendRequest {
            id,
            agent: aid,
            vendor: vendor.clone(),
            amount: a,
            job: job.map(|j| j.0),
            state: SpendState::Rejected,
            reason: String::new(),
            memo,
            ts_ns: now,
            logged: false,
        };
        let outcome: String;
        if let Some(r) = reason {
            req.reason = r.to_string();
            outcome = format!("Rejected:{}", r);
            // store the pruned log anyway (keeps storage small)
            self.store_log(&mut ag, log, now);
        } else {
            log.push((now, a));
            req.logged = true;
            self.store_log(&mut ag, log, now);
            if a >= self.params.approval_threshold {
                req.state = SpendState::Pending;
                outcome = "Pending".to_string();
            } else {
                outcome = "Paid".to_string();
            }
        }
        self.agents.insert(ag.token_id, ag);
        emit(
            "spend_recorded",
            json!({"request_id": id.to_string(), "agent": aid.to_string(), "vendor": vendor, "amount": a.to_string(), "outcome": outcome}),
        );
        if req.logged && req.state != SpendState::Pending {
            self.internal_pay_spend(&mut req);
        }
        self.spends.insert(id, req);
        U64(id)
    }

    pub fn approve_spend(&mut self, id: U64) {
        self.require_owner();
        let mut req = self.spend(id.0);
        require!(req.state == SpendState::Pending, "spend is not Pending");
        require!(req.amount <= self.treasury, "treasury insufficient");
        emit("spend_approved", json!({"request_id": id.0.to_string()}));
        self.internal_pay_spend(&mut req);
        self.spends.insert(req.id, req);
    }

    pub fn reject_spend(&mut self, id: U64) {
        self.require_owner();
        let mut req = self.spend(id.0);
        require!(req.state == SpendState::Pending, "spend is not Pending");
        req.state = SpendState::Rejected;
        req.reason = "dao_rejected".to_string();
        self.internal_unlog(&req);
        emit(
            "spend_recorded",
            json!({"request_id": req.id.to_string(), "agent": req.agent.to_string(), "vendor": req.vendor, "amount": req.amount.to_string(), "outcome": "Rejected:dao_rejected"}),
        );
        self.spends.insert(req.id, req);
    }

    #[private]
    pub fn on_spend_paid(&mut self, id: U64) -> bool {
        let mut req = match self.spends.get(&id.0) {
            Some(r) => r.clone(),
            None => return false,
        };
        if req.state != SpendState::Approved {
            return false; // idempotent
        }
        let ok = promise_ok();
        if ok {
            req.state = SpendState::Paid;
            emit("spend_paid", json!({"request_id": id.0.to_string()}));
        } else {
            self.treasury += req.amount;
            self.total_out -= req.amount;
            req.state = SpendState::Rejected;
            req.reason = "transfer_failed".to_string();
            self.internal_unlog(&req);
            emit(
                "spend_recorded",
                json!({"request_id": req.id.to_string(), "agent": req.agent.to_string(), "vendor": req.vendor, "amount": req.amount.to_string(), "outcome": "Rejected:transfer_failed"}),
            );
        }
        self.spends.insert(req.id, req);
        ok
    }

    // ================================================================ views

    pub fn get_charter(&self) -> CharterParamsJson {
        CharterParamsJson::from_params(&self.params)
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            token: self.token.clone(),
            guardians: self.guardians.clone(),
            paused: self.paused,
            charter_version: self.params.version,
            text_hash: hex32(&self.params.text_hash),
        }
    }

    pub fn get_guardians(&self) -> Vec<AccountId> {
        self.guardians.clone()
    }

    pub fn get_agent(&self, token_id: U64) -> Option<AgentView> {
        self.agents.get(&token_id.0).map(|a| self.agent_view(a))
    }

    pub fn get_agent_by_account(&self, account: AccountId) -> Option<AgentView> {
        self.agent_by_account
            .get(&account)
            .and_then(|id| self.agents.get(id))
            .map(|a| self.agent_view(a))
    }

    pub fn list_agents(&self) -> Vec<AgentView> {
        let mut v: Vec<AgentView> = self.agents.values().map(|a| self.agent_view(a)).collect();
        v.sort_by_key(|a| a.token_id.0);
        v
    }

    pub fn get_job(&self, id: U64) -> Option<JobView> {
        self.jobs.get(&id.0).map(|j| self.job_view(j))
    }

    /// Jobs with id >= from (default 1), up to limit (default 50, max 100), optional state filter.
    pub fn list_jobs(
        &self,
        from: Option<U64>,
        limit: Option<u32>,
        state: Option<JobState>,
    ) -> Vec<JobView> {
        let start = from.map(|f| f.0).unwrap_or(1).max(1);
        let lim = limit.unwrap_or(50).min(100) as usize;
        let mut out = Vec::new();
        let mut id = start;
        while id < self.next_job_id && out.len() < lim {
            if let Some(j) = self.jobs.get(&id) {
                if state.map(|s| s == j.state).unwrap_or(true) {
                    out.push(self.job_view(j));
                }
            }
            id += 1;
        }
        out
    }

    pub fn get_spend(&self, id: U64) -> Option<SpendView> {
        self.spends.get(&id.0).map(SpendView::from)
    }

    pub fn list_spends(&self, from: Option<U64>, limit: Option<u32>) -> Vec<SpendView> {
        let start = from.map(|f| f.0).unwrap_or(1).max(1);
        let lim = limit.unwrap_or(50).min(100) as usize;
        let mut out = Vec::new();
        let mut id = start;
        while id < self.next_spend_id && out.len() < lim {
            if let Some(s) = self.spends.get(&id) {
                out.push(SpendView::from(s));
            }
            id += 1;
        }
        out
    }

    pub fn claimable_of(&self, account: AccountId) -> U128 {
        U128(self.claimable.get(&account).copied().unwrap_or(0))
    }

    pub fn escrow_of(&self, job: U64) -> U128 {
        U128(self.escrow.get(&job.0).copied().unwrap_or(0))
    }

    pub fn is_vendor(&self, account: AccountId) -> bool {
        self.vendors.contains(&account)
    }

    /// Budget with the exact sliding_window: spent = sum of log entries with now - ts < budget_window_ns.
    pub fn budget_of(&self, token_id: U64) -> BudgetView {
        let a = self.agent(token_id.0);
        let now = env::block_timestamp();
        let log = self.pruned_log(a.token_id, now);
        let spent: u128 = log.iter().map(|e| e.1).sum();
        let b = self.budget(&a);
        BudgetView {
            token_id,
            budget: U128(b),
            win_spent: U128(spent),
            remaining: U128(b.saturating_sub(spent)),
            window_ns: U64(self.params.budget_window_ns),
            log_len: log.len() as u32,
        }
    }

    pub fn seat_pending(&self, token_id: U64) -> U128 {
        U128(self.pending_of(&self.seat(token_id.0)))
    }

    pub fn get_seat(&self, token_id: U64) -> Option<SeatView> {
        self.seats.get(&token_id.0).map(|s| self.seat_view(s))
    }

    pub fn list_seats(&self) -> Vec<SeatView> {
        let mut v: Vec<SeatView> = self.seats.values().map(|s| self.seat_view(s)).collect();
        v.sort_by_key(|s| s.token_id.0);
        v
    }

    pub fn get_stats(&self) -> StatsView {
        StatsView {
            treasury: U128(self.treasury),
            escrow_total: U128(self.total_escrow),
            claimable_total: U128(self.total_claimable),
            pools_total: U128(0),
            seat_pool: U128(self.seat_pool),
            seat_accumulator: U128(self.acc),
            total_seat_weight: U64(self.total_seat_weight),
            total_in: U128(self.total_in),
            total_out: U128(self.total_out),
            solvent: self.is_solvent(),
            jobs_total: U64(self.next_job_id - 1),
            jobs_settled: U64(self.jobs_settled),
            spends_total: U64(self.next_spend_id - 1),
            agents_total: self.agents.len(),
            seats_total: self.seats.len(),
            paused: self.paused,
            charter_version: self.params.version,
        }
    }

    /// A past (or the current) charter version: text, hash and params as they were.
    pub fn get_charter_version(&self, version: u32) -> Option<CharterParamsJson> {
        if version == self.params.version {
            return Some(CharterParamsJson::from_params(&self.params));
        }
        self.charter_history
            .get(&version)
            .map(CharterParamsJson::from_params)
    }
}

// ==================================================================== internals

pub(crate) fn promise_ok() -> bool {
    env::promise_results_count() == 1 && env::promise_result_checked(0, 4096).is_ok()
}

fn refund(to: &AccountId, amount: u128) {
    if amount > 0 {
        let _ = Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount));
    }
}

impl Contract {
    pub(crate) fn require_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner (DAO) can call this"
        );
    }

    fn validate_params(p: &CharterParams) {
        require!(
            p.text.len() <= MAX_TEXT_BYTES,
            "charter text exceeds 8192 bytes"
        );
        require!(
            env::sha256_array(p.text.as_bytes()) == p.text_hash,
            "text_hash must equal sha256(text)"
        );
        require!(p.split.sum() == 10_000, "split must sum to 10000 bps");
        require!(
            p.min_price > 0 && p.min_price <= p.max_price,
            "require 0 < min_price <= max_price"
        );
        require!(p.max_price <= MAX_PRICE_CAP, "max_price too large");
        require!(
            p.max_bid_bps > 0 && p.max_bid_bps <= 10_000,
            "max_bid_bps must be in 1..=10000"
        );
        require!(
            p.bid_window_ns > 0
                && p.submit_window_ns > 0
                && p.review_window_ns > 0
                && p.budget_window_ns > 0,
            "windows must be positive"
        );
        require!(
            p.base_budget <= p.max_budget,
            "base_budget must be <= max_budget"
        );
        require!(p.per_tx_cap > 0, "per_tx_cap must be positive");
    }

    fn sub_account(name: &str) -> AccountId {
        require!(
            !name.is_empty() && !name.contains('.'),
            "name must be a single account label"
        );
        format!("{}.{}", name, env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("invalid agent account name"))
    }

    /// The register_agent promise chain: create_account + transfer + function-call key restricted
    /// to the role's method_names. No full-access key is ever added.
    fn create_agent_account(
        account: AccountId,
        deposit: u128,
        pubkey: PublicKey,
        kind: Kind,
    ) -> Promise {
        let allowance = Allowance::limited(NearToken::from_yoctonear(AGENT_KEY_ALLOWANCE))
            .unwrap_or_else(|| env::panic_str("allowance must be non-zero"));
        Promise::new(account)
            .create_account()
            .transfer(NearToken::from_yoctonear(deposit))
            .add_access_key_allowance(
                pubkey,
                allowance,
                env::current_account_id(),
                kind.method_names(),
            )
    }

    pub(crate) fn internal_add_agent(
        &mut self,
        kind: Kind,
        account: AccountId,
        owner_account: AccountId,
    ) -> u64 {
        let id = self.next_token_id;
        self.next_token_id += 1;
        let a = Agent {
            token_id: id,
            account: account.clone(),
            kind,
            state: AgentState::Active,
            rep: self.params.rep_start,
            delivered: 0,
            rejected: 0,
            win_start_ns: 0,
            win_spent: 0,
        };
        self.agents.insert(id, a);
        self.agent_by_account.insert(account.clone(), id);
        self.nft_owner.insert(id, owner_account.clone());
        events::nft_mint(owner_account.as_str(), id);
        emit(
            "agent_registered",
            json!({"token_id": id.to_string(), "account": account, "kind": kind.as_str(), "owner": owner_account}),
        );
        id
    }

    pub(crate) fn agent(&self, id: u64) -> Agent {
        self.agents
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown agent"))
    }

    pub(crate) fn job(&self, id: u64) -> Job {
        self.jobs
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown job"))
    }

    fn spend(&self, id: u64) -> SpendRequest {
        self.spends
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown spend request"))
    }

    pub(crate) fn seat(&self, id: u64) -> Seat {
        self.seats
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown seat"))
    }

    pub(crate) fn owner_of(&self, token_id: u64) -> AccountId {
        self.nft_owner
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown token"))
    }

    /// Role enforcement inside the contract (defence in depth, C4/C6).
    fn caller_agent(&self, kind: Kind) -> Agent {
        let by = env::predecessor_account_id();
        let id = *self
            .agent_by_account
            .get(&by)
            .unwrap_or_else(|| env::panic_str("caller is not a registered agent"));
        let a = self.agent(id);
        require!(
            a.kind == kind,
            format!("wrong role: {} required", kind.as_str())
        );
        require!(a.state == AgentState::Active, "agent is not active");
        a
    }

    pub(crate) fn budget(&self, a: &Agent) -> u128 {
        let p = &self.params;
        let b = p
            .base_budget
            .saturating_add(p.per_rep_budget.saturating_mul(a.rep as u128) / 100);
        b.min(p.max_budget)
    }

    /// sliding_window: keep only entries with now - ts < budget_window_ns.
    fn pruned_log(&self, agent: u64, now: u64) -> Vec<(u64, u128)> {
        let w = self.params.budget_window_ns;
        self.spend_log
            .get(&agent)
            .map(|l| {
                l.iter()
                    .copied()
                    .filter(|(ts, _)| now.saturating_sub(*ts) < w)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn store_log(&mut self, ag: &mut Agent, log: Vec<(u64, u128)>, _now: u64) {
        ag.win_spent = log.iter().map(|e| e.1).sum();
        ag.win_start_ns = log.first().map(|e| e.0).unwrap_or(0);
        if log.is_empty() {
            self.spend_log.remove(&ag.token_id);
        } else {
            self.spend_log.insert(ag.token_id, log);
        }
    }

    /// Remove a request's entry from the sliding_window log (DAO rejection or failed transfer).
    fn internal_unlog(&mut self, req: &SpendRequest) {
        if !req.logged {
            return;
        }
        let mut log = self.spend_log.get(&req.agent).cloned().unwrap_or_default();
        if let Some(pos) = log
            .iter()
            .position(|e| e.0 == req.ts_ns && e.1 == req.amount)
        {
            log.remove(pos);
        }
        if let Some(mut ag) = self.agents.get(&req.agent).cloned() {
            self.store_log(&mut ag, log, env::block_timestamp());
            self.agents.insert(ag.token_id, ag);
        }
    }

    fn internal_pay_spend(&mut self, req: &mut SpendRequest) {
        self.treasury -= req.amount;
        self.total_out += req.amount;
        req.state = SpendState::Approved;
        let _ = ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(ONE_YOCTO))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(
                req.vendor.clone(),
                U128(req.amount),
                Some(format!("charter spend {}", req.id)),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_spend_paid(U64(req.id)),
            );
    }

    pub(crate) fn internal_credit(&mut self, account: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let cur = self.claimable.get(account).copied().unwrap_or(0);
        self.claimable.insert(account.clone(), cur + amount);
        self.total_claimable += amount;
    }

    fn release_escrow(&mut self, job_id: u64) -> u128 {
        let e = self.escrow.remove(&job_id).unwrap_or(0);
        self.total_escrow -= e;
        e
    }

    fn internal_refund(&mut self, j: &mut Job, final_state: JobState, reason: &str) {
        let e = self.release_escrow(j.id);
        let customer = j.customer.clone();
        self.internal_credit(&customer, e);
        j.state = final_state;
        emit(
            "job_refunded",
            json!({"job_id": j.id.to_string(), "reason": reason}),
        );
    }

    pub(crate) fn score(&self, b: &Bid) -> u128 {
        let rep = self.agents.get(&b.agent).map(|a| a.rep).unwrap_or(0) as u128;
        b.price.saturating_mul(1000) / (1000 + rep)
    }

    /// Picks the best eligible bid (Active analyst, not excluded) that has an eligible reviewer.
    fn internal_assign(&mut self, j: &mut Job, excluded: &[u64]) -> bool {
        let mut cands: Vec<(u128, u64, u64)> = j
            .bids
            .iter()
            .filter(|b| !excluded.contains(&b.agent))
            .filter(|b| {
                self.agents
                    .get(&b.agent)
                    .map(|a| a.state == AgentState::Active)
                    .unwrap_or(false)
            })
            .map(|b| (self.score(b), b.ts_ns, b.agent))
            .collect();
        cands.sort();
        let mut reviewers: Vec<u64> = self
            .agents
            .values()
            .filter(|a| a.kind == Kind::Reviewer && a.state == AgentState::Active)
            .map(|a| a.token_id)
            .collect();
        reviewers.sort();
        let n = reviewers.len() as u64;
        if n == 0 {
            return false;
        }
        for (_, _, w) in cands {
            let wo = self.owner_of(w);
            let start = j.id % n;
            for k in 0..n {
                let r = reviewers[((start + k) % n) as usize];
                if self.owner_of(r) != wo {
                    let now = env::block_timestamp();
                    j.winner = Some(w);
                    j.reviewer = Some(r);
                    j.state = JobState::Awarded;
                    j.deadline_ns = now + self.params.submit_window_ns;
                    j.deliverable_hash = None;
                    j.uri = None;
                    j.attestation = None;
                    j.escalated = false;
                    emit(
                        "job_awarded",
                        json!({"job_id": j.id.to_string(), "winner": w.to_string(), "reviewer": r.to_string(), "deadline_ns": j.deadline_ns.to_string()}),
                    );
                    return true;
                }
            }
        }
        false
    }

    /// Single re-open (attempts 0 -> 1) to the next-best bid, otherwise refund.
    fn internal_reopen_or_refund(
        &mut self,
        j: &mut Job,
        failed: u64,
        final_state: JobState,
        reason: &str,
    ) {
        if j.attempts == 0 {
            j.attempts = 1;
            if self.internal_assign(j, &[failed]) {
                return;
            }
        }
        self.internal_refund(j, final_state, reason);
    }

    fn internal_resolve_review(&mut self, j: &mut Job, approve: bool, cause: &str) {
        let w = j
            .winner
            .unwrap_or_else(|| env::panic_str("job has no winner"));
        let mut wa = self.agent(w);
        if approve {
            j.state = JobState::Accepted;
            self.internal_settle(j);
            wa.delivered += 1;
            let nr = wa.rep.saturating_add(self.params.rep_gain);
            self.internal_set_rep(&mut wa, nr, "delivered");
            self.agents.insert(wa.token_id, wa);
        } else {
            wa.rejected += 1;
            let nr = wa.rep.saturating_sub(self.params.rep_loss);
            self.internal_set_rep(&mut wa, nr, "rejected");
            self.agents.insert(wa.token_id, wa);
            let _ = cause;
            self.internal_reopen_or_refund(j, w, JobState::Rejected, "rejected");
        }
    }

    /// Reputation change; auto-freeze when it falls below rep_freeze_below (C10).
    fn internal_set_rep(&mut self, a: &mut Agent, new_rep: u32, cause: &str) {
        let old = a.rep;
        if old == new_rep {
            return;
        }
        a.rep = new_rep;
        emit(
            "rep_changed",
            json!({"token_id": a.token_id.to_string(), "old": old, "new": new_rep, "cause": cause}),
        );
        if new_rep < old && new_rep < self.params.rep_freeze_below && a.state == AgentState::Active
        {
            a.state = AgentState::Frozen;
            emit(
                "agent_frozen",
                json!({"token_id": a.token_id.to_string(), "by": env::current_account_id(), "reason": "rep_below_threshold"}),
            );
        }
    }

    /// Deterministic waterfall (C1): credits sum exactly to price.
    fn internal_settle(&mut self, j: &mut Job) {
        let p = j.price;
        let e = self.release_escrow(j.id);
        require!(e == p, "escrow mismatch");
        let s = self.params.split;
        let reviewer_amt = p * s.reviewer as u128 / BPS;
        let producer_amt = p * s.producer as u128 / BPS;
        let sales_amt = p * s.sales as u128 / BPS;
        let seats_amt = p * s.seats as u128 / BPS;
        // The whole seat share goes to seat_pool; seats are entitled to at most
        // weight*delta/1e18 each (floored), so sum(credited + pending) <= seat_pool (C8);
        // rounding dust stays in seat_pool.
        let mut seats_distributed = 0u128;
        if self.total_seat_weight > 0 && seats_amt > 0 {
            let tw = self.total_seat_weight as u128;
            let delta = seats_amt * ACC_SCALE / tw;
            seats_distributed = seats_amt;
            self.acc = self
                .acc
                .checked_add(delta)
                .unwrap_or_else(|| env::panic_str("seat_accumulator overflow"));
            self.seat_pool += seats_distributed;
        }
        let treasury_amt = p - reviewer_amt - producer_amt - sales_amt - seats_distributed;
        let reviewer_owner =
            self.owner_of(j.reviewer.unwrap_or_else(|| env::panic_str("no reviewer")));
        let producer_owner = self.owner_of(j.winner.unwrap_or_else(|| env::panic_str("no winner")));
        let sales_owner =
            self.owner_of(j.sales.unwrap_or_else(|| env::panic_str("no sales agent")));
        self.internal_credit(&reviewer_owner, reviewer_amt);
        self.internal_credit(&producer_owner, producer_amt);
        self.internal_credit(&sales_owner, sales_amt);
        self.treasury += treasury_amt;
        self.jobs_settled += 1;
        j.state = JobState::Settled;
        emit(
            "job_settled",
            json!({
                "job_id": j.id.to_string(),
                "price": p.to_string(),
                "credits": {
                    "reviewer": reviewer_amt.to_string(),
                    "producer": producer_amt.to_string(),
                    "sales": sales_amt.to_string(),
                    "seats": seats_distributed.to_string(),
                    "treasury": treasury_amt.to_string(),
                }
            }),
        );
    }

    pub(crate) fn pending_of(&self, s: &Seat) -> u128 {
        (s.weight as u128)
            .checked_mul(self.acc - s.last_acc)
            .unwrap_or_else(|| env::panic_str("seat pending overflow"))
            / ACC_SCALE
    }

    /// seat_accumulator checkpoint: move a seat's pending share from seat_pool to the owner's claimable.
    pub(crate) fn internal_checkpoint(&mut self, token_id: u64) -> u128 {
        let mut s = self.seat(token_id);
        let pending = self.pending_of(&s);
        s.last_acc = self.acc;
        self.seats.insert(token_id, s);
        if pending > 0 {
            self.seat_pool -= pending;
            let o = self.owner_of(token_id);
            self.internal_credit(&o, pending);
        }
        pending
    }

    pub(crate) fn is_solvent(&self) -> bool {
        self.total_claimable + self.total_escrow + self.treasury + self.seat_pool
            == self.total_in - self.total_out
    }

    fn agent_view(&self, a: &Agent) -> AgentView {
        let now = env::block_timestamp();
        let log = self.pruned_log(a.token_id, now);
        AgentView {
            token_id: U64(a.token_id),
            account: a.account.clone(),
            kind: a.kind,
            state: a.state,
            owner: self.owner_of(a.token_id),
            rep: a.rep,
            delivered: a.delivered,
            rejected: a.rejected,
            win_start_ns: U64(log.first().map(|e| e.0).unwrap_or(0)),
            win_spent: U128(log.iter().map(|e| e.1).sum()),
            budget: U128(self.budget(a)),
            method_names: a.kind.method_names().to_string(),
        }
    }

    fn job_view(&self, j: &Job) -> JobView {
        JobView {
            id: U64(j.id),
            customer: j.customer.clone(),
            target: j.target.clone(),
            price: U128(j.price),
            state: j.state,
            created_ns: U64(j.created_ns),
            sales: j.sales.map(U64),
            bids: j
                .bids
                .iter()
                .map(|b| BidView {
                    agent: U64(b.agent),
                    price: U128(b.price),
                    ts_ns: U64(b.ts_ns),
                    score: U128(self.score(b)),
                })
                .collect(),
            winner: j.winner.map(U64),
            reviewer: j.reviewer.map(U64),
            deliverable_hash: j.deliverable_hash.as_ref().map(hex32),
            uri: j.uri.clone(),
            attestation: j.attestation.clone(),
            attempts: j.attempts,
            deadline_ns: U64(j.deadline_ns),
            escalated: j.escalated,
            escrow: U128(self.escrow.get(&j.id).copied().unwrap_or(0)),
        }
    }

    fn seat_view(&self, s: &Seat) -> SeatView {
        SeatView {
            token_id: U64(s.token_id),
            owner: self.owner_of(s.token_id),
            weight: s.weight,
            last_acc: U128(s.last_acc),
            pending: U128(self.pending_of(s)),
        }
    }
}
