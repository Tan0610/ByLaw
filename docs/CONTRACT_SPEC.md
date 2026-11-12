# Contract Specification: `bylaw`

Owner: Lane A. Frozen with `INTERFACES.md`. Changes need an `interface-change` entry and notice to the other lanes.

Rust, near-sdk 5. Amounts are `U128` strings; tUSD has 6 decimals; time in nanoseconds. **[VERIFY]** marks items to confirm in Day-0 spikes.

## 1. Accounts
| Role | Account |
|---|---|
| Contract | `bylaw.<you>.testnet` |
| Owner | the Sputnik DAO (`<name>.sputnikv2.testnet`) |
| Token | `tusd.<you>.testnet` (our mock NEP-141) |
| Guardians | accounts set by the DAO |
| Agents | sub-accounts `<name>.bylaw.<you>.testnet` |

## 2. Types
```rust
enum Kind { Sales, Analyst, Reviewer, Treasurer }
enum AgentState { Active, Frozen, Retired }

struct Agent {
  token_id: u64, account: AccountId, kind: Kind, state: AgentState,
  rep: u32,                       // starts at bylaw.rep_start
  delivered: u32, rejected: u32,
  win_start_ns: u64, win_spent: u128,   // rolling budget window
}

struct ByLawParams {
  version: u32, text: String /*<=8192 bytes*/, text_hash: [u8;32],  // sha256(text)
  min_price: u128, max_price: u128,
  bid_window_ns: u64, submit_window_ns: u64, review_window_ns: u64,
  max_bid_bps: u16,                     // bid <= price*max_bid_bps/10000
  split: Split,                         // sum == 10_000
  rep_start: u32, rep_gain: u32, rep_loss: u32, rep_expire_loss: u32, rep_freeze_below: u32,
  base_budget: u128, per_rep_budget: u128, max_budget: u128, budget_window_ns: u64,
  per_tx_cap: u128, approval_threshold: u128,
}
struct Split { reviewer: u16, producer: u16, sales: u16, treasury: u16, seats: u16 }

enum JobState { Posted, Open, Awarded, Submitted, Accepted, Rejected, Settled, Refunded, Expired }
struct Job {
  id: u64, customer: AccountId, target: String /*NEAR account id to analyse*/,
  price: u128, state: JobState, created_ns: u64,
  sales: Option<u64>, bids: Vec<Bid> /*<=16*/, winner: Option<u64>, reviewer: Option<u64>,
  deliverable_hash: Option<[u8;32]>, uri: Option<String>, attestation: Option<String>,
  attempts: u8, deadline_ns: u64,
}
struct Bid { agent: u64, price: u128, ts_ns: u64 }

struct SpendRequest { id: u64, agent: u64, vendor: AccountId, amount: u128, job: Option<u64>, state: Spend /*Pending|Approved|Rejected|Paid*/, reason: String }
struct Pool { id: u64, vendor: AccountId, target: u128, raised: u128, deadline_ns: u64, contributions: Vec<(u64,u128)>, state: PoolState }
struct Seat { token_id: u64, weight: u32, last_acc: u128 }
```
NFT collection holds two kinds of token: `Agent` and `Seat`. `nft_token.metadata.extra` records the kind.

## 3. Ledger
```
claimable: AccountId -> u128      escrow: JobId -> u128
treasury: u128                    pools: PoolId -> raised
acc: u128  (seat accumulator, scaled 1e18)   total_seat_weight: u64
```
**Solvency invariant:** `Σ claimable + Σ escrow + treasury + Σ pool.raised == total_in - total_out`, checked in tests after every operation.

## 4. Methods

### 4.1 Owner (DAO only, `predecessor == owner`)
- `new(owner, token, params)` `#[init]`
- `set_bylaw(params)` : validates `split` sum, `text_hash == sha256(text)`, `version = old+1`; emits old and new hashes.
- `register_agent(kind, name, owner_account, pubkey) -> Promise` `#[payable]`
  - Attached deposit ≥ gas funding (default 0.5 NEAR) + storage; creates `<name>.<this>`; funds it; adds a **function-call key** (`receiver = this`, `method_names = role set`, `allowance = generous`). No full-access key. Callback mints the NFT and registers the agent. **[VERIFY]** contract can add a function-call key in the same promise chain.
- `rotate_agent(token_id, new_name, pubkey)` : retires the old identity, creates a new sub-account, rebinds the NFT, carries rep.
- `retire_agent`, `unfreeze_agent`, `set_guardians(Vec<AccountId>)`
- `set_vendor(AccountId, bool)`, `approve_spend(id)`, `reject_spend(id)`
- `override_review(job, approve: bool)`
- `mint_seat(owner, weight)`, `set_seat_weight(token_id, weight)`
- `treasury_withdraw(to, amount)`, `set_paused(bool)`

### 4.2 Guardians
- `freeze_agent(token_id, reason)` : any guardian or the owner. Sets `Frozen`. Cannot unfreeze.

### 4.3 Customer (via token)
- `ft_on_transfer(sender, amount, msg)` : predecessor must equal `token`. `msg` JSON:
  - `{"action":"post_job","target":"<account id>"}` → creates `Posted` job; price = amount; must be in `[min_price, max_price]` else the whole amount is returned (`ft_on_transfer` returns `amount`).
  - `{"action":"fund_treasury"}` → `treasury += amount`.
  - Anything else returns `amount` (refund).

### 4.4 Sales agent (`Kind::Sales`)
- `accept_job(job)` : Active, `Posted` → `Open`, opens bid window.
- `award_job(job)` : after `bid_window`; picks the lowest `score = bid.price * 1000 / (1000 + rep)`, tie → earlier `ts_ns`; assigns reviewer deterministically among Active reviewers `reviewers[job.id % n]` whose **owner ≠ winner owner** (else next); sets `Awarded`, deadline `submit_window`. No bids → job refunded to customer's claimable.

### 4.5 Analyst (`Kind::Analyst`)
- `place_bid(job, price)` : `Open`, in window, `price ≤ job.price * max_bid_bps/10000`, one bid per agent, ≤ 16 bids.
- `submit_work(job, hash, uri, attestation: Option<String>)` : winner only, `Awarded`, before deadline. State `Submitted`, deadline `review_window`.

### 4.6 Reviewer (`Kind::Reviewer`)
- `review_work(job, approve: bool, reason_hash: [u8;32])` : assigned reviewer only; owner conflict re-checked.
  - Approve: `Accepted` → settle (4.9) → `Settled`; winner `rep += rep_gain`, `delivered += 1`.
  - Reject: winner `rep -= rep_loss` (saturating), `rejected += 1`; auto-freeze if `rep < rep_freeze_below`; if `attempts == 0` re-open for the next-best bid (`attempts += 1`), else refund customer.

### 4.7 Treasurer (`Kind::Treasurer`)
- `request_spend(vendor, amount, job: Option<u64>, memo) -> u64` : **never panics on policy failures**; records `SpendRequest` with `Rejected(reason)` if: agent not Active, vendor not allowlisted, `amount > per_tx_cap`, window budget exceeded, treasury insufficient. If `amount ≥ approval_threshold` → `Pending` (DAO approves). Otherwise reserves and pays: `treasury -= amount`, `ft_transfer(vendor)` with rollback callback.
- `open_pool(vendor, target, deadline)`, `contribute_pool(pool, amount)` : debits the agent's budget window and treasury share pro rata; when `raised == target` pays vendor; after `deadline` anyone calls `refund_pool(pool)`.

### 4.8 Anyone
- `expire_job(job)` : after deadline in `Awarded` (winner `rep -= rep_expire_loss`, re-open once or refund), `Submitted` with reviewer timeout (auto-escalate to DAO `override_review` queue event), `Posted` older than 24h (refund).
- `claim(token) -> Promise` : pays `claimable[caller]` via `ft_transfer`; zero before the call, restored in callback on failure.
- `checkpoint_seat(token_id)` : credits seat pending to owner's claimable.

### 4.9 Waterfall (deterministic)
```
P = job.price
reviewer = P*split.reviewer/10000   -> claimable[owner(reviewer agent)]
producer = P*split.producer/10000   -> claimable[owner(winner agent)]
sales    = P*split.sales/10000      -> claimable[owner(sales agent)]
seats    = P*split.seats/10000      -> if total_seat_weight == 0 { treasury } else { acc += seats*1e18/total_weight (remainder to treasury) }
treasury = P - reviewer - producer - sales - seats_distributed  (gets all rounding)
escrow[job] -= P
```

### 4.10 Budget
`budget(agent) = min(max_budget, base_budget + per_rep_budget * rep / 100)` per `budget_window`. The window rolls when `now - win_start ≥ budget_window`.

### 4.11 NEP-171 / 177 / 181
Standard methods. Seat transfer calls an internal checkpoint first. Agent NFT transfer changes where future earnings go; it does not move the sub-account key. Transfers blocked for `Retired`.

### 4.12 Views
`get_bylaw`, `get_agent(token_id)`, `list_agents`, `get_job(id)`, `list_jobs(from,limit,state?)`, `get_spend(id)`, `list_spends`, `get_pool(id)`, `claimable_of(account)`, `budget_of(token_id)`, `seat_pending(token_id)`, `get_stats()`, `get_guardians`.

## 5. Events (NEP-297, standard `bylaw`, `1.0.0`)
`bylaw_updated`, `agent_registered`, `agent_rotated`, `agent_frozen`, `agent_unfrozen`, `agent_retired`, `job_posted`, `job_opened`, `bid_placed`, `job_awarded`, `work_submitted`, `work_reviewed`, `job_settled`, `job_refunded`, `job_expired`, `review_overridden`, `spend_recorded` (with outcome), `spend_approved`, `spend_paid`, `pool_opened`, `pool_contributed`, `pool_paid`, `pool_refunded`, `claimed`, `seat_minted`, `rep_changed`. Fields in `INTERFACES.md`.

## 6. Invariants (tested)
- C1 Job conservation: waterfall credits sum exactly to `price`.
- C2 Global solvency (section 3) after every operation.
- C3 Spend within window budget; overspend always recorded as `Rejected`.
- C4 Role enforcement: every agent method rejects a caller of the wrong kind (independent of key scoping).
- C5 Producer owner ≠ reviewer owner for every reviewed job.
- C6 Frozen/Retired agents cannot act.
- C7 Only the owner changes bylaw, agents, vendors, seats; guardians can only freeze.
- C8 Seat dividends: `Σ claimed + Σ pending ≤ Σ seat shares`.
- C9 Job states move forward only (except the single re-open).
- C10 Reputation never underflows; auto-freeze triggers at the threshold.
- C11 `claim` never loses funds if `ft_transfer` fails.

## 7. Security requirements
State before promises; callbacks `#[private]` and idempotent; bounded collections; no `unwrap` on input; `require!` messages explicit; storage staking covered by deposits; token identity checked in `ft_on_transfer`; no full-access keys on agent accounts; owner is a contract account, so a lost key cannot seize the system.

## 8. Testing plan
1. Unit: every method and `require!`.
2. Property (`proptest`): random sequences of jobs, spends, claims preserve C1, C2, C8, C10.
3. Sandbox (`near-workspaces`): full lifecycle with mock-ft; role-key restriction test (call outside `method_names` fails at protocol level); owner = a mock DAO account.
4. Testnet smoke through `scripts/e2e`.

## 9. Deployment
Scripted and documented in `contracts/bylaw/deploy.md`. A human signs deploy and `init`. DAO bootstrap templates in `contracts/bylaw/dao-proposals/*.json` for every owner method.
