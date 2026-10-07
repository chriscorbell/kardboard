# Image and compose mistakes that broke the first deployment

Read when: the app image fails at startup with a missing module, a container takes 30 seconds to stop, a router registered under `/api` guards a route it should not, or a compose environment value arrives mangled.
Status: verified
Scope: workspace
Verified: 2026-09-15
Source: production log excerpts of 2026-09-14 recorded in `work/` history; fixes in `packages/app/Dockerfile`, `deploy/compose.yaml`, `packages/app/server/src/index.ts`
Recheck when: the workspace layout or the Node base image changes

- The app image must copy `packages/shared` source and `packages/shared/node_modules` into the runtime stage: Node resolves `@kardboard/shared` through a workspace symlink to TypeScript source, and that package's own `zod` link lives beside it. Copying only `package.json` fails at boot with `ERR_MODULE_NOT_FOUND`.
- A package with no runtime dependencies gets no `node_modules` directory from pnpm, and a `COPY --from` of that path fails the build. `mkdir -p` it in the build stage first.
- `node` as PID 1 ignores SIGTERM, so Watchtower waited the full 30 s per container. `init: true` on each compose service fixed it; restarts now take under a second.
- A compose default value cannot contain braces: `${VAR:-{card}.{domain}}` ends the substitution at the first `}` and leaves the rest as literal text. Write the bare `${VAR}` and let the application supply the default.
- Hono matches routers in registration order. A router registered under `/api` with a user-auth middleware also guards every route beneath `/api` registered after it, so a route meant to bypass user auth has to be registered first. Symptom, when the app still had internal routes: the runner's exit report answered 401 and Sessions stayed "running".
