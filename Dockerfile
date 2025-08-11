FROM node:20-alpine AS base
WORKDIR /app

COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
# Install all deps (incl. dev) to build TypeScript
RUN npm ci || npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

EXPOSE 7821

ENV NODE_ENV=production \
    MCP_TRANSPORT=ws \
    MCP_WS_PORT=7821

CMD ["node", "dist/index.js"]
