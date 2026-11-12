# Task split: 3 parallel lanes

UTC dates. Today is Nov 9. Submission deadline Nov 14 23:59. Target: submit by Nov 14 12:00.

## 0. Rules for all three agents
1. **Own only your directories.** Need something from another lane? Add a line under "Requests" in `INTERFACES.md` section 7 and continue with a mock.
2. Read `PRD.md`, `ARCHITECTURE.md`, `CONTRACT_SPEC.md`, `INTERFACES.md` first. Interfaces are frozen; use `interface-change:` commits.
3. One branch and worktree per lane: `lane-a-contract`, `lane-b-agents`, `lane-c-web`. Small, clear commits. Merge to `main` only at milestones, via the human.
4. **Never without explicit human confirmation:** sign or send transactions, deploy, create accounts, push, make the repo public, post on X, submit. No secrets in the repo.
5. Zero cost: testnet only.
6. Each lane appends to `docs/AI_DISCLOSURE.md` (Lane C creates it at M0).
7. If a **[VERIFY]** item fails: record it in your lane's `NOTES.md`, take the fallback, tell the human.
8. **Tiers:** build T1 completely before T2, T2 before T3, T3 before T4. A finished T1 is a full product.
9. **Commit hygiene (git history is a judging signal):** commit early and often, one logical change per commit, clear messages, never squash a lane into one commit.
10. **Track proof:** keep a "Track proof" section in your lane's `NOTES.md` (files + commands for each claimed track). Keep names greppable (e.g. `register_agent`, `method_names`, `seat_accumulator`), so reviewers and AI judges can find each integration quickly.

## 1. Bootstrap (one commit on `main`, 15 min, human or one agent)
`git init`, MIT `LICENSE`, `.gitignore` (target, node_modules, .env, *.db, keys, `secrets/`), root `Cargo.toml` workspace (`contracts/*`), root `package.json` pnpm workspaces (`services/*`, `packages/*`, `apps/*`), empty lane directories with a placeholder `README.md`, three worktrees.

## 2. Day-0 spikes (all lanes, first 2-3 hours; findings to `docs/SPIKES.md`, append-only, one section per lane)
| # | Spike | Owner |
|---|---|---|
| S1 | Testnet faucet amount; create a test Sputnik DAO (`sputnikv2.testnet`, ~6 NEAR) or use `dao.globals.primitives.testnet`; proposal bond; who may propose | C |
| S2 | A `FunctionCall` proposal that calls a toy method on a test contract; record gas and deposit needed | C (uses A's toy contract) |
| S3 | Contract creates a sub-account with **only** a function-call key (`method_names` restricted); that key calls an allowed method, and a disallowed method fails; minimum balance; gas funding | A |
| S4 | `ft_transfer_call` from a test token into the contract with a JSON `msg` | A |
| S5 | Claim NEAR Builders credits; NEAR AI Cloud inference; fetch attestation and `/v1/signature/{chat_id}`; pick a model with real TEE coverage | B |
| S6 | NEAR RPC `view_access_key_list`, `view_code`, `view_account` on a known testnet contract; free RPC rate limits | B |

## 3. Lane A: Contract (Rust)
**Owns:** `contracts/**` (including `contracts/bylaw/dao-proposals/`)

| # | Task | Tier | Done when |
|---|---|---|---|
| A1 | Skeleton, types, storage, owner/guardian auth, pause, bylaw set/validate | T1 | Unit tests for bylaw and auth |
| A2 | `contracts/mock-ft` NEP-141 with open mint and `storage_deposit` | T1 | Used by tests, deployed |
| A3 | Agent registry + `register_agent` promise chain (sub-account, function-call key, NFT), `rotate_agent`, freeze/unfreeze/retire | T1 | S3 result implemented, role-key test passes |
| A4 | `ft_on_transfer`, job posting, `accept_job`, bids, `award_job`, `submit_work`, `review_work`, `expire_job`, override | T1 | State-machine tests |
| A5 | Waterfall, ledger, `claim`, solvency check helper | T1 | C1, C2, C11 property tests |
| A6 | Budgets, reputation, auto-freeze, `request_spend`, vendors, approval flow | T1 | C3, C10 tests |
| A7 | NEP-171/177/181 (agents and seats), seat accumulator, `mint_seat`, checkpoint | T2 | C8 tests |
| A8 | Pools (`open_pool`, `contribute_pool`, `refund_pool`) | T3 | Tests |
| A9 | Views, events exactly per `INTERFACES.md`, `ABI.md`, DAO proposal templates | T1 | Matches interfaces |
| A10 | `near-workspaces` integration suite with a mock DAO owner; all invariants C1-C11 | T1+ | Green |
| A11 | Deploy guide and script (human signs) | T1 | Deployed, `get_bylaw` works |

**Milestones:** M1 (Nov 10 EOD): A1-A5 green, `ABI.md` + proposal templates published. M2 (Nov 11 EOD): A6, A9-A11, deployed. M2.5 (Nov 12 noon): A7. M3 (Nov 12 EOD): A8, security pass, support e2e.

## 4. Lane B: Agents, indexer, client
**Owns:** `services/agents/**`, `services/indexer/**`, `packages/near-client/**`

| # | Task | Tier | Done when |
|---|---|---|---|
| B1 | `packages/near-client`: typed client from `ABI.md`, plus in-memory fake with the same interface | T1 | Fake used until M2 |
| B2 | Indexer: poll views, diff, SQLite, SSE; `reindex` from chain | T1 | Rebuild from empty DB |
| B3 | REST exactly per `INTERFACES.md` section 3; `openapi.yaml` | T1 | Contract-tested |
| B4 | Contract-health toolkit: canonical `facts`, hash, artifact store, `GET /artifacts/:hash` | T1 | Deterministic on repeat |
| B5 | Agent runtime skeleton: key loading, idempotent loop, structured logs, graceful shutdown | T1 | Runs on fake |
| B6 | Sales + Analyst agents (accept, bid with strategy, award, submit with LLM summary) | T1 | Works on fake and testnet |
| B7 | Reviewer agent: recompute facts, compare canonical JSON, approve/reject | T1 | Rejects tampered report |
| B8 | Treasurer agent: vendor purchases, rejected-attempt "attack" script, pool contributions | T1/T3 | Attack scenes recorded as events |
| B9 | Attestation capture and verification endpoint | T4 | Only if S5 succeeded |
| B10 | Tests: unit, integration with fake client, REST contract tests | T1 | `pnpm test` green |

**Milestones:** M1: B1-B5 on fakes, `openapi.yaml` published. M2: B6-B8 on the deployed contract. M3: B9 if credits OK, harden retries, support e2e.

## 5. Lane C: Web, DAO ops, scripts, docs, demo
**Owns:** `apps/web/**`, `scripts/**`, `README.md`, `.env.example`, `docs/demo/**`, `docs/AI_DISCLOSURE.md`, `docs/TRACKS.md`, `docs/SPIKES.md` (structure only)

| # | Task | Tier | Done when |
|---|---|---|---|
| C1 | App shell, design system, wallet selector, MSW mock of `INTERFACES.md` REST | T1 | Runs on mocks |
| C2 | **ByLaw page:** text, parameters, version history, diff | T1 | Live |
| C3 | **DAO page:** proposals list, create from `dao-proposals/` templates, vote | T1 | Works on testnet |
| C4 | **Agents page:** role, owner, rep, budget bar, state, freeze button (guardian) | T1 | Works |
| C5 | **Customer flow:** post a job via `ft_transfer_call`, watch timeline, read report | T1 | Works |
| C6 | **Job detail:** bids, scoring, review, waterfall visual, artifact view | T1/T3 | Live via SSE |
| C7 | **Treasury page:** spends including rejected attempts, pools, approvals | T1/T3 | Works |
| C8 | **Seats and claims:** seat NFTs, pending dividends, claim | T2 | Works |
| C9 | **Attestation badge** verification UI | T4 | If B9 exists |
| C10 | `scripts/`: DAO bootstrap, register agents, mint seats, fund treasury, **e2e run** (all steps, prints links) | T1 | Green on testnet |
| C11 | README (what, problem, do-X-see-Y quickstart, architecture, trust model, AI disclosure, and the "What is real, what is not" block from `docs/TRACKS.md` near the top), demo shot list, X post draft | T1 | Judge can reproduce |
| C12 | UI smoke tests (Playwright) for customer, DAO and guardian flows | T1 | Pass |
| C13 | Compile `docs/TRACKS.md` from Lane A/B `NOTES.md` "Track proof" sections; every claimed row has real paths, a working command and status; drop tracks we cannot prove (e.g. `privacy` without attestation) | T1+ | Matches code (grep-able) |

**Milestones:** M0: `AI_DISCLOSURE.md`, `.env.example`, S1/S2 findings. M1: C1-C2, C3 on mocks. M2: C4-C7 and real integration. M2.5: C8. M3: C10 e2e green, C9 if applicable. M4 (Nov 13): C11-C12 done, human records demo.

## 6. Dependency map (every wait has a fallback)
```
A ABI.md + dao-proposals/ ──► B1, C3, C5          (M1)   fallback: code to CONTRACT_SPEC.md
B openapi.yaml            ──► C1..C9              (M1)   fallback: MSW mocks from INTERFACES.md
A deploy (M2)             ──► B6-B8, C10          (M2)   fallback: B's fake client, C's mocks
A mock-ft                 ──► B, C                (M1)
S5 result                 ──► B9, C9              (M3)   fallback: skip T4
```

## 7. Integration and release
| When | What |
|---|---|
| Nov 11 EOD | Human merges all lanes to `main`, deploys, fills `.env` |
| Nov 12 | First full testnet run via `scripts/e2e`; each lane fixes its own bugs only |
| Nov 13 | Feature freeze; hardening; README; human records demo |
| Nov 14 by 12:00 | Human: repo public, X post, submit with explicit confirmation |

## 8. Human-only actions
1. Create testnet accounts (owner, contract, token, DAO council, guardians, a few members and a customer) and fund via faucet.
2. Create the Sputnik DAO (pays the ~6 NEAR deposit) and sign proposals.
3. Create the mainnet implicit payout account; keep the address private.
4. Claim NEAR Builders credits and generate the NEAR AI key.
5. Sign deploy and `init`; sign any transaction.
6. Make the repo public; publish the X post; submit.

## 9. Definition of done
- `scripts/e2e` completes on testnet and prints verifiable links for every step, including the blocked overspend, a freeze, and a bylaw amendment through the DAO.
- Invariants C1-C11 have passing tests.
- README lets a stranger reproduce; limits and trust model honest, in a "What is real, what is not" block; AI use disclosed.
- `docs/TRACKS.md` lists only tracks we can prove, each with real paths and a working command.
- LICENSE present; no secrets in history; repo public.
