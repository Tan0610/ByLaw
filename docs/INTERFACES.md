# Interfaces (frozen contracts between lanes)

Do not change silently. To change: edit this file in a commit titled `interface-change: <what>` and notify the other lanes.

## 1. Conventions
JSON, `snake_case`. `u128`/`u64` as decimal strings. Token tUSD has 6 decimals. Time in nanoseconds on-chain; REST adds `*_iso`. Hashes are `0x` + 64 hex (sha256).

## 2. Contract (Lane A → B, C)
Types and methods: `CONTRACT_SPEC.md` sections 2 and 4. Lane A publishes `contracts/bylaw/ABI.md` (each method with example call and result) by **M1**, and `contracts/bylaw/dao-proposals/*.json` (one template per owner method) by **M1**.

### 2.1 Events (NEP-297 `EVENT_JSON`)
```json
{"standard":"bylaw","version":"1.0.0","event":"job_settled",
 "data":[{"job_id":"3","price":"100000000","credits":{"reviewer":"8000000","producer":"55000000","sales":"7000000","seats":"15000000","treasury":"15000000"}}]}
```
| event | data fields |
|---|---|
| bylaw_updated | version, old_hash, new_hash |
| agent_registered | token_id, account, kind, owner |
| agent_rotated | token_id, old_account, new_account |
| agent_frozen / unfrozen / retired | token_id, by, reason? |
| job_posted | job_id, customer, target, price |
| job_opened | job_id, sales_token_id, bid_deadline_ns |
| bid_placed | job_id, agent, price |
| job_awarded | job_id, winner, reviewer, deadline_ns |
| work_submitted | job_id, deliverable_hash, uri, attestation? |
| work_reviewed | job_id, reviewer, approve, reason_hash |
| job_settled | job_id, price, credits{reviewer,producer,sales,seats,treasury} |
| job_refunded / job_expired | job_id, reason |
| review_overridden | job_id, approve |
| spend_recorded | request_id, agent, vendor, amount, outcome ("Paid"/"Pending"/"Rejected:<reason>") |
| spend_approved / spend_paid | request_id |
| pool_opened / pool_contributed / pool_paid / pool_refunded | pool_id, agent?, amount? |
| claimed | account, amount |
| seat_minted | token_id, owner, weight |
| rep_changed | token_id, old, new, cause |

## 3. Indexer REST + SSE (Lane B → C)
Base `VITE_INDEXER_URL` (default `http://localhost:8788`). Errors `{"error":{"code","message"}}`. CORS for the web origin.

| Method and path | Purpose |
|---|---|
| `GET /health` | `{near_height, indexer_lag_s, agents_alive:[...], llm_ok}` |
| `GET /config` | `{contract_id, dao_id, token_id, guardians, bylaw:{version,text_hash}}` |
| `GET /bylaw` | Current bylaw + params; `GET /bylaw/history` → list of versions with text and diffs |
| `GET /agents` / `GET /agents/:token_id` | Agent view with `budget`, `win_spent`, `rep`, `state`, `owner`, `earnings` |
| `GET /jobs?state=&customer=` / `GET /jobs/:id` | Job view with bids, winner, reviewer, deliverable |
| `GET /jobs/:id/timeline` | Ordered events |
| `GET /spends`, `GET /pools` | Procurement views including rejected attempts |
| `GET /seats`, `GET /seats/:token_id` | Seat view with pending dividends |
| `GET /claimable/:account` | Claimable balance |
| `GET /artifacts/:hash` | Report JSON by sha256 |
| `GET /attestations/:job_id` | Attestation references and verification result (T4) |
| `GET /stats` | Treasury, escrow, totals, solvency check |
| `GET /stream` (SSE) | `{type, id}` update pings |

Writes by humans (`ft_transfer_call` to post a job, `claim`, `freeze_agent`, proposals) go **directly from the web app** via wallet. DAO proposals are created through Sputnik with templates from `dao-proposals/`.

## 4. Agent report artifact (Lane B)
`GET /artifacts/:hash` returns:
```json
{"schema":"bylaw.report.v1","target":"example.testnet","facts":{"code_hash":"...","storage_usage":0,
  "balance":"0","full_access_keys":0,"function_call_keys":0,"upgradeable":true,"fetched_at_block":123},
 "summary":"...","model":"...","attestation":null}
```
`facts` is canonical JSON (sorted keys). `deliverable_hash = sha256(canonical_json(whole artifact))`. The reviewer recomputes `facts` at the same `fetched_at_block` and compares.

## 5. Agent keys and roles
Lane A defines the role → method table (`CONTRACT_SPEC.md` 4.x). Lane B agents load keys from env (`AGENT_<NAME>_ACCOUNT`, `AGENT_<NAME>_PRIVATE_KEY`). Lane C `scripts/` write the keys to a local, git-ignored file at registration time.

## 6. Environment variables (names only)
```
NEAR_NETWORK=testnet
NEAR_RPC_URL=
BYLAW_CONTRACT_ID=
DAO_ID=
TOKEN_ID=
INDEXER_URL=
DATABASE_URL=file:./indexer.db
PORT=8788
LLM_BASE_URL=https://cloud-api.near.ai/v1
LLM_API_KEY=
LLM_MODEL=
AGENT_SALES_ACCOUNT=  AGENT_SALES_PRIVATE_KEY=
AGENT_ANALYST1_ACCOUNT=  AGENT_ANALYST1_PRIVATE_KEY=
AGENT_ANALYST2_ACCOUNT=  AGENT_ANALYST2_PRIVATE_KEY=
AGENT_REVIEWER_ACCOUNT=  AGENT_REVIEWER_PRIVATE_KEY=
AGENT_TREASURER_ACCOUNT=  AGENT_TREASURER_PRIVATE_KEY=
VITE_INDEXER_URL=  VITE_CONTRACT_ID=  VITE_DAO_ID=  VITE_TOKEN_ID=  VITE_NEAR_NETWORK=testnet
```
Lane C owns `.env.example` and updates it on request.

## 7. Requests (append here instead of editing another lane's files)
- [Lane B -> A] Agent view needs `owner` (NFT owner account) in `get_agent`/`list_agents`; Lane B assumes it.
- [Lane B -> A] Seats: add view `list_seats() -> Vec<{token_id, owner, weight, last_acc}>` (CONTRACT_SPEC 4.12 has no seat listing). Lane B calls `list_seats` and falls back to [].
- [Lane B -> A] `get_stats` fields Lane B reads: treasury, escrow_total, claimable_total, pools_total, seat_pool, total_in, total_out, jobs_total, jobs_settled, agents_total, seats_total, total_seat_weight (missing fields read as 0).
- [Lane B -> A] Hash args/fields (`[u8;32]`: deliverable hash, reason_hash, text_hash): please document encoding in ABI.md. Lane B sends hex without 0x by default (switchable to byte array) and accepts hex or byte arrays in views. Ids: Lane B passes job/token ids as JSON strings (U64).
- [Lane B -> A] ByLaw history: optional view `get_bylaw_version(version)`; without it /bylaw/history only lists versions the indexer has observed.
- [Lane B -> A] Optional: `SpendRequest.ts_ns` and `memo` in `get_spend`/`list_spends`.
- [Lane C -> human] Root package.json (owner: bootstrap/human) please add: `"e2e": "npm run e2e:mock -w scripts"`, `"dev:web": "npm run dev:mock -w apps/web"`, plus Lane B's `dev:indexer`/`dev:agents`/`attack` below. TRACKS.md and README use the `-w` forms meanwhile.
- [Lane C -> B] Done: web normalizes your real REST shapes (`apps/web/src/lib/normalize.ts`, contract-tested in `apps/web/src/test/indexer-contract.test.ts`). Bid `score` is read as micro-tUSD (price*1000/(1000+rep)) and shown divided by 1e6. Please keep `deliverable{hash}`, `waterfall`, `earnings.total`, `solvency.ok`, timeline `type` stable or tell Lane C. `.env.example` additions done.
- [Lane C -> A] `contracts/bylaw/dao-proposals/` is still empty; the DAO page loads `*.json` from it (Sputnik `{proposal:{description,kind:{FunctionCall:...}}}` or `{name,method,args,deposit,gas}`) and uses built-in fallbacks until then.
- [Lane B -> C] Root package.json scripts (Lane B may not edit it): `"dev:indexer": "npm run dev -w services/indexer"`, `"dev:agents": "npm run dev -w services/agents"`, `"attack": "npm run attack -w services/agents"`. Extra REST endpoints (not in section 3): `POST /artifacts`, `POST /heartbeat` (agents only). .env.example additions: INDEXER_MODE, AGENTS_MODE, POLL_MS, WEB_ORIGIN, INDEXER_WRITE_TOKEN, TREASURER_VENDOR, DEMO_TAMPER.
- [Lane A -> B, C] Contract deviations/additions (details in contracts/bylaw/ABI.md and contracts/NOTES.md): pools not implemented (no open_pool/contribute_pool/refund_pool, Treasurer key method_names = request_spend only, no pool_* events); budget window is an exact sliding window (<=64 entries/agent); claim takes optional {token}; retire_agent takes optional reason; Job has extra fields escalated + escrow; Open jobs can be expired after bid deadline + submit_window; extra event treasury_funded; extra views get_config, get_agent_by_account, escrow_of, is_vendor, get_seat, list_seats, get_bylaw_version; get_stats uses Lane B field names. Lane B requests above (owner, list_seats, stats names, hash encoding, history, ts_ns/memo) are all done. dao-proposals/ now has 15 Sputnik templates.

## 8. Change log
- 2026-11-09 v1 initial freeze.
