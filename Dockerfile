# syntax=docker/dockerfile:1

# ─── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci

# Copy source and build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune dev dependencies
RUN npm prune --omit=dev

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Non-root user for security
RUN addgroup -S affine && adduser -S affine -G affine

WORKDIR /app

# Copy only what is needed to run
COPY --from=builder --chown=affine:affine /app/node_modules ./node_modules
COPY --from=builder --chown=affine:affine /app/dist ./dist
COPY --chown=affine:affine bin/ ./bin/
COPY --chown=affine:affine package.json ./
COPY --chown=affine:affine tool-manifest.json ./

USER affine

EXPOSE 3000

ENV MCP_TRANSPORT=http \
    AFFINE_MCP_HTTP_HOST=0.0.0.0 \
    PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:${PORT}/healthz || exit 1

ENTRYPOINT ["node", "bin/affine-mcp"]
