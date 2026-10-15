# syntax=docker/dockerfile:1

# ---- interface: compiled once, only the static output is kept ----
FROM node:24-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- server dependencies, production only ----
FROM node:24-alpine AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=4600 \
    STORAGE_DIR=/app/storage
WORKDIR /app

# Owned by the unprivileged user before the volume is first mounted, so a fresh
# named volume inherits the right owner and uploads can be written.
RUN mkdir -p /app/storage && chown node:node /app/storage

COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/
COPY server/src ./server/src
COPY server/agent ./server/agent
COPY --from=web /app/web/dist ./web/dist

USER node
EXPOSE 4600
VOLUME /app/storage

HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:4600/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
