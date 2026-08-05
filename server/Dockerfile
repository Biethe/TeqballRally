# Relay image for Cloud Run. Only the server directory is copied, so the image
# carries `ws` and nothing else — none of the game's build tooling.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY relay.mjs ./

# Cloud Run injects PORT; the relay already prefers it over its 8787 default.
ENV NODE_ENV=production
EXPOSE 8787

# Run as the image's unprivileged user rather than root.
USER node

CMD ["node", "relay.mjs"]
