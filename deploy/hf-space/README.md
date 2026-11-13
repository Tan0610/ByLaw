---
title: ByLaw backend
emoji: 📜
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
short_description: Indexer and AI agents for the ByLaw NEAR project (testnet)
---

Backend of **ByLaw** (https://github.com/Tan0610/ByLaw): the indexer that serves the REST/SSE API and the five
agents, running against the NEAR **testnet** contract `tan-bylaw-app.testnet`. The website is deployed separately.

- `GET /health`, `/agents`, `/jobs`, `/bylaw`, `/stats` return live data read from the chain.
- Without the five `AGENT_*_PRIVATE_KEY` secrets this Space is read-only: nothing acts on-chain.
- Testnet only. No real funds.
