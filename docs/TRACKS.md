# Track proof map: Charter

Why this file exists: judges (including the AI judges) check that each claimed track has a real integration in the code. A track is claimed only if its row has real paths and a command that works. Owner: Lane C, compiled from `services/NOTES.md` (Lane B) and `contracts/charter/` (Lane A).

**Status values:** `planned` → `working offline` (runs on `FakeContract` / mocks, command verified) → `contract written` (Rust code present, not deployed) → `verified on testnet`.
Last updated 2026-11-12. Nothing is deployed yet, so no row is `verified on testnet`.

| Track (id) | Tier | Claim in one line | What a judge sees | Proof paths | Command to verify | Status |
|---|---|---|---|---|---|---|
| Social Money (`social`) | T1 | A Sputnik DAO owns the charter, treasury, guardians and agent roster; members change the rules by proposal | Charter amendment via a `FunctionCall` proposal to `set_charter`, then a new version with a text diff | `contracts/charter/src/lib.rs` (`require_owner`, `set_charter`), `contracts/charter/ABI.md`, `scripts/src/bootstrap-dao.ts`, `scripts/src/lib.ts` (`proposal`), `apps/web/src/pages/DaoPage.tsx`, `apps/web/src/pages/CharterPage.tsx`, `apps/web/src/lib/dao.ts` | `npm run e2e:mock -w scripts` (step "DAO amends the charter"); `npm test -w apps/web` ("DAO flow"); `npm run bootstrap -w scripts` prints the testnet steps | working offline; contract written |
| Autonomous Business (`business`) | T1 | Sales, procurement, escrow and revenue split run by agents; humans set only constraints | Payment → job → bids → award → review → waterfall → claims | `contracts/charter/src/lib.rs` (`ft_on_transfer`, `award_job`, `review_work`, waterfall), `packages/near-client/src/rules.ts` (`computeWaterfall`), `services/agents/src/roles/sales.ts`, `roles/treasurer.ts`, `apps/web/src/pages/JobDetailPage.tsx` | `npm run e2e:mock -w scripts`; `npm test -w services/agents` | working offline; contract written |
| AI Security & Defense (`security`) | T1 | Role-scoped function-call keys, contract-enforced budgets, approval threshold, freeze switch | Overspend and non-allowlisted vendor recorded as `Rejected`; guardian freeze; frozen agent cannot spend; tampered report rejected by the reviewer | `contracts/charter/src/lib.rs` (`register_agent` → `add_access_key_allowance(... kind.method_names())`, `request_spend`, `freeze_agent`), `services/agents/src/roles/treasurer.ts` (`runTreasurerAttack`), `services/agents/src/report.ts` (`verifyReport`), `apps/web/src/pages/TreasuryPage.tsx`, `AgentsPage.tsx` | `npm run e2e:mock -w scripts` (attack and freeze steps); `npm run attack -w services/agents`; `npm test -w apps/web` ("guardian flow"). Protocol-level key scoping needs the testnet check in `docs/demo/TESTNET_RUNBOOK.md` step 6 | working offline; key scoping contract written, not yet proven on testnet |
| Agent Economy (`agents`) | T1 | Agents earn, spend and check each other's work | Agent earnings per owner; treasurer purchases; reviewer with a different owner | `services/agents/src/` (`runtime.ts` `AgentRunner`/`StepLedger`, `roles/*.ts`, `strategy.ts`), `services/indexer/src/indexer.ts` (`earningsFor`), `apps/web/src/pages/AgentsPage.tsx` | `npm run e2e:mock -w scripts`; `npm run dev -w services/agents` then `curl localhost:8788/agents` | working offline |
| NFTs That Do Something (`nfts`) | T2 | Agent NFTs and seat NFTs earn revenue; ownership decides who gets paid | Agent NFT owner claims earnings; seat holder checkpoints and claims dividends | `contracts/charter/src/nft.rs`, `contracts/charter/src/lib.rs` (`mint_seat`, `checkpoint_seat`, `claim`), `apps/web/src/pages/SeatsPage.tsx` | `npm run e2e:mock -w scripts` (claims step); `npm test -w apps/web` ("seats and claims") | working offline; contract written |

## Dropped (cannot be proven in this build)
- AI Swarms (`swarms`): bidding with reputation-weighted scoring works (`packages/near-client/src/rules.ts` `scoreBid`, `services/agents/src/strategy.ts`), but collective purchase pools (T3) are not implemented. Re-add only if pools land.
- Privacy & Private AI (`privacy`): no attested inference; `GET /attestations/:job_id` never verifies. Not claimed.

## Not claimed
`defi`, `thesis`, `memecoins`, `games`, `realworld`. Intents is not used.

## Before submission (human)
Upgrade a row to `verified on testnet` only after the matching step in `docs/demo/TESTNET_RUNBOOK.md` succeeded, and paste the explorer link here.

## README block that every lane must preserve (Lane C owns the wording)
Put this near the top of `README.md`:
```
## What is real, what is not
- Runs on NEAR testnet only. No mainnet funds.
- Real: Sputnik DAO ownership, agent sub-accounts with role-scoped function-call keys, contract-enforced budgets and revenue split, NEP-171 agent and seat NFTs.
- Verified by recomputation: the reviewer agent recomputes report facts from NEAR RPC and rejects mismatches.
- Not in this build: private-inference attestation (planned as recorded references verified in the UI; skipped).
- Honest limits: agents hold no funds (money lives in the contract ledger); agent keys cannot be rotated, so identities are re-issued; the demo business is a simple contract-health report.
- AI-generated code: see docs/AI_DISCLOSURE.md.
```

## Commit hygiene (git history is a judging signal)
- Commit early and often, one logical change per commit, clear messages.
- Never squash lane history into one commit.
- No generated blobs or secrets committed.
