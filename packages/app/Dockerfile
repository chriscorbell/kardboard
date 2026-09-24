# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/app/package.json packages/app/
RUN pnpm install --frozen-lockfile --filter @kardboard/app... --config.confirmModulesPurge=false

FROM deps AS build
COPY packages/shared packages/shared
COPY packages/app packages/app
RUN pnpm --filter @kardboard/app build

FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/app/package.json packages/app/
RUN pnpm install --frozen-lockfile --prod --filter @kardboard/app... --config.confirmModulesPurge=false

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=3070 KARDBOARD_DATA_DIR=/data
WORKDIR /repo/packages/app
COPY --from=prod-deps /repo/node_modules /repo/node_modules
COPY --from=prod-deps /repo/packages/app/node_modules ./node_modules
COPY packages/shared /repo/packages/shared
COPY --from=prod-deps /repo/packages/shared/node_modules /repo/packages/shared/node_modules
COPY --from=build /repo/packages/app/dist ./dist
COPY packages/app/drizzle ./drizzle
COPY packages/app/package.json ./package.json
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3070
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "dist/server/index.js"]
