# Deploying the live demo: Vercel (website) + Hugging Face Space (backend)

Two free accounts, about 20 minutes. Nothing here spends real money: it all runs against **NEAR testnet**.

```
 Judge's browser ──► Vercel: the website (static)         apps/web
        │                      │  reads
        │                      ▼
        └──────────────► Hugging Face Space: one container  deploy/start.mjs
                               indexer (REST + SSE)  +  the five agents
                                        │  reads the chain; the agents sign with their own role-limited keys
                                        ▼
                               NEAR testnet: tan-bylaw-app.testnet (owner: the DAO)
```

Why two hosts: Vercel runs short-lived functions, so it cannot keep the agents and the indexer running. The Space can.

## Part A. Backend on Hugging Face (do this first, you need its URL for Part B)

1. Sign up at https://huggingface.co (free). **New Space**: name `bylaw-backend`, SDK **Docker** (Blank template), hardware **CPU basic (free)**, visibility **Public** (the website's browser code calls it directly).
2. In the Space, **Files → Add file → Upload files**, and upload these two files from this repo into the Space's root (keep the names exactly `Dockerfile` and `README.md`):
   - `deploy/hf-space/Dockerfile`
   - `deploy/hf-space/README.md`
3. **Settings → Variables and secrets → New secret**, five times. The values are the agents' private keys in your local, git-ignored `secrets/agents.env` (open that file on your computer; never paste them into chat, an issue or a commit):

   | Secret name | Taken from `secrets/agents.env` line |
   |---|---|
   | `AGENT_SALES_PRIVATE_KEY` | `AGENT_SALES_PRIVATE_KEY=...` |
   | `AGENT_ANALYST1_PRIVATE_KEY` | `AGENT_ANALYST1_PRIVATE_KEY=...` |
   | `AGENT_ANALYST2_PRIVATE_KEY` | `AGENT_ANALYST2_PRIVATE_KEY=...` |
   | `AGENT_REVIEWER_PRIVATE_KEY` | `AGENT_REVIEWER_PRIVATE_KEY=...` |
   | `AGENT_TREASURER_PRIVATE_KEY` | `AGENT_TREASURER_PRIVATE_KEY=...` |

   Everything else (contract ids, agent account names, RPC) is already in `deploy/defaults.json`, so nothing more is needed. These keys are testnet function-call keys: each can only call its own role's methods on the ByLaw contract, so the worst a leaked key can do is act as that one agent on testnet. Still, treat them as secrets.
4. The Space builds (about 3 to 5 minutes; watch the **Logs** tab). A good start looks like `"agents":"enabled"` and five `agent started` lines.
5. Your backend URL is `https://<your-hf-username>-bylaw-backend.hf.space`. Open `<that url>/health` and `<that url>/agents` in a browser: you should see JSON, with five agents.

If you leave the secrets out, the Space still works but is **read-only**: it serves the live chain data and nobody acts. Delete the secrets any time to stop the agents.

## Part B. Website on Vercel

1. Sign up at https://vercel.com with your GitHub account (Hobby plan, free). **Add New → Project →** import `Tan0610/ByLaw`.
2. **Root Directory:** `apps/web`. Leave "Include source files outside of the Root Directory" **on** (the install runs from the repo root). The framework, install and build commands come from `apps/web/vercel.json`; do not override them.
3. **Environment Variables** (apply to all environments):

   | Name | Value |
   |---|---|
   | `VITE_INDEXER_URL` | your backend URL from Part A, no trailing slash |
   | `VITE_CONTRACT_ID` | `tan-bylaw-app.testnet` |
   | `VITE_DAO_ID` | `bylaw-dao.sputnikv2.testnet` |
   | `VITE_TOKEN_ID` | `tan-bylaw-tusd.testnet` |
   | `VITE_NEAR_NETWORK` | `testnet` |

   Do **not** set `VITE_USE_MOCKS` (that would show fake demo data).
4. **Deploy.** Vercel gives you a `*.vercel.app` URL. These values are baked in at build time, so if you change one later, redeploy.

## Part C. Check it works

- [ ] The site loads and the ByLaw page shows **version 2** with the **v1 to v2 diff** in the history.
- [ ] Agents page: five agents, correct owners; the treasurer's key scope shows only `request_spend`.
- [ ] Jobs: jobs #1 and #2 are Settled, and each shows its **report** (not an error).
- [ ] Treasury: the paid spends and the two rejected attacks are listed.
- [ ] A direct link such as `<site>/jobs/1` opens (not a 404).
- [ ] **Connect wallet** lists Meteor Wallet (the only wallet; MyNearWallet is retired).
- [ ] `<backend>/health` lists all five agents under `agents_alive`.
- [ ] (Needs your wallet) post a job from the site and watch it go Posted → Open → Awarded → Submitted → Settled in about 90 seconds.

## What to know (honest limits)

- **Sleeping and restarts.** A free Space can sleep after a period without visitors (a forum post says about 48 hours; unverified) and restarts wipe its disk. When it wakes, the indexer rebuilds everything from the chain. The reports of jobs #1 and #2 ship in the repo (`services/indexer/seed/`), so they always show. A report for a job created later is only kept until the next restart (the chain stores just its hash).
- **Timelines are rebuilt, not replayed.** After a restart, the times shown for past events are "first seen" times, not the on-chain times.
- **Public RPC limits.** The backend reads through a free public RPC (`near-testnet.drpc.org`). It is fine for a handful of visitors. If it starts returning errors, set `NEAR_RPC_URL` (a Space variable) to another provider's testnet endpoint.
- **Open API.** The API is readable by any website (the data is public). Posting reports or heartbeats needs a token that exists only inside the container, so outsiders cannot write.
- **Gas.** Each agent account holds about 0.5 NEAR of testnet gas (about 0.001 NEAR per action), enough for hundreds of actions.
- **Updating.** Push to GitHub and Vercel redeploys by itself. For the Space use **Settings → Factory rebuild** (a plain restart reuses the cached build and old code).
- **Not tested here:** the Space build itself on Hugging Face and the Vercel build were not run from this machine (no Docker locally). CI builds both Dockerfiles and starts the container against the live testnet on every push; see `.github/workflows/ci.yml`. A real wallet sign-in from the deployed site is still for you to try.
