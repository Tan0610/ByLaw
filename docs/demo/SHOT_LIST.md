# 90-second demo: shot list

Record at 1280x800 or 1440x900, browser zoom 110%, light theme (switch to dark for shot 9 if you want contrast). Run the web app with `npm run dev:mock -w apps/web` for a fully reproducible take, or against testnet once deployed. Keep the terminal font at 16 px or larger.

Before recording: reload the page (mock state resets), set the account selector to "Customer".

| # | Time | Screen | Action | On screen at the end |
|---|---|---|---|---|
| 1 | 0:00-0:08 | ByLaw page | Slow scroll over the bylaw text and the parameters table | "Text, version 2", split 55 / 15 / 15 / 8 / 7 |
| 2 | 0:08-0:16 | Agents page | Pan across the five agent cards | Key scope line ("place_bid, submit_work"), budget bars, owners |
| 3 | 0:16-0:26 | Jobs page (Customer) | Type `dex.testnet`, price 100, click "Pay and post job" | Success notice; new job row at the top |
| 4 | 0:26-0:40 | Job detail of the new job | Click the job; let it advance live | Steps go Posted → Open → Awarded → Submitted → Settled; bids table with scores and "Winner" |
| 5 | 0:40-0:50 | Same page, scroll down | Show review and waterfall | "Approved", stacked bar, "conserved to the unit", report facts |
| 6 | 0:50-0:57 | Agents page | Point at the winning analyst | Reputation and budget went up |
| 7 | 0:57-1:05 | Treasury page | Click the "Rejected" filter | Overspend and non-allowlisted vendor rows, "Solvency invariant: holds" |
| 8 | 1:05-1:13 | Agents page, switch selector to "Guardian" | Click "Freeze agent" on the treasurer, confirm | Card shows "Frozen" and "Only the DAO can unfreeze" |
| 9 | 1:13-1:25 | DAO page as "Ana" | Approve proposal #5; create "Amend the bylaw" and approve it; switch to "Dev" and approve it | Status "Approved" |
| 10 | 1:25-1:30 | ByLaw page | Click the newest version | Diff with the added rule in green; end card: "ByLaw: the contract is the company. Built at NEAR HACKATHON." |

Alternative opening for technical viewers (5 s): terminal running `npm run e2e:mock -w scripts`, scrolled to "All checks passed."

Do not show: any private key, `secrets/`, `.env`, wallet seed phrases.
