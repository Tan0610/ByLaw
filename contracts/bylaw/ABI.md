# ByLaw contract ABI (Lane A → Lane B, C)

Source of truth: `contracts/bylaw/src/lib.rs`, `src/nft.rs`, `src/types.rs`.
Conventions: JSON args, `snake_case`; **all u64/u128 amounts, ids and timestamps are decimal strings** (`U64`/`U128`); small ints (`u8/u16/u32`) are JSON numbers. Hashes are `"0x" + 64 hex` (sha256; the `0x` prefix is optional on input). tUSD has 6 decimals (`"1000000"` = 1 tUSD). Times are nanoseconds.

Token ids: agents and seats share one NFT id space starting at `"1"`. Job ids and spend ids start at `"1"`.

## 0. Types (JSON)

```jsonc
// Kind:        "Sales" | "Analyst" | "Reviewer" | "Treasurer"
// AgentState:  "Active" | "Frozen" | "Retired"
// JobState:    "Posted" | "Open" | "Awarded" | "Submitted" | "Accepted" | "Rejected" | "Settled" | "Refunded" | "Expired"
//              terminal: Settled, Refunded (no bid / no award), Rejected (refunded after final rejection), Expired (refunded after timeout)
// SpendState:  "Pending" | "Approved" (transfer in flight) | "Rejected" | "Paid"

// ByLawParams (input of new/set_bylaw, output of get_bylaw). `version` is ignored on input.
{
  "version": 1,
  "text": "ByLaw v1: agents run the business within these rules.",
  "text_hash": "0x38d07802abd15ce9007eaa1b702a0fbd58029e86d5591a10c102b84df06edb90",
  "min_price": "1000000", "max_price": "1000000000",
  "bid_window_ns": "600000000000", "submit_window_ns": "3600000000000", "review_window_ns": "3600000000000",
  "max_bid_bps": 10000,
  "split": {"reviewer": 800, "producer": 5500, "sales": 700, "treasury": 1500, "seats": 1500},
  "rep_start": 100, "rep_gain": 10, "rep_loss": 30, "rep_expire_loss": 20, "rep_freeze_below": 50,
  "base_budget": "20000000", "per_rep_budget": "10000000", "max_budget": "100000000",
  "budget_window_ns": "3600000000000",
  "per_tx_cap": "25000000", "approval_threshold": "15000000"
}
```
Validation: `text` ≤ 8192 bytes; `text_hash == sha256(text)`; split sums to 10000; `0 < min_price ≤ max_price ≤ 1e15`; `1 ≤ max_bid_bps ≤ 10000`; all windows > 0; `base_budget ≤ max_budget`; `per_tx_cap > 0`.

Role → `method_names` of the agent function-call key (`receiver_id` = bylaw contract):

| Kind | method_names |
|---|---|
| Sales | `accept_job,award_job` |
| Analyst | `place_bid,submit_work` |
| Reviewer | `review_work` |
| Treasurer | `request_spend` (pools not implemented in this build) |

## 1. Init and owner (DAO only: `predecessor == owner`)

| Method | Args example | Result | Deposit |
|---|---|---|---|
| `new` (#init) | `{"owner":"bylaw-dao.sputnikv2.testnet","token":"tusd.alice.testnet","params":{...ByLawParams}}` | – | 0 |
| `set_bylaw` | `{"params":{...ByLawParams with v2 text and its hash}}` | `null`; emits `bylaw_updated` | 0 |
| `set_guardians` | `{"guardians":["g1.testnet","g2.testnet"]}` (≤16) | `null` | 0 |
| `set_paused` | `{"paused":true}` | `null` (stops new jobs and spends; claims still work) | 0 |
| `set_vendor` | `{"vendor":"data-vendor.testnet","allowed":true}` | `null` | 0 |
| `register_agent` | `{"kind":"Analyst","name":"analyst-1","owner_account":"bob.testnet","pubkey":"ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"}` | Promise → `"7"` (token id) or `null` on failure (deposit refunded) | **≥ 0.5 NEAR** (all of it funds the sub-account) |
| `rotate_agent` | `{"token_id":"7","new_name":"analyst-1b","pubkey":"ed25519:..."}` | Promise → `true`/`false` | ≥ 0.5 NEAR |
| `retire_agent` | `{"token_id":"7","reason":"replaced"}` (`reason` optional) | `null` | 0 |
| `unfreeze_agent` | `{"token_id":"7"}` | `null` | 0 |
| `approve_spend` | `{"id":"3"}` | `null` (pays vendor; `Approved` → `Paid` in callback) | 0 |
| `reject_spend` | `{"id":"3"}` | `null` | 0 |
| `override_review` | `{"job":"5","approve":true}` | `null` | 0 |
| `mint_seat` | `{"owner":"carol.testnet","weight":100}` | `"12"` (token id) | 0 |
| `set_seat_weight` | `{"token_id":"12","weight":50}` | `null` | 0 |
| `treasury_withdraw` | `{"to":"alice.testnet","amount":"5000000"}` | Promise → `true` (restored on failure) | 0 |

`register_agent` creates `<name>.<contract>`, transfers the deposit, and adds ONE function-call key: `receiver_id = <contract>`, `method_names` = role set above, allowance 10 NEAR. No full-access key. The callback mints the agent NFT to `owner_account` and emits `nft_mint` + `agent_registered`.

## 2. Guardians

| Method | Args | Result |
|---|---|---|
| `freeze_agent` | `{"token_id":"7","reason":"suspicious spend"}` | `null` (guardian or owner; Active → Frozen) |

## 3. Customer (through the token)

Post a job: on the **token** contract call `ft_transfer_call` (1 yoctoNEAR):
```json
{"receiver_id":"bylaw.alice.testnet","amount":"100000000","msg":"{\"action\":\"post_job\",\"target\":\"example.testnet\"}"}
```
Fund treasury: `msg = "{\"action\":\"fund_treasury\"}"`.
`ft_on_transfer` returns `"0"` when accepted; returns the full amount (refund) if paused, price outside `[min_price, max_price]`, invalid target, or unknown action. The job id is in the `job_posted` event.

## 4. Agents (signed by the agent sub-account's function-call key, no deposit)

| Method | Caller | Args | Result / rules |
|---|---|---|---|
| `accept_job` | Sales | `{"job":"1"}` | Posted → Open; bid deadline = now + bid_window |
| `place_bid` | Analyst | `{"job":"1","price":"80000000"}` | Open, before bid deadline, `price ≤ job.price*max_bid_bps/10000`, one bid per agent, ≤16 bids |
| `award_job` | Sales (the job's) | `{"job":"1"}` | after bid deadline; lowest `score = price*1000/(1000+rep)` (tie: earlier bid); reviewer = Active reviewers sorted by id, start at `job.id % n`, first whose NFT owner ≠ winner's NFT owner. No eligible bid → refunded |
| `submit_work` | Analyst (winner) | `{"job":"1","hash":"0x<64 hex>","uri":"https://indexer/artifacts/0x...","attestation":null}` | Awarded → Submitted; review deadline = now + review_window |
| `review_work` | Reviewer (assigned) | `{"job":"1","approve":true,"reason_hash":"0x<64 hex>"}` | approve → waterfall, Settled, winner rep += rep_gain; reject → winner rep -= rep_loss (auto-freeze below threshold), re-open once to the next-best bid, else Rejected + refund |
| `request_spend` | Treasurer | `{"vendor":"data-vendor.testnet","amount":"10000000","job":"1","memo":"rpc data"}` (`job` optional) | returns spend id `"4"`. **Never panics on policy**: records `Rejected` with reason `agent_not_active` / `paused` / `zero_amount` / `vendor_not_allowlisted` / `per_tx_cap_exceeded` / `budget_exceeded` / `budget_log_full` / `treasury_insufficient`; `amount ≥ approval_threshold` → `Pending` (DAO `approve_spend`); else paid immediately |

Wrong role, unknown caller, or a Frozen/Retired agent → panic (`"wrong role: Analyst required"`, `"caller is not a registered agent"`, `"agent is not active"`), except `request_spend` which records `Rejected:agent_not_active` for a Frozen/Retired treasurer.

Budget (`sliding_window`): `budget = min(max_budget, base_budget + per_rep_budget*rep/100)`; spend is allowed iff the sum of the agent's logged spends with `now - ts < budget_window_ns` plus the amount ≤ budget (exact sliding window, ≤64 log entries). DAO-rejected or failed transfers are removed from the log.

## 5. Anyone

| Method | Args | Result |
|---|---|---|
| `expire_job` | `{"job":"1"}` | Posted past 24h → Expired+refund; Open past bid deadline + submit_window → Expired+refund; Awarded past deadline → winner rep -= rep_expire_loss, re-open once else Expired+refund; Submitted past review deadline → `escalated=true` + `job_expired{reason:"review_timeout"}` (DAO uses `override_review`) |
| `claim` | `{}` or `{"token":"tusd.alice.testnet"}` | Promise → `true` if paid. Checkpoints caller's seats, zeroes claimable, `ft_transfer`s; restored if the transfer fails (receiver must be registered with the token) |
| `checkpoint_seat` | `{"token_id":"12"}` | `"1500000"` credited to the seat owner's claimable |
| `nft_transfer` | `{"receiver_id":"dave.testnet","token_id":"7"}` + **1 yocto** | moves agent earnings / seat dividends to the new owner (seat checkpointed first; retired agents blocked) |
| `nft_transfer_call` | `{"receiver_id":"x.testnet","token_id":"12","msg":""}` + 1 yocto | NEP-171 |

## 6. Views

| Method | Args | Result example |
|---|---|---|
| `get_bylaw` | `{}` | ByLawParams (above) |
| `get_config` | `{}` | `{"owner":"...","token":"...","guardians":[],"paused":false,"bylaw_version":1,"text_hash":"0x..."}` |
| `get_guardians` | `{}` | `["g1.testnet"]` |
| `get_agent` | `{"token_id":"7"}` | `{"token_id":"7","account":"analyst-1.bylaw.alice.testnet","kind":"Analyst","state":"Active","owner":"bob.testnet","rep":110,"delivered":1,"rejected":0,"win_start_ns":"0","win_spent":"0","budget":"31000000","method_names":"place_bid,submit_work"}` or `null` |
| `get_agent_by_account` | `{"account":"analyst-1.bylaw.alice.testnet"}` | AgentView or `null` |
| `list_agents` | `{}` | `[AgentView]` sorted by token id |
| `get_job` | `{"id":"1"}` | `{"id":"1","customer":"cust.testnet","target":"example.testnet","price":"100000000","state":"Settled","created_ns":"...","sales":"1","bids":[{"agent":"2","price":"80000000","ts_ns":"...","score":"72727272"}],"winner":"2","reviewer":"4","deliverable_hash":"0x...","uri":"...","attestation":null,"attempts":0,"deadline_ns":"...","escalated":false,"escrow":"0"}` |
| `list_jobs` | `{"from":"1","limit":50,"state":"Open"}` (all optional; limit ≤100) | `[JobView]` |
| `get_spend` | `{"id":"4"}` | `{"id":"4","agent":"5","vendor":"data-vendor.testnet","amount":"10000000","job":"1","state":"Paid","reason":"","memo":"rpc data","ts_ns":"..."}` |
| `list_spends` | `{"from":"1","limit":50}` | `[SpendView]` |
| `claimable_of` | `{"account":"bob.testnet"}` | `"55000000"` |
| `escrow_of` | `{"job":"1"}` | `"100000000"` |
| `is_vendor` | `{"account":"data-vendor.testnet"}` | `true` |
| `budget_of` | `{"token_id":"5"}` | `{"token_id":"5","budget":"30000000","win_spent":"10000000","remaining":"20000000","window_ns":"3600000000000","log_len":1}` |
| `seat_pending` | `{"token_id":"12"}` | `"1500000"` |
| `get_seat` / `list_seats` | `{"token_id":"12"}` / `{}` | `{"token_id":"12","owner":"carol.testnet","weight":100,"last_acc":"0","pending":"1500000"}` |
| `get_stats` | `{}` | `{"treasury":"...","escrow_total":"...","claimable_total":"...","pools_total":"0","seat_pool":"...","seat_accumulator":"...","total_seat_weight":"100","total_in":"...","total_out":"...","solvent":true,"jobs_total":"3","jobs_settled":"1","spends_total":"2","agents_total":5,"seats_total":1,"paused":false,"bylaw_version":1}` |
| `get_bylaw_version` | `{"version":1}` | ByLawParams of that version (current or historical) or `null` |
| `nft_token` | `{"token_id":"7"}` | `{"token_id":"7","owner_id":"bob.testnet","metadata":{"title":"ByLaw agent #7 (Analyst)","extra":"{\"kind\":\"agent\",\"role\":\"Analyst\",...}",...}}` |
| `nft_metadata`, `nft_total_supply`, `nft_tokens{from_index?,limit?}`, `nft_supply_for_owner{account_id}`, `nft_tokens_for_owner{account_id,from_index?,limit?}` | | NEP-177 / NEP-181 |

Solvency (`get_stats.solvent`): `claimable_total + escrow_total + treasury + seat_pool == total_in - total_out` (pools_total is always 0 in this build).

Hash encoding: all hash args/fields are strings, `"0x" + 64 lowercase hex`; on input the `0x` prefix is optional and upper-case hex is accepted. Byte arrays are NOT accepted.

## 7. Events (NEP-297, `EVENT_JSON:` logs, standard `bylaw`, version `1.0.0`)

Exactly the fields of `docs/INTERFACES.md` 2.1; ids and amounts are strings, `old/new` rep and seat `weight` are numbers, `approve` is a bool.
```json
{"standard":"bylaw","version":"1.0.0","event":"job_settled","data":[{"job_id":"3","price":"100000000","credits":{"reviewer":"8000000","producer":"55000000","sales":"7000000","seats":"15000000","treasury":"15000000"}}]}
{"standard":"bylaw","version":"1.0.0","event":"spend_recorded","data":[{"request_id":"4","agent":"5","vendor":"evil.testnet","amount":"10000000","outcome":"Rejected:vendor_not_allowlisted"}]}
```
Emitted: `bylaw_updated, agent_registered, agent_rotated, agent_frozen, agent_unfrozen, agent_retired, job_posted, job_opened, bid_placed, job_awarded, work_submitted, work_reviewed, job_settled, job_refunded, job_expired, review_overridden, spend_recorded, spend_approved, spend_paid, claimed, seat_minted, rep_changed`.
Notes: auto-freeze emits `agent_frozen` with `by` = the contract account and `reason` `"rep_below_threshold"`. `job_settled.credits.seats` is the amount distributed to seats (0 when no seats; then it is in `treasury`). Extra (not in INTERFACES): `treasury_funded {from, amount}`. NFT mints/transfers also emit standard `nep171` 1.2.0 `nft_mint` / `nft_transfer`.
Not emitted (pools not implemented): `pool_*`.
