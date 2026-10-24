# esgram bot. Build from the repository root:
#   docker build -f apps/bot/Dockerfile -t esgram .
FROM node:22-slim

WORKDIR /app

# Install with the full workspace so the lockfile resolves, then build the bot.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci && npm run build -w @g2/bot && npm prune --omit=dev

ENV NODE_ENV=production
# Data (JSON db + saved media) lives here; mount a volume to persist it.
VOLUME ["/app/data"]

CMD ["node", "apps/bot/dist/index.js"]
