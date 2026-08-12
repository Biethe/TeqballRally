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

# Every runtime module, by glob rather than by name. The list used to be
# spelled out, and it silently fell behind: clubs, matches and presence were
# added to the server without being added here, so the image built perfectly
# and then died on startup with "Cannot find module '/app/presence.mjs'". A
# missing file is not something the build can catch — only a container that
# refuses to boot, which is the slowest possible place to find out.
#
# Nothing in this directory is dead weight: *.mjs is the server itself, and the
# type declarations beside it are .d.mts, so they stay out of the image.
COPY *.mjs ./

# Players live in Firestore when FIRESTORE_PROJECT is set, which is what a
# deployment does — Cloud Run's filesystem is ephemeral, so the JSON store the
# code falls back to would lose the community on every restart. Credentials
# come from the service account; there is no key file to mount or leak.
#
#   FIRESTORE_PROJECT=teqopen-4c7ae
#   FIRESTORE_DATABASE=(default)      # only when it is not the default one
ENV NODE_ENV=production

# Cloud Run injects PORT; the relay already prefers it over its 8787 default.
EXPOSE 8787

# Run as the image's unprivileged user rather than root.
USER node

CMD ["node", "relay.mjs"]
