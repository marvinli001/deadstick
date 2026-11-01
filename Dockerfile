FROM metacubex/mihomo:v1.19.33 AS core
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY src ./src
COPY web ./web
RUN pnpm build && pnpm --filter @deadstick/web build && pnpm prune --prod

FROM node:24-bookworm-slim
ENV NODE_ENV=production PROBE_MODE=proxy MIHOMO_BIN=/usr/local/bin/mihomo
WORKDIR /app
COPY --from=core /mihomo /usr/local/bin/mihomo
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
