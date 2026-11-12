# Testnet evidence (live run, 2026-11-12)

Everything below ran on **NEAR testnet** and can be re-checked on-chain. Every transaction hash in this file was queried against the chain (`tx` RPC, final, success) before it was written here. Explorer: `https://testnet.nearblocks.io/txns/<hash>`.

## Deployment
| What | Account | Evidence |
|---|---|---|
| Test token (NEP-141, 6 decimals) | `tan-bylaw-tusd.testnet` | [deploy + init](https://testnet.nearblocks.io/txns/8sfQAtRcsZ6v4wrrjj55U9U9Zx44iumkQ7NNLPYowddp) |
| Sputnik DAO (council: `tan-bylaw` + `tan-bylaw-ops`, both must vote) | `bylaw-dao.sputnikv2.testnet` | [creation](https://testnet.nearblocks.io/txns/C4AkCoXp2udx5NbvbxYvfpGf48MDKNX1bBxuacz5Z7kF) |
| ByLaw contract, **owner = the DAO** | `tan-bylaw-app.testnet` | [deploy + init](https://testnet.nearblocks.io/txns/9NgWzB7jK1kSx3jV72fvAuLcFw9TWmBWB3PT6RzoTizR) |

The deployed code is exactly what CI built: the on-chain code hash of each contract equals the base58 SHA-256 of the `wasm` artifact from the GitHub Actions run (ByLaw `KZxYhoYEKB6iDP5ago95WYjzogNKP3B4zQhV2yC4BMz`, token `2mXYA9Sk89m8NU8rDXBDeniNMWbgd6JadAMzZGMDt7MH`).

## Governance through the DAO (proposals #0 to #10)
Every rule change below was a Sputnik proposal approved by **both** council members, then executed by the DAO against the contract:
| # | Proposal | Result |
|---|---|---|
| 0 | `set_guardians` -> `tan-bylaw-ops` ([vote 1](https://testnet.nearblocks.io/txns/AUVbYLZiUsGAdWeGhG75wJWSkToF2E7dwVjG4mmK2rgX), [vote 2, executes](https://testnet.nearblocks.io/txns/EArogT1mRQNL4Kdz6x2etHo19NbnXHCBb9Rit2SeX9Ts)) | Approved |
| 1-5 | `register_agent` x5 (sales, analyst1, analyst2, reviewer, treasurer) | Approved; 5 agents Active |
| 6 | `set_vendor` -> `tan-bylaw-vendor` | Approved |
| 7 | **Amend the bylaw to v2** (bid window 600 s -> 60 s; new text and hash) | Approved; contract `bylaw_version` is now 2 |
| 8 | `unfreeze_agent` (analyst2, after the guardian freeze below) | Approved |
| 9-10 | `mint_seat` x2 (weights 100 and 50) | Approved; seat NFTs #6 and #7 |

Browse them: `near view bylaw-dao.sputnikv2.testnet get_proposal '{"id":7}'` (or any id 0-10).

## Role-scoped keys are enforced by the NEAR protocol
`analyst1.tan-bylaw-app.testnet` holds exactly **one** key: a function-call key limited to `tan-bylaw-app.testnet` and the methods `place_bid` and `submit_work` (no full-access key). With that key:
- calling `accept_job` (a Sales method) was **refused by NEAR before the contract ran**: `Access key does not allow method accept_job`;
- calling `place_bid` (its own role) reached the contract, which then rejected the made-up job (`unknown job`).

## Two real jobs, end to end (no human in the loop after posting)
| | Job 1 | Job 2 |
|---|---|---|
| Customer paid | 100 tUSD ([tx](https://testnet.nearblocks.io/txns/JnxXixurzuTzLE3zZSiHNMXwnQQFm2uroevYrBBckVU)) | 100 tUSD ([tx](https://testnet.nearblocks.io/txns/488qgcb8g22vUj2ptTj5wePhCotBWgPLKtzCboohxRYb)) |
| Subject | `wrap.testnet` | `tan-bylaw-app.testnet` (the contract audits itself) |
| Bids | analyst1 55, analyst2 65 -> analyst1 wins (lower reputation-weighted score) | same |
| Reviewer | agent 4; owner `tan-bylaw-ops` differs from the winner's owner `tan-bylaw` | same |
| Waterfall (tUSD) | reviewer 8, producer 55, sales 7, treasury 30 (no seats existed yet, so the seat share went to the treasury) | reviewer 8, producer 55, sales 7, **seats 15**, treasury 15 |
| Time to settle | about 85 seconds from posting | about 90 seconds from acceptance (it waited about 6 minutes after posting while the free RPC's rate limit was fixed; see the limits below) |

Report integrity (job 1): the on-chain hash `0xb5c4d2a3...` equals the SHA-256 of the canonical report JSON, and the report's facts (`code_hash`, storage usage, 5 full-access keys, 0 function-call keys) match `wrap.testnet` as read live from RPC.

Seat dividends (job 2): the 15 tUSD seat share split exactly 2:1 by weight (seat #6 earned 10, seat #7 earned 5). Both holders then claimed: `tan-bylaw` received 72 tUSD (55 producer + 7 sales + 10 dividend) and `tan-bylaw-ops` 13 tUSD (8 reviewer + 5 dividend). Job 1 claims: [tan-bylaw](https://testnet.nearblocks.io/txns/G8WrXnqer9j9zcwsXgesn6j2djU9J5125uBBAmbYEYds), [tan-bylaw-ops](https://testnet.nearblocks.io/txns/7Q9qgsAZbFNVEGSbkq8ygmA6grSoXtLP7kvpBz5shtja).

Treasury: funded with 200 tUSD ([tx](https://testnet.nearblocks.io/txns/7hYvD5TRhEdoswnshrXEdaNnUF8HcREPvvy8eXUtcH7N)). The solvency invariant held after every step (`get_stats`: accounted equals expected).

## Security demo
The treasurer agent signed these with its real function-call key; the contract **recorded both as `Rejected` and moved no money** (treasury unchanged at 229 tUSD before and after):
- `#2` 25.000001 tUSD to the allowlisted vendor: `per_tx_cap_exceeded`
- `#3` 1 tUSD to `attacker-wallet.testnet`: `vendor_not_allowlisted`
- `#1` 1 tUSD to the allowlisted vendor: `Paid` (the legitimate purchase)

Guardian freeze: `tan-bylaw-ops` froze analyst2 immediately ([tx](https://testnet.nearblocks.io/txns/7F6vvbsFxbuZdLm76rrFwFGh9T41YvL9qq7RFQXwjwSG)). A non-guardian account attempting the same freeze was refused by the contract (`only a guardian or the owner can freeze`). Only a DAO vote (proposal #8) could unfreeze.

## Bugs found by reviewing the live run (and fixed)
- **The treasurer paid the same vendor 10 extra times (1 tUSD each, spends #4 to #13).** Its purchase step sent the payment and then read the result back; under the free RPC's rate limit the read-back failed, the step was marked failed and retried, and every retry paid again. The contract's per-agent budget bounded the damage exactly as designed: the agent reached 11 tUSD of its 30 tUSD window and no further. The transactions remain visible on the Treasury page and on-chain; they cannot be undone. Fix: the agent now checks the chain for an existing purchase for that job before paying, and a failed read-back no longer fails the step. A regression test reproduces the failure (old code: 5 payments, fixed code: 1; it also covers an agent restart with an empty retry ledger).
- **Version history lacked v1**, because the indexer only knew versions it had watched change after it started, so the v1 to v2 diff did not show. The indexer now backfills older versions from the contract's own `get_bylaw_version`. A backfilled version has no known change time (shown as "earlier version"); the time shown for other versions is when the indexer first saw them, not the on-chain time.
- **Job 1's report was missing from the app** after I deleted the indexer's database file. Reports are stored by the indexer (the chain keeps only their hash), so they are lost with that file. I re-uploaded the saved copy; the indexer recomputes the hash from the content, and it matches the on-chain hash. A normal `reindex` keeps reports.
- **The agents page listed pool methods** in the treasurer's key scope that the deployed contract does not grant. It now shows only `request_spend`, matching the key on-chain.
- **The default testnet RPC in the repo was deprecated** (`rpc.testnet.near.org` answers HTTP 429) and is replaced.

## Web app: responsive review
Captured with headless Chrome against this live deployment at 390, 768, 1440 and 1917 px wide; none of the pages checked overflows horizontally. Reviewed by eye at 390 and 1440 px. Changes: fluid text size, grids that cannot overflow a small phone, a one-row swipeable menu on phones, tables that keep their column widths and scroll sideways with an edge cue (the Outcome and Pending dividends columns come first), larger touch targets, and aligned two-column layouts on desktop.

## Honest limits of this run
- **The council is two accounts controlled by the same team.** It demonstrates real multi-party voting mechanics (every proposal needed both votes), not independent governance.
- **Report summaries are template-generated** (`model: template-v1`). No LLM API key was set, so no LLM was used in this run. The facts in each report are real RPC data and are independently recomputed by the reviewer agent.
- **Agent owners are our own accounts**, including `tan-bylaw-tusd.testnet` (the token account) as analyst2's owner. This is a test setup, not a real set of independent owners.
- **Public RPC limits mattered.** `rpc.testnet.near.org` is deprecated; FastNEAR's free tier rate-limited the agents under load, so the agents and indexer run on the free dRPC endpoint (`https://near-testnet.drpc.org`). The legacy CLI used for human-signed transactions needs `broadcast_tx_commit`, which dRPC does not offer, so those went through FastNEAR.
- **Wallet actions in the web app are untested against this deployment.** The pages were viewed in Chrome against the live indexer (read-only, see the review above), but connecting a wallet and sending transactions from the UI (post a job, claim, freeze, DAO votes) has only been tested on the mock wallet; the on-chain actions in this document were sent with the CLI and the agents' keys.
- Not in this build: attestation (privacy track) and collective purchase pools.
