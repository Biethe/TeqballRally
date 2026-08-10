# Server image for Cloud Run: the match relay and the accounts API, which share
# a process and a port. Only the server directory is copied, so the image
# carries `ws` and nothing else — none of the game's build tooling.
#
# `rules.mjs` is generated from the game's own source (scripts/build-rules.mjs)
# and committed, so this image needs no toolchain to produce it. A stale bundle
# fails `tests/rules.test.ts`, which is what keeps that safe.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY relay.mjs api.mjs accounts.mjs store.mjs rules.mjs ./

# Players are kept in a JSON file under DATA_DIR. Cloud Run's filesystem is
# ephemeral, so a deployment that means to keep a community needs a volume
# mounted here — or `store.mjs` swapped for a managed database, which is the
# one file it was shaped to be.
ENV DATA_DIR=/data
VOLUME ["/data"]

# Cloud Run injects PORT; the relay already prefers it over its 8787 default.
ENV NODE_ENV=production
EXPOSE 8787

# Run as the image's unprivileged user rather than root.
USER node

CMD ["node", "relay.mjs"]
