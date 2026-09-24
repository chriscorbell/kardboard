# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/runner/package.json packages/runner/
RUN pnpm install --frozen-lockfile --filter @kardboard/runner --config.confirmModulesPurge=false
COPY packages/runner packages/runner
RUN pnpm --filter @kardboard/runner build && pnpm install --frozen-lockfile --prod --filter @kardboard/runner --config.confirmModulesPurge=false && mkdir -p packages/runner/node_modules

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=3071
# git clones a Preview's branch; busybox tar packs it into a build context for the Docker daemon.
RUN apk add --no-cache git
WORKDIR /repo/packages/runner
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages/runner/node_modules ./node_modules
COPY --from=build /repo/packages/runner/dist ./dist
COPY packages/runner/package.json ./package.json
EXPOSE 3071
CMD ["node", "dist/index.js"]
