# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/preview-router/package.json packages/preview-router/
RUN pnpm install --frozen-lockfile --filter @kardboard/preview-router --config.confirmModulesPurge=false
COPY packages/preview-router packages/preview-router
RUN pnpm --filter @kardboard/preview-router build && pnpm install --frozen-lockfile --prod --filter @kardboard/preview-router --config.confirmModulesPurge=false && mkdir -p packages/preview-router/node_modules

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=3072
WORKDIR /repo/packages/preview-router
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages/preview-router/node_modules ./node_modules
COPY --from=build /repo/packages/preview-router/dist ./dist
COPY packages/preview-router/package.json ./package.json
USER node
EXPOSE 3072
CMD ["node", "dist/index.js"]
