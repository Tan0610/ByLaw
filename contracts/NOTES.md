# Lane A notes (contracts)

## What was run (real results)
| Check | Result |
|---|---|
| `cargo test -p bylaw -p mock-ft` | **bylaw: 66 passed, 0 failed** (63 unit + 3 proptest properties, about 102 s); **mock-ft: 4 passed, 0 failed** |
| `cargo build --target wasm32-unknown-unknown --release -p bylaw -p mock-ft` | **OK**: `bylaw.wasm` 843,812 bytes, `mock_ft.wasm` 252,725 bytes (rustc 1.99, no wasm-opt) |
| near-workspaces suite (`contracts/integration-tests`) | written, **NOT RUN** (sandbox does not run on native Windows; no network transactions allowed) |
| Testnet deploy, spikes S3/S4 | **NOT RUN** (human-only) |
| `rust-analyzer diagnostics .` | 0 diagnostics (used while builds were blocked) |

Environment caveat: this Windows machine has an Application Control (reputation-based) policy that
intermittently blocks freshly built executables (`os error 4551`). For a while every build script
was blocked; later runs were allowed. `cargo test -p mock-ft` **alone** is still blocked (different
feature unification gives a new `getrandom` build script), so run both packages together:
`cargo test -p bylaw -p mock-ft`. A `RUSTFLAGS="-C target-cpu=mvp"` wasm build was also
blocked, so compatibility of the rustc 1.99 wasm with the NEAR VM is **unverified** (see deploy.md).

Bug found by the property tests and fixed: proptest cases shared mocked storage (`testing_env!`
carries storage over), so `H::new` now installs a fresh `MockedBlockchain`. A seat-dividend rounding
underflow was found by review and fixed before the first run (see Design decisions).

## Status per task (TASKS.md section 3)
| # | Task | Status |
|---|---|---|
| A1 | Skeleton, types, owner/guardian auth, pause, bylaw set/validate | done, tests pass |
| A2 | mock-ft NEP-141 (open capped `mint`, `storage_deposit`, `ft_transfer(_call)`, `ft_balance_of`, `ft_metadata` 6 decimals) | done, 4 tests pass |
| A3 | `register_agent` promise chain (create_account + transfer + function-call key with role `method_names`, NFT mint in callback, refund on failure), `rotate_agent`, freeze/unfreeze/retire | code + unit tests (receipt inspection of the key's `method_names`) pass |
| A4 | `ft_on_transfer`, accept/bid/award (reputation-weighted score)/submit/review (owner conflict re-check, single re-open, refund)/`expire_job`/`override_review` | done, tests pass |
| A5 | Waterfall, claimable ledger, `claim` with rollback, solvency helper | done, tests pass |
| A6 | Budgets (exact `sliding_window`), reputation, auto-freeze, `request_spend` (recorded denials), vendor allowlist, per-tx cap, approval threshold, approve/reject | done, tests pass |
| A7 | NEP-171/177/181 for agent + seat NFTs, `seat_accumulator`, `mint_seat`, `set_seat_weight`, `checkpoint_seat`, checkpoint on transfer and in `claim` | done, tests pass |
| A8 | Pools | **SKIPPED** (per brief) |
| A9 | Views, NEP-297 events per INTERFACES 2.1, `ABI.md`, `dao-proposals/*.json` (15 Sputnik templates) | done |
| A10 | near-workspaces suite | written, unrun |
| A11 | `deploy.md` | written; nothing deployed |

Tests written: `contracts/bylaw/src/tests.rs` has 63 unit tests + 3 proptest properties
(`prop_invariants_hold_under_random_operations`, `prop_waterfall_conserves_value`,
`prop_sliding_window_never_exceeds_budget`); `contracts/mock-ft` has 4 unit tests;
`contracts/integration-tests/tests/sandbox.rs` has 1 lifecycle + role-key test.

Invariant coverage: C1 (`happy_path_waterfall_c1`, `prop_waterfall_conserves_value`, C1 check inside the random-ops property), C2 (`H::assert_solvent` recomputes the identity from per-account/per-job balances after most unit tests and after **every** random op), C3 (`c3_budget_exceeded_recorded_and_sliding_window_exact`, `prop_sliding_window_never_exceeds_budget`), C4 (`role_keys_c4_*`), C5 (`c5_*`), C6 (`c6_*`), C7 (`c7_*`), C8 (`seats_*`, random-ops property), C9 (random-ops property tracks state ranks; only the single re-open goes backwards), C10 (`reject_reopens_once_then_refunds_and_c10_auto_freeze`, `c10_rep_saturates_at_zero`), C11 (`c11_claim_failure_restores_balance`, spend/withdraw rollback tests).

## Spikes
| Spike | Result |
|---|---|
| S3 (contract creates sub-account with only a function-call key) | **Not verifiable here** (no network transactions allowed, no sandbox). Verified against near-sdk 5.30.1 source: `Promise::create_account().transfer().add_access_key_allowance(pk, Allowance::limited(..), receiver, "m1,m2")` exists and maps to `promise_batch_action_add_key_allowance_with_function_call`; the unit test inspects the mocked receipt (`MockAction::AddKeyWithFunctionCall{method_names, receiver_id}`) and asserts no `AddKeyWithFullAccess`. Protocol-level rejection of a disallowed method is only covered by the unrun workspaces test. Adding a key in the same batch as `CreateAccount` is the standard pattern (actions after CreateAccount in one batch are allowed for the creator), but this was not re-checked against docs or a node here. Fallback if it fails on testnet: none needed in code; the sandbox test will show it. |
| S4 (`ft_transfer_call` with JSON msg) | Not run on testnet; implemented in mock-ft + bylaw and covered by unit tests (pass) and the workspaces test (unrun). |

## Design decisions and spec deviations
- **Pools skipped** (brief). Treasurer key `method_names` = `request_spend` only (a key cannot be widened later, so re-register/rotate treasurers if pools are added). No `pool_*` events; `pools_total` = 0.
- **sliding_window budget** (brief addition): per agent a log of ≤64 `(ts, amount)`; spend allowed iff `sum(entries with now - ts < budget_window_ns) + amount ≤ budget(agent)`; a full log (64 live entries) records `Rejected:budget_log_full`. `budget_of`/`get_agent` return `win_spent` = live sliding sum and `win_start_ns` = oldest live entry. Pending (above-threshold) spends consume budget at request time; DAO rejection or a failed transfer removes the entry.
- Spend outcomes: `Paid` (optimistic; state `Approved` until the `on_spend_paid` callback flips it to `Paid`), `Pending`, `Rejected:<reason>`; transfer failure emits a second `spend_recorded` with `Rejected:transfer_failed` and restores the treasury.
- Reviewer selection: candidates by score; if the best bid has no reviewer with a different owner, the next bid is tried; none → refund. Owner conflict is re-checked in `review_work` (panics; DAO resolves via escalation + `override_review`).
- Rejection after the re-open → state `Rejected` (refunded). Timeout refunds → `Expired`. No-bid → `Refunded`.
- Review timeout: `expire_job` sets `escalated=true` (new Job field) and emits `job_expired{reason:"review_timeout"}`; the reviewer can no longer review; DAO calls `override_review`.
- Extra expiry: an `Open` job not awarded within `bid deadline + submit_window` can be expired (refund) so funds never stick if the sales agent disappears.
- Seats: the full seat share of a settlement goes to `seat_pool` and `acc += share*1e18/total_weight`; floors leave dust in `seat_pool` (counted in solvency). This guarantees `Σ credited + Σ pending ≤ seat_pool` (C8). An earlier draft that only pooled the floored amount could underflow; fixed before handoff.
- `max_price` capped at 1e15 (1e9 tUSD) so `seats * 1e18` never overflows u128.
- `claim(token?)` also checkpoints the caller's seats first. Pull-based: a customer refund is credited to `claimable`, never pushed.
- Storage: jobs/spends are paid from the contract's NEAR balance (customers attach no NEAR via `ft_transfer_call`). Keep the contract funded; `min_price` limits spam.
- `rotate_agent`: old account is unbound in the callback (its key can still sign, but the contract rejects it as "not a registered agent"); the old key is not deleted (after creation the sub-account is a separate account; the bylaw contract cannot delete its keys).
- Lane B requests in INTERFACES §7 are implemented (owner in agent views, `list_seats` with `last_acc`, stats field names, hash encoding documented, `get_bylaw_version`, spend `ts_ns`/`memo`). Summary line appended under §7 Requests.

## Open risks
1. The near-workspaces suite is unrun: protocol-level rejection of a call outside `method_names` is unproven here (only the mocked receipt is inspected).
2. Gas constants (15 Tgas per ft_transfer and callback, 20 Tgas register callback) are untested on testnet.
3. `list_agents`/`claim` scan bounded maps (≤32 agents, ≤64 seats); fine at demo scale.

4. Wasm built with rustc 1.99 was not deployed; newer rustc may emit post-MVP wasm features the NEAR VM rejects (see `deploy.md` fallback). 843 KB is under the 4 MB limit; wasm-opt or cargo-near would shrink it.

## Track proof
| Track | Files | Command |
|---|---|---|
| security (role-scoped keys, budgets, freeze) | `contracts/bylaw/src/lib.rs` (`register_agent`, `create_agent_account`, `request_spend`, `pruned_log` sliding_window, `freeze_agent`), `method_names` in `contracts/bylaw/src/types.rs`, `contracts/integration-tests/tests/sandbox.rs` | `cargo test -p bylaw -p mock-ft role_keys`; `cargo test -p bylaw -p mock-ft c3_`; sandbox (unrun): `cd contracts/integration-tests && cargo test` |
| social (DAO owns everything) | `require_owner` in `src/lib.rs`, `contracts/bylaw/dao-proposals/*.json` | `cargo test -p bylaw -p mock-ft c7_` |
| business / agents (escrow, waterfall, claims) | `ft_on_transfer`, `award_job`, `review_work`, `internal_settle`, `claim` in `src/lib.rs` | `cargo test -p bylaw -p mock-ft happy_path`; `cargo test -p bylaw -p mock-ft prop_` |
| nfts (agent + seat NFTs, seat_accumulator) | `src/nft.rs`, `mint_seat` / `internal_checkpoint` in `src/lib.rs` | `cargo test -p bylaw -p mock-ft seats`; `cargo test -p bylaw -p mock-ft nft_` |
| swarms (reputation-weighted bidding; pools NOT implemented) | `internal_assign`, `score` in `src/lib.rs` | `cargo test -p bylaw -p mock-ft award_` |

The `cargo test` filters above were run as part of the full suite (all pass). The sandbox command was not run.
