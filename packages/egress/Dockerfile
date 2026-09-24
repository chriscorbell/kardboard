# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/egress/package.json packages/egress/
RUN pnpm install --frozen-lockfile --filter @kardboard/egress --config.confirmModulesPurge=false
COPY packages/egress packages/egress
RUN pnpm --filter @kardboard/egress build && pnpm install --frozen-lockfile --prod --filter @kardboard/egress --config.confirmModulesPurge=false && mkdir -p packages/egress/node_modules

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=8787
WORKDIR /repo/packages/egress
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages/egress/node_modules ./node_modules
COPY --from=build /repo/packages/egress/dist ./dist
COPY packages/egress/package.json ./package.json
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
