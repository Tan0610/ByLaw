# Architecture

## 1. Principles
1. **The contract is the company.** ByLaw rules, budgets, escrow and payouts live in one NEAR contract. Everything else is replaceable.
2. **Agents are untrusted.** They are sub-accounts with narrow keys. LLM output is never trusted; the reviewer recomputes deterministic facts.
3. **Humans hold the brakes.** The DAO owns all rule changes; guardians can freeze instantly.
4. **Value never sits in agent accounts.** Function-call keys cannot attach deposits, so money lives in the contract ledger and is claimed by owners (pull-based).
5. **Every service is restart-safe and idempotent.**

## 2. System diagram
```
 Sputnik DAO  <name>.sputnikv2.testnet            (owner of ByLaw; council votes)
      │ FunctionCall proposals (set_bylaw, register_agent, approve_spend, ...)
      ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ bylaw.<acct>.testnet  (Rust, near-sdk 5)                           │
 │  bylaw text+params · agent registry · NEP-171 (agents, seats)      │
 │  jobs/escrow/review · waterfall · budgets · reputation · pools       │
 │  ledger: claimable, treasury, escrow  ·  events (NEP-297)            │
 └───▲───────────▲──────────────▲──────────────────────▲───────────────┘
     │ agent keys│ wallet calls │ view + events        │ ft_transfer_call
     │           │              │                      │
 ┌───┴────────┐  │      ┌───────┴───────────┐     ┌────┴──────────┐
 │ services/  │  │      │ services/indexer  │     │ mock-ft tUSD  │
 │ agents     │  │      │ REST + SSE        │     │ (NEP-141)     │
 │ sales,     │  │      │ SQLite            │     └───────────────┘
 │ analysts,  │  │      └───────▲───────────┘
 │ reviewer,  │  │              │ REST/SSE
 │ treasurer  │  │      ┌───────┴───────────┐
 └─┬──────────┘  └─────►│ apps/web          │  wallet selector (members, customers,
   │ NEAR RPC facts     │ React/Vite        │  guardians, owners)
   │ LLM (NEAR AI Cloud │                   │
   ▼  or fallback)      └───────────────────┘
```

## 3. Components and ownership
| Dir | Component | Lane |
|---|---|---|
| `contracts/bylaw/` | Main contract, DAO proposal templates | A |
| `contracts/mock-ft/` | Minimal NEP-141 "tUSD" with open faucet mint | A |
| `services/agents/` | Agent runtime, LLM client, contract-health toolkit, artifact store | B |
| `services/indexer/` | Indexer, REST, SSE | B |
| `packages/near-client/` | Typed contract client (from `ABI.md`) | B |
| `apps/web/` | Frontend | C |
| `scripts/` | DAO bootstrap, e2e run, faucet helpers | C |
| `README.md`, `docs/demo/`, `.env.example`, `docs/AI_DISCLOSURE.md` | Docs and demo | C |

## 4. Key flows

### 4.1 Governance
DAO proposes `FunctionCall` → `bylaw.set_bylaw(...)`. The contract checks `predecessor == owner (the DAO)`. Emits `bylaw_updated{old_hash,new_hash,version}`. The UI renders a text diff.

### 4.2 Agent registration (role enforcement at protocol level)
`register_agent(kind, name, owner, pubkey)` (DAO only) → promise chain: `create_account` (`<name>.<contract>`), `transfer` (gas funding), `add_access_key` (function-call key: `receiver_id = bylaw`, `method_names = role methods`, generous `allowance`). NFT minted to `owner`. The key **cannot** call methods outside its role, enforced by the NEAR protocol before our code runs; the contract checks again (defence in depth).

| Kind | Allowed methods |
|---|---|
| Sales | `accept_job`, `award_job` |
| Analyst | `place_bid`, `submit_work` |
| Reviewer | `review_work` |
| Treasurer | `request_spend`, `open_pool`, `contribute_pool` |

### 4.3 Job lifecycle
Customer `ft_transfer_call` with `post_job` msg → escrow → Sales `accept_job` (price band check) → Analysts `place_bid` during bid window → Sales `award_job` (score by price and reputation) → Analyst `submit_work(hash, uri, attestation?)` → Reviewer (not same owner) `review_work` → accept: waterfall, rep up; reject: rep down, re-open once, else refund.

### 4.4 Procurement and pools
Treasurer `request_spend(vendor, amount, job?)`: allowlisted vendor, within budget window, above threshold waits for DAO `approve_spend`. Rejections are recorded as events, not panics. Pools let agents co-fund one purchase pro rata.

### 4.5 Money
`ft_on_transfer` credits escrow or treasury. Payouts credit `claimable[account]`. `claim()` calls `ft_transfer`; on failure the credit is restored. Global solvency: `Σ(claimable) + Σ(escrow) + treasury + Σ(pools) == tokens in − tokens out`.

### 4.6 Seats and dividends
Cumulative accumulator: `acc += seats_share * 1e18 / total_weight` on each settlement. A seat's pending = `weight * (acc - last_acc) / 1e18`. Checkpoint on transfer, mint, burn.

## 5. Agent runtime (services/agents)
Five processes (or one process, five identities). Each loads its sub-account key from env.
- **Loop:** poll indexer/contract views, decide, act, record. Idempotent by `(job_id, step)`.
- **Tools:** `contractFacts(accountId)` via NEAR RPC (`view_account`, `view_access_key_list`, `view_code` hash). Deterministic JSON with sorted keys; hash = sha256.
- **LLM:** OpenAI-compatible client, base URL configurable (`https://cloud-api.near.ai/v1` for NEAR AI Cloud). Summaries only.
- **Artifacts:** report JSON stored by hash; served by indexer `GET /artifacts/:hash`.
- **Reviewer:** recomputes facts, compares canonical JSON; rejects on mismatch; optionally scores summary.
- **Attestation (T4):** record NEAR AI signature + attestation references; UI verifies via NEAR AI endpoints.

## 6. Trust model
| Element | Trusted? | Control |
|---|---|---|
| Agent actions | No | Role-scoped keys, contract checks, budgets, freeze |
| LLM text | No | Reviewer verifies facts; DAO override |
| Reviewer | Partly | Different owner than producer; reputation; override |
| Owner (DAO) | Yes, by design | Sputnik voting thresholds |
| Guardians | Limited | Freeze only |
| Indexer | No | Rebuildable from chain |
| Attestation | Recorded | Verified off-chain by UI |

## 7. Data
On-chain is the source of truth. The indexer DB (`jobs`, `agents`, `events`, `seats`, `artifacts`, `cursors`) is rebuildable (`reindex`).

## 8. Security checklist
- Owner-only methods check `predecessor == owner`. Guardian methods can only freeze.
- State changes before promises; callbacks `#[private]`, idempotent, restore on failure.
- Checked arithmetic, `u128`, bps validation (sum = 10 000).
- Bounded collections (bids ≤ 16, agents ≤ 32, seats ≤ 64, text ≤ 8 KB).
- Sub-account keys: allowance generous, no full-access key; `rotate_agent` creates a fresh identity.
- No secrets in repo; keys from env.
- Pause stops new jobs and spends, not claims.

## 9. Ops
JSON logs with `job_id`, `agent`, `tx`. `/health`: RPC height, indexer lag, agent liveness, treasury, LLM reachability.

## 10. Tech
Rust + near-sdk 5 + `near-workspaces` + `proptest`; TypeScript, Node 22, Fastify, `near-api-js`, SQLite; React + Vite + wallet selector. Exact API shapes confirmed in Day-0 spikes in `TASKS.md`.
