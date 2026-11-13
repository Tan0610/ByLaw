# Hugging Face Space (Docker). Same backend as the repo-root Dockerfile, but the code is fetched from GitHub at
# build time, so the Space itself only needs this file and README.md.
# To pick up new code: Space settings -> "Factory rebuild" (a plain restart reuses the cached build).
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*

ARG REPO_URL=https://github.com/Tan0610/ByLaw.git
ARG REPO_REF=main
# Spaces run the container as UID 1000, which is the built-in "node" user of this image.
USER node
WORKDIR /home/node/app
RUN git init -q . \
 && git remote add origin "$REPO_URL" \
 && git fetch -q --depth 1 origin "$REPO_REF" \
 && git checkout -q FETCH_HEAD \
 && npm ci --workspace=@bylaw/indexer --workspace=@bylaw/agents --workspace=@bylaw/near-client --include-workspace-root \
 && npm cache clean --force

ENV NODE_ENV=production PORT=7860 HOST=0.0.0.0
EXPOSE 7860
CMD ["node", "deploy/start.mjs"]
