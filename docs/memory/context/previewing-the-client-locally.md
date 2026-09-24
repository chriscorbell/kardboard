# Previewing the client locally

Read when: checking a client change in a browser on the Mac, especially from an agent's browser pane or any launcher that sets `PORT`.

Status: verified
Scope: component, `packages/app`, local development on the Mac
Verified: 2026-09-24
Source: `packages/app/server/src/env.ts`, `packages/app/vite.config.ts`, `packages/app/client/src/lib/auth.tsx`
Recheck when: `env.ts` stops reading `PORT` or `.env`, the Vite proxy target changes, or `packages/app/.env` stops setting `KARDBOARD_AUTH=clerk`

The checked-out `packages/app/.env` sets `KARDBOARD_AUTH=clerk` with real Clerk keys, so a plain `pnpm dev` asks for a Clerk sign-in. Neither `process.loadEnvFile` nor Vite overwrites a variable already in the environment, so dev auth and a throwaway database come from the command line without touching `.env`, which a Session never edits:

```bash
cd packages/app && PORT=3070 KARDBOARD_AUTH=dev CLERK_SECRET_KEY= VITE_CLERK_PUBLISHABLE_KEY= KARDBOARD_DATA_DIR=<scratch dir> pnpm dev
```

`PORT=3070` matters when the launcher exports `PORT` for the port it watches, as the Claude desktop app's browser pane does with 5173: the API server reads `PORT`, binds Vite's port, and every `/api` call through Vite's proxy to 3070 fails with `ECONNREFUSED` while the page stays blank.

A fresh data directory seeds demo boards. To show UI that needs a particular state, write rows into `<scratch dir>/kardboard.db` with `sqlite3`; for example a Blocked Card shows the "is asking" panel when its latest Comment other than kardboard's system notices has `author_kind = 'agent'` (`awaitingReply` in `server/src/services/cards.ts`). Observed 2026-09-24 while checking the Blocked question layout.
