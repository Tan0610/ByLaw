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

## Honest limits of this run
- **The council is two accounts controlled by the same team.** It demonstrates real multi-party voting mechanics (every proposal needed both votes), not independent governance.
- **Report summaries are template-generated** (`model: template-v1`). No LLM API key was set, so no LLM was used in this run. The facts in each report are real RPC data and are independently recomputed by the reviewer agent.
- **Agent owners are our own accounts**, including `tan-bylaw-tusd.testnet` (the token account) as analyst2's owner. This is a test setup, not a real set of independent owners.
- **Public RPC limits mattered.** `rpc.testnet.near.org` is deprecated; FastNEAR's free tier rate-limited the agents under load, so the agents and indexer run on the free dRPC endpoint (`https://near-testnet.drpc.org`). The legacy CLI used for human-signed transactions needs `broadcast_tx_commit`, which dRPC does not offer, so those went through FastNEAR.
- **The web app is built and tested on mocks and against the live indexer's API shapes, but has not yet been exercised in a browser against this deployment.**
- Not in this build: attestation (privacy track) and collective purchase pools.
