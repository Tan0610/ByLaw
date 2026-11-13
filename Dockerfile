# Backend container: the indexer (REST + SSE) and the five agents, in one process tree.
# The website is NOT in here: it is a static app deployed separately (see docs/DEPLOY.md).
# Secrets are never baked in: the agents' private keys come from the host as environment variables.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN chown node:node /app
USER node

# Only the workspaces the backend needs. package.json files of the others are required for `npm ci`.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node services ./services
COPY --chown=node:node deploy ./deploy
COPY --chown=node:node apps/web/package.json ./apps/web/package.json
COPY --chown=node:node scripts/package.json ./scripts/package.json
RUN npm ci --workspace=@bylaw/indexer --workspace=@bylaw/agents --workspace=@bylaw/near-client --include-workspace-root \
 && npm cache clean --force

ENV NODE_ENV=production PORT=7860 HOST=0.0.0.0
EXPOSE 7860
CMD ["node", "deploy/start.mjs"]
