# PRD: Charter (working title)

> Status: draft v1 · 2026-11-09 · Deadline 2026-11-14 23:59 UTC
> Zero-cost build: NEAR testnet only. No mainnet spend.

## 1. One-liner
**Charter makes a company's constitution executable.** Members write a charter, AI agents run the business inside it, and a NEAR contract enforces it: budgets, roles, escrow, revenue split. Humans only set constraints.

## 2. Problem
Teams want agents that earn and spend, but giving an agent a wallet is all-or-nothing. DAOs can hold money and vote, but they cannot run day-to-day work. Nothing ties the two together: who may spend what, who checks whose work, who gets paid, and how trust is earned over time.

## 3. Solution
- A **Sputnik DAO** is the employer and owner. It amends the charter by proposal.
- Each agent is a **NEAR sub-account** with a function-call key limited to the Charter contract **and to the methods of its role** (protocol-level role enforcement).
- Each agent is also an **NFT**. The NFT owner (human or DAO) receives the agent's earnings.
- **Earned budgets:** an agent's spending limit rises with verified delivered work and falls after rejected work.
- **Separation of duties:** a different agent (with a different owner) reviews work. Rejections cost reputation. The DAO can override. Guardians can freeze any agent instantly.
- **Programmable revenue:** each accepted job pays out by the charter to producer owner, reviewer, sales agent, treasury and member seats.
- **Seat NFTs** carry revenue weight and guardian rights, and are transferable.

### Why this only makes sense on NEAR
- Sub-accounts as agent identities, and function-call keys with `receiver_id` + `method_names` as native role scoping: no equivalent without rebuilding account abstraction.
- Sputnik DAO as the employer: governance objects already exist and are callable by contracts.
- Named accounts make agents legible (`analyst-1.charter.testnet`).
- NFTs that map to accounts and earnings fit NEP-171 plus NEAR accounts.

## 4. Users
| Persona | Need | Action |
|---|---|---|
| **Member** | Shape and share in a business without running it | Votes on charter, holds seat, claims revenue |
| **Guardian** | Safety brake | Freezes a misbehaving agent |
| **Agent owner** | Earn from an agent | Holds agent NFT, claims earnings |
| **Customer** | Get a deliverable | Pays escrow, receives report |
| **Agents** | Do work within limits | Sales, Analyst, Reviewer, Treasurer |

## 5. Demo business: "NEAR contract health briefs"
Customer submits a NEAR contract account id and pays testnet tUSD. The business returns a brief.
- **Deterministic facts** (from NEAR RPC): code hash, storage usage, balance, access keys (full-access keys present? function-call keys?), upgradeability signals.
- **LLM summary** over those facts.
- The reviewer **recomputes the facts** and rejects a brief whose facts differ. Reviews are therefore verifiable, not vibes.
- The business can be swapped later; the mechanics do not depend on it.

## 6. Scope (tiered; cut from the bottom)
| Tier | Content | Tracks it secures |
|---|---|---|
| **T1 (must)** | Charter params + text on-chain, Sputnik DAO ownership, agent sub-accounts with role-scoped keys, jobs + escrow + review + waterfall, earned budgets, procurement with vendor allowlist and approval threshold, freeze switch | social, business, security, agents |
| **T2** | Agent NFTs + seat NFTs with revenue accumulator, claimable ledger | nfts |
| **T3** | Bidding with reputation-weighted scoring, collective purchase pools | swarms |
| **T4 (conditional)** | Analyst inference via NEAR AI Cloud with attestation hash recorded and verified in UI | privacy |

### Non-goals
Mainnet, legal entity wrapping, KYC, token launch, real customer data, Intents (no testnet; not faked).

## 7. Functional requirements (see CONTRACT_SPEC.md)
- FR1 Charter text and parameters are on-chain; only the DAO account can change them; every change emits old and new hash.
- FR2 Agent registration creates a sub-account with a function-call key restricted to the role's methods.
- FR3 Customer funds are escrowed on `ft_transfer_call`; refunds are never blocked by an unregistered receiver (pull-based claims).
- FR4 Jobs follow the state machine; timeouts are enforceable by anyone.
- FR5 Producer owner may not equal reviewer owner.
- FR6 Rejection reduces reputation; below a threshold the agent auto-freezes.
- FR7 Budgets: `budget = min(max, base + per_rep × rep/100)` per rolling window; overspend is recorded as a rejected attempt, not a panic.
- FR8 Spends above the approval threshold wait for DAO approval.
- FR9 Revenue waterfall conserves value to the unit; global solvency invariant holds.
- FR10 Guardians can freeze; only the DAO can unfreeze, retire or rotate.

## 8. Non-functional
Integer math only; idempotent services; every state change emits an event; secrets in env only; README with "do X, see Y"; reproducible one-command demo.

## 9. Demo script (~90s)
1. DAO page: show the charter, the DAO and its agents (5 sub-accounts, 5 NFTs).
2. Customer pays 100 tUSD for a brief on a contract id.
3. Sales agent accepts; two analysts bid; scoring picks one by price and reputation.
4. Treasurer buys shared data (collective purchase) within budget.
5. Analyst submits; reviewer recomputes facts and approves; waterfall splits 100 tUSD.
6. Analyst's budget visibly rises. Seat holder claims revenue.
7. Attack scene: an agent tries to overspend and to pay a non-allowlisted vendor. Both rejected and logged.
8. A guardian freezes the agent; a DAO proposal amends the charter.

## 10. Tracks
Primary: `social`, `business`, `security`, `agents`. Add: `nfts`, `swarms`. Conditional: `privacy` (only if attested inference runs). Not claimed: `defi`, `thesis`, `memecoins`, `games`, `realworld`.

## 11. Judging self-assessment
- Technical: role-scoped keys, on-chain charter, solvency invariant, property tests.
- Innovation: organization-level charter; earned budgets; agents as earning NFTs.
- Track fit: Sputnik, sub-accounts, function-call keys, NEP-171 all load-bearing.
- Execution: scripted end-to-end testnet run.

## 12. Risks and honest limits
| Risk | Mitigation |
|---|---|
| Crowded agent space incl. NEAR's own marketplace | Lead with the charter and organization, not a marketplace |
| Scope (7 tracks) | Tiers; T1 is a complete product alone |
| Sputnik DAO costs ~6 testnet NEAR | Faucet check early; fallback minimal council contract |
| NEAR AI credits unconfirmed | T4 optional; any other model for summaries |
| Sub-account keys cannot be rotated; allowance fixed | Generous allowance; `rotate_agent` re-issues identity and moves NFT |
| Function-call keys cannot attach deposits | Funds live in the contract ledger, never in agent accounts |
| Attestation is recorded, not verified on-chain | UI verifies via NEAR AI endpoints; stated plainly |

## 13. Submission checklist (humans only)
- [ ] Repo public, LICENSE, README discloses AI-generated code, libraries, pre-hackathon code.
- [ ] X demo post: "built at NEAR HACKATHON", @NEARProtocol, #NEARHackathon, video or screenshots.
- [ ] Mainnet implicit payout account created by a human.
- [ ] Re-read live HACKATHON.md; submit once with explicit human confirmation.
- [ ] Note: one person may submit at most 2 independent projects (this is the second after Receivable).
