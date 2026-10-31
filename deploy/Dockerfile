# One image for the gateway and the worker (multi-arch: linux/amd64 + linux/arm64 — DGX Spark is arm64).
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY spec spec
COPY packages packages
COPY apps apps
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter "./packages/*" build && pnpm --filter @nearchant/gateway build && pnpm --filter @nearchant/worker build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
COPY config config
COPY envs envs
RUN mkdir -p /app/.media && chown -R node:node /app/.media
USER node
EXPOSE 8787
CMD ["node", "apps/gateway/dist/main.js"]
