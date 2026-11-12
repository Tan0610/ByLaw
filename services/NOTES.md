# Lane B notes: near-client, indexer, agents

Status as of 2026-11-12. Stack: TypeScript run directly by Node 26 (native type stripping, no build step), npm workspaces, `node:test`, Fastify 5, `node:sqlite` (built in, nothing native to compile on Windows), `near-api-js` 7 (signing only, loaded lazily).

## Task status (TASKS.md section 4)
| # | Task | Status |
|---|---|---|
| B1 | `packages/near-client`: `ContractClient` interface, `NearContractClient` (real), `FakeContract` (in-memory rules), shared `canonicalJson`/`artifactHash`/`scoreBid`/`computeWaterfall`/`budgetFor` | Done on fake. Real client written to CONTRACT_SPEC 4.12; **not run against a contract** (none deployed; `contracts/charter/ABI.md` did not exist yet, `src/lib.rs` is empty) |
| B2 | Indexer: poll-and-diff of views, SQLite, SSE, `reindex` | Done; tested |
| B3 | REST per INTERFACES.md section 3 + `services/indexer/openapi.yaml` | Done; every endpoint has a contract test |
| B4 | Contract-health toolkit: `contractFacts`, `charter.report.v1`, `deliverable_hash`, artifact store, `GET /artifacts/:hash` | Done; RPC path verified read-only on testnet (S6) |
| B5 | Agent runtime: env keys, `StepLedger` idempotency keyed `job_id:step`, JSON logs, graceful shutdown | Done; shutdown handler not observed on Windows (see below) |
| B6 | Sales + Analyst (accept, `bidPrice` strategy, award, submit with LLM or template summary) | Done on fake |
| B7 | Reviewer recomputes facts at the same block, rejects mismatches | Done; tamper path tested end to end |
| B8 | Treasurer purchases + `attack` script (overspend, budget overspend, non-allowlisted vendor) | Done on fake. Pools (T3) skipped by scope |
| B9 | Attestation | Skipped (out of scope). `GET /attestations/:job_id` returns the stored reference with `verified:false` |
| B10 | Tests | 44 tests green (16 + 18 + 10) |

## How to run
```
npm install                                   # at repo root
npm test -w packages/near-client              # 16 tests: canonical JSON/hash, scoring, waterfall, budgets, FakeContract rules
npm test -w services/indexer                  # 18 tests: REST contract tests for every endpoint, SSE, reindex, openapi coverage
npm test -w services/agents                   # 10 tests: reviewer tamper detection, LLM fallback, strategy, ledger, attack, 2 e2e
npm run dev -w services/agents                # AGENTS_MODE=fake (default): FakeContract + indexer on :8788 + 5 agents, demo customer posts jobs
INDEXER_MODE=fake npm run dev -w services/indexer   # indexer alone over a seeded FakeContract
INDEXER_MODE=near CHARTER_CONTRACT_ID=... npm run dev -w services/indexer
npm run reindex -w services/indexer           # wipe chain-derived tables and rebuild (artifacts kept)
npm run attack -w services/agents             # fake mode; near mode needs AGENTS_MODE=near ATTACK_CONFIRM=yes + treasurer keys
npx tsc -p <pkg> --noEmit                     # typecheck, clean for all three packages
```
Root scripts `dev:indexer` / `dev:agents` were requested from Lane C (INTERFACES.md section 7); Lane B cannot edit the root `package.json`.

Useful env: `DEMO_TAMPER=analyst1` (forged report, reviewer rejects), `DEMO_BID_WINDOW_S`, `DEMO_JOB_EVERY_S`, `AGENT_TICK_MS`, `FACTS_SOURCE=rpc|canned`, `LLM_API_KEY` (empty = template summarizer `template-v1`), `INDEXER_WRITE_TOKEN`, `WEB_ORIGIN`, `POLL_MS`, `TREASURER_VENDOR`, `AGENT_LEDGER_DIR`.

## Spikes
- **S5 (NEAR AI credits / attestation):** not in scope, not attempted. The LLM client is OpenAI-compatible (`LLM_BASE_URL`, default `https://cloud-api.near.ai/v1`) but was **never called with a real key**; only the fallback path (unreachable endpoint -> template) is tested.
- **S6 (RPC facts): verified 2026-11-12, read-only.** `contractFacts` against `https://rpc.testnet.near.org` for `wrap.testnet` and `guest-book.testnet` returned facts (e.g. wrap.testnet block 277257495: 5 full-access keys, code_hash `DsbyUrKa...`), and recomputing at the pinned `fetched_at_block` gave byte-identical canonical JSON. Latency was 14-16 s for 4 calls (slow; may be rate limiting). Not part of the test suite. Risk: non-archival RPC nodes drop old blocks (about 2.5 days), so a reviewer must review soon after submission or point at an archival RPC.

## Track proof (Lane B parts)
| Track | Files | Command |
|---|---|---|
| business | `services/agents/src/roles/sales.ts`, `roles/treasurer.ts`, `packages/near-client/src/rules.ts` (`computeWaterfall`) | `npm test -w services/agents` (e2e: post -> settle -> purchase -> claims) |
| security | `services/agents/src/roles/treasurer.ts` (`runTreasurerAttack`), `services/agents/src/report.ts` (`verifyReport`), `services/agents/src/attack.ts` | `npm run attack -w services/agents`; tamper e2e in `services/agents/test/e2e.test.ts` |
| agents | `services/agents/src/roles/*.ts`, `services/agents/src/runtime.ts` (`StepLedger`, `AgentRunner`) | `npm run dev -w services/agents` then `curl localhost:8788/jobs` |
| swarms (bids only) | `services/agents/src/strategy.ts` (`bidPrice`), `packages/near-client/src/rules.ts` (`scoreBid`, `pickWinner`), bid scores in `GET /jobs/:id` | `npm test -w packages/near-client` |
| nfts (indexer side) | `GET /seats` with `pending`, agent `earnings` in `GET /agents` | `npm test -w services/indexer` |

## Deviations from the interfaces (also listed in INTERFACES.md section 7)
- Extra endpoints: `POST /artifacts` (agents publish reports; server recomputes the hash) and `POST /heartbeat` (feeds `agents_alive`, `llm_ok`). Optional `INDEXER_WRITE_TOKEN` guards both.
- `Agent.owner`, a `list_seats` view, `get_stats` fields and `seat_pool` are assumed; real client tolerates missing ones.
- Timeline events are **derived by diffing views**, not read from NEP-297 logs. Consequences: an intermediate state that starts and ends between two polls is invisible (except bids/award/submit, which are reconstructed from job fields); a rejection is recorded as `work_reviewed{approve:false, inferred:true}`; `job_settled.credits` are computed from the current charter split; bid `score` uses the agent's rep at first sight, so it can differ after a `reindex`.
- `/charter/history` only contains versions the indexer observed (no history view in the contract spec).
- `/pools` always returns `[]`; `/attestations/:job_id` never verifies.
- `upgradeable` fact is defined as `full_access_keys > 0`. `code_hash` is taken from `view_account.code_hash` (same hash `view_code` would give), saving one RPC call.

## What could not run / open risks
- No deployed contract and no `ABI.md`: `NearContractClient` method/arg names (`job`, `token_id`, `id`, hash encoding) are guesses from the spec. Expect a reconciliation pass when Lane A publishes ABI.md.
- `postJob` on the real client finds the new job id by listing jobs after `ft_transfer_call`; racy if the same customer posts the same target concurrently.
- No transactions were sent; agents in `AGENTS_MODE=near` were never run.
- Graceful shutdown: handlers for SIGINT/SIGTERM exist, but under `timeout` on Windows the process was killed without the shutdown log line, so the path is unverified on Windows.
- FakeContract simplifications: no NEP-171 transfers except `transferSeat`, no gas/storage, `ft_transfer` never fails (C11 rollback not simulated), pools absent, a `Pending` spend does not reserve budget until approved.
