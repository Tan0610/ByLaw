# ByLaw

**ByLaw makes a company's constitution executable.** Members write a bylaw, AI agents run the business inside it, and a NEAR contract enforces it: budgets, roles, escrow and the revenue split. Humans only set the constraints.

Built at NEAR HACKATHON (November 2026). Testnet only.

## What is real, what is not
- Runs on NEAR testnet only. No mainnet funds.
- Real: Sputnik DAO ownership, agent sub-accounts with role-scoped function-call keys, contract-enforced budgets and revenue split, NEP-171 agent and seat NFTs.
- Verified by recomputation: the reviewer agent recomputes report facts from NEAR RPC and rejects mismatches.
- Not in this build: private-inference attestation (planned as recorded references verified in the UI; skipped).
- Honest limits: agents hold no funds (money lives in the contract ledger); agent keys cannot be rotated, so identities are re-issued; the demo business is a simple contract-health report.
- AI-generated code: see docs/AI_DISCLOSURE.md.

Status at the time of writing (2026-11-12), so you know exactly what you can check yourself:
- **It is deployed and has run on NEAR testnet.** The contract is `tan-bylaw-app.testnet`, owned by the Sputnik DAO `bylaw-dao.sputnikv2.testnet`; the token is `tan-bylaw-tusd.testnet`. Two real jobs ran end to end with the five agents, the seat dividends were claimed, the security attacks were denied on-chain and a guardian freeze was exercised. Every claim has a verified transaction link in **[`docs/TESTNET_EVIDENCE.md`](docs/TESTNET_EVIDENCE.md)**, including its honest limits (two-account council, template summaries instead of an LLM).
- The contract passes 70 unit and property tests, and the wasm in CI is built with `cargo-near`; the on-chain code hash equals the CI artifact.
- The whole story also runs offline with no network: the in-memory `FakeContract` (`packages/near-client`) with the real indexer and agent loops, and the web app on mock data.
- The web app's pages have been viewed in Chrome against the live deployment (phone and desktop widths). Sending transactions from the UI with a real wallet has **not** been tested yet; the on-chain actions in the evidence file were sent with the CLI and the agents' keys.
- Attestation (T4) and collective purchase pools (T3) are **not** in this build. The UI shows no attestation badge.

## Problem
Teams want agents that earn and spend, but giving an agent a wallet is all-or-nothing. DAOs can hold money and vote, but they cannot run day-to-day work. Nothing ties the two together: who may spend what, who checks whose work, who gets paid, and how trust is earned over time.

## Solution
- A **Sputnik DAO** owns the ByLaw contract and amends the bylaw by proposal.
- Each agent is a **NEAR sub-account** with a function-call key limited to the ByLaw contract **and to the methods of its role**. The NEAR protocol rejects anything else before our code runs.
- Each agent is an **NFT**; its owner receives the agent's earnings.
- **Earned budgets:** spending limits rise with delivered work and fall after rejected work.
- **Separation of duties:** a reviewer with a different owner recomputes the facts of every deliverable. Guardians can freeze any agent instantly; only the DAO can unfreeze.
- **Programmable revenue:** each accepted job pays producer, reviewer, sales, treasury and seat holders by the bylaw split, conserved to the unit.

## Quickstart: do X, see Y

Requirements: Node 24 or newer (the services run TypeScript natively; developed on Node 26), npm. Commands are shown in bash syntax. Run `npm install` once at the repo root.

### 1. The whole story in one command (no network, ~2 s)
```
npm run e2e:mock -w scripts
```
You see a numbered transcript: a customer pays 100 tUSD, sales accepts, two analysts bid, the job is awarded, the report is submitted and reviewed, the waterfall splits 55 / 15 / 15 / 8 / 7 tUSD, the winner's budget rises, an owner and a seat holder claim, the treasurer buys data, then the attacks (spend above the per-tx cap, window overspend, non-allowlisted vendor) come back **Rejected and logged**, a guardian freezes the treasurer, the DAO amends the bylaw (with a text diff) and the solvency invariant still holds. It ends with `All checks passed.` and exit code 0.

This drives the real packages: `@bylaw/near-client` (`FakeContract`), `@bylaw/indexer` (REST queried in-process) and `@bylaw/agents` (`SalesAgent`, `AnalystAgent`, `ReviewerAgent`, `TreasurerAgent`).

### 2. The web app on mock data (no backend)
```
npm run dev:mock -w apps/web
```
Open http://localhost:5173. A yellow banner says "Mock mode". Pick an identity in the top-right selector:
- **Customer** → Jobs → "Pay and post job": a new job appears and moves Posted → Open → Awarded → Submitted → Settled live; open it to see bids with scores, the reviewer decision, the waterfall and the report.
- **Ana (council and guardian)** → DAO → approve proposal #5: at 2 of 3 votes it executes and spend #3 becomes Paid on the Treasury page. Create a bylaw amendment from a template; after two approvals the ByLaw page shows version 3 with a diff.
- **Guardian** → Agents → "Freeze agent": the agent turns Frozen. As Customer the button is disabled.
- **Ana** → Seats → "Credit to balance", then "Claim tUSD".

### 3. The web app against the live offline stack (Lane B)
```
WEB_ORIGIN=http://localhost:5173 npm run dev -w services/agents    # FakeContract + indexer on :8788 + 5 agents
npm run dev -w apps/web                                             # VITE_INDEXER_URL defaults to http://localhost:8788
```
Pages now read the real indexer and update over SSE as the agents work. Wallet writes in this mode go to testnet, not to the in-memory contract.

**Wallets:** "Connect wallet" offers **Meteor Wallet** (signs in a popup; use a testnet account) and **MyNearWallet** (redirects). The wallet libraries need Node's `Buffer` and `process`, which browsers lack, so `apps/web/vite.config.ts` aliases `buffer` to the npm package and `src/main.tsx` provides both globals. Opening the picker and listing both wallets is checked in Chrome (dev and production build); a full sign-in and a transaction from the UI have not been tested yet.

### 4. Tests
```
npm test -w apps/web          # 15 tests: customer, DAO, guardian, seats flows on mocks + a contract test against the real indexer
npm test -w scripts           # e2e --mock as a test, key generation, proposal encoding
npm run build -w apps/web
```
Lane A and B: `cargo test -p bylaw`, `npm test -w packages/near-client`, `npm test -w services/indexer`, `npm test -w services/agents`.

If `vite`/`vitest` fail on Windows with `ERR_DLOPEN_FAILED ... rollup.win32-x64-msvc.node` (Windows Application Control blocking a native binary), run `npm run fix-rollup -w scripts`, which swaps in the WebAssembly build of rollup.

### 5. Testnet (human-run)
Every transaction is signed by a human. The helpers only print commands:
```
npm run bootstrap -w scripts         # create the Sputnik DAO, set guardians and vendors (prints near-cli-rs commands + proposal JSON)
npm run register-agents -w scripts   # generates agent keys locally into secrets/ (git-ignored), prints register_agent proposals
npm run mint-seats -w scripts        # seat NFT proposal
npm run fund-treasury -w scripts     # mint test tUSD and fund the treasury; customer job command
npm run e2e -w scripts -- --check    # read-only check of the deployed contract (needs BYLAW_CONTRACT_ID)
```
Full steps: [docs/demo/TESTNET_RUNBOOK.md](docs/demo/TESTNET_RUNBOOK.md). Passing `--execute` is refused on purpose.

## Architecture
```
 Sputnik DAO  <name>.sputnikv2.testnet            (owner of ByLaw; council votes)
      │ FunctionCall proposals (set_bylaw, register_agent, approve_spend, ...)
      ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ bylaw.<acct>.testnet  (Rust, near-sdk 5)                           │
 │  bylaw text+params · agent registry · NEP-171 (agents, seats)      │
 │  jobs/escrow/review · waterfall · budgets · reputation               │
 │  ledger: claimable, treasury, escrow  ·  events (NEP-297)            │
 └───▲───────────▲──────────────▲──────────────────────▲───────────────┘
     │ agent keys│ wallet calls │ view + events        │ ft_transfer_call
 ┌───┴────────┐  │      ┌───────┴───────────┐     ┌────┴──────────┐
 │ services/  │  │      │ services/indexer  │     │ mock-ft tUSD  │
 │ agents     │  │      │ REST + SSE        │     │ (NEP-141)     │
 └─┬──────────┘  │      └───────▲───────────┘     └───────────────┘
   │ NEAR RPC    │              │ REST/SSE
   │ facts, LLM  └─────►┌───────┴───────────┐  wallet selector (members, customers,
   ▼                    │ apps/web          │  guardians, owners)
                        └───────────────────┘
```
| Path | What |
|---|---|
| `contracts/bylaw/` | The contract: bylaw, agents (sub-account + scoped key + NFT), jobs, escrow, review, waterfall, budgets, spends, seats. `ABI.md` documents every method |
| `contracts/mock-ft/` | Test token tUSD (6 decimals, open faucet) |
| `packages/near-client/` | Typed contract client and `FakeContract` (in-memory implementation of the rules) |
| `services/indexer/` | Poll-and-diff indexer, SQLite, REST + SSE (`openapi.yaml`) |
| `services/agents/` | Sales, two Analysts, Reviewer, Treasurer; contract-health facts from NEAR RPC; attack script |
| `apps/web/` | React + Vite UI: ByLaw, DAO, Agents, Jobs, Job detail, Treasury, Seats |
| `scripts/` | DAO bootstrap, agent registration, seats, treasury funding, `e2e` |

Design docs: [PRD](docs/PRD.md), [architecture](docs/ARCHITECTURE.md), [contract spec](docs/CONTRACT_SPEC.md), [interfaces](docs/INTERFACES.md).

## Trust model
| Element | Trusted? | Control |
|---|---|---|
| Agent actions | No | Role-scoped keys, contract checks, budgets, freeze |
| LLM text | No | Reviewer recomputes the deterministic facts; DAO override |
| Reviewer | Partly | Different owner than the producer; reputation; DAO override |
| Owner (DAO) | Yes, by design | Sputnik voting thresholds |
| Guardians | Limited | Freeze only |
| Indexer and web app | No | Rebuildable from chain; writes go from the wallet straight to the contract |

Money never sits in agent accounts: function-call keys cannot attach deposits, so funds live in the contract ledger and owners pull them with `claim`.

## Honest limits
- Not deployed yet; the testnet path is a runbook, and `scripts/e2e --check` only reads.
- The indexer derives the timeline by diffing views, not from event logs, so very short intermediate states can be missed (see `services/NOTES.md`).
- The mock web backend (MSW) and `FakeContract` are simulations; they follow the spec but are not the contract.
- In the web app, DAO proposals and votes go to Sputnik directly; the UI does not decode every proposal kind.
- The NEAR RPC node used for facts is non-archival, so a review must happen within about two days of submission.
- Pools (T3) and attestation (T4) are not implemented.

## AI disclosure
Most code and docs were written with AI assistance (Claude Code) and reviewed by humans. Details per lane: [docs/AI_DISCLOSURE.md](docs/AI_DISCLOSURE.md).

## Tracks
Only tracks with proof in the repo are claimed; details and commands in [docs/TRACKS.md](docs/TRACKS.md).

| Track | Proof |
|---|---|
| Social Money (`social`) | `contracts/bylaw/src/lib.rs` (owner = DAO), `scripts/src/bootstrap-dao.ts`, `apps/web/src/pages/DaoPage.tsx`, `ByLawPage.tsx` |
| Autonomous Business (`business`) | `contracts/bylaw/src/lib.rs` (jobs, waterfall), `services/agents/src/roles/`, `npm run e2e:mock -w scripts` |
| AI Security & Defense (`security`) | role keys in `register_agent`, budgets and `request_spend`, `freeze_agent`; `services/agents/src/roles/treasurer.ts` (`runTreasurerAttack`) |
| Agent Economy (`agents`) | `services/agents/`, agent earnings in `GET /agents` |
| NFTs That Do Something (`nfts`) | `contracts/bylaw/src/nft.rs`, seats and claims in `apps/web/src/pages/SeatsPage.tsx` |

## License
MIT, see [LICENSE](LICENSE).
