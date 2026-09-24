# Dev auth hides client requests that carry no bearer token

Read when: adding anything in `packages/app/client` that loads from `/api` without `request()` (an `<img src>`, an `<a href>`, an `EventSource`, a `window.open`), or when something works locally and returns 401 in production.
Status: verified
Scope: component, `packages/app`
Verified: 2026-09-24
Source: `packages/app/server/src/auth.ts` (`resolveUser`), `packages/app/client/src/lib/api.ts` (`send`), `packages/app/client/src/lib/attachments.ts`, `packages/app/client/src/lib/realtime.ts`; branch `kardboard/fix-client`
Recheck when: `resolveUser` in `auth.ts` changes how it reads a token, or the server starts accepting a cookie

Symptom: attachments rendered fine with `pnpm dev` and were refused in production, and live board updates stopped for good after the first deploy. Cause: in dev auth the server signs every request in as the seeded Admin, so a request with no credentials still succeeds. In Clerk mode the server reads only the `Authorization: Bearer` header, plus a `?token=` query parameter on the `/events` route alone, and never a cookie, by design (see the Preview access paragraph in `docs/design.md`). A plain `<img src="/api/attachments/…">` sends no header, so it gets 401.

Correction: fetch every `/api` resource through `request()` or `requestBlob()` in `lib/api.ts`, and show files from an object URL (`lib/attachments.ts`). The one exception is the board event stream, which cannot set headers: its token lasts about a minute, so `lib/realtime.ts` closes the stream on every error and reconnects with a fresh token rather than letting EventSource retry the old URL.

Check with Clerk mode, or read the server path: a new client call that does not go through `send()` in `lib/api.ts` is unauthenticated in production however it behaves locally.
