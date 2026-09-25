# Testing server code that calls GitHub or the MCP server

Read when: a server test needs the approval and merge path, a pull request check, or an MCP tool called the way a Session calls it.

Status: verified
Scope: `packages/app/server`
Verified: 2026-09-25
Source: [approvals.test.ts](../../../packages/app/server/test/approvals.test.ts), [fake-github.ts](../../../packages/app/server/test/fake-github.ts), [mcp-tools.test.ts](../../../packages/app/server/test/mcp-tools.test.ts), [api.test.ts](../../../packages/app/server/test/api.test.ts), [github.ts](../../../packages/app/server/src/services/github.ts), [mcp.ts](../../../packages/app/server/src/routes/mcp.ts)
Recheck when: `github.ts` stops calling the global `fetch` or signing its App JWT itself, or `routes/mcp.ts` stops handing the raw Node request to the SDK transport.

- GitHub. `github.ts` signs a real RS256 JWT for the App and then calls the global `fetch`. Before importing the app, set `GITHUB_MERGE_APP_ID` and `GITHUB_MERGE_APP_PRIVATE_KEY_B64` to a key from `generateKeyPairSync("rsa")`, then replace `globalThis.fetch` with a handler for `api.github.com` that passes every other host to the real `fetch`. The approval path uses only the installation lookup, the token mint, pull request reads, the merge, and the branch delete. `test/fake-github.ts` does all of this, plus check runs and commit statuses, which it can refuse with a chosen status and headers to stand for a rate limit or an outage, and is what `approvals.test.ts` and `reconcile.test.ts` share: call `githubAppEnv()` before importing any app module; it configures the Merge app, and `githubAppEnv(["MERGE", "SESSIONS"])` adds the Sessions app for a test that starts Sessions.
- MCP. The route gives the SDK transport the raw Node request and response, so `mcp.request()` cannot drive it. Serve `mcp.fetch` with `@hono/node-server` on port 0, insert a `running` Session row whose `tokenHash` is the SHA-256 of a token, and connect the SDK's `Client` through `StreamableHTTPClientTransport` with that bearer token. A tool that throws comes back as `isError: true` with the message as its text. Close every client and the server in `after`, or the test run never exits.
- REST. `api.request()` works directly. Tests run in dev authentication, and `X-Dev-User` picks the caller by email.

These combine with [the Trigger note](testing-trigger-paths.md): set `KARDBOARD_TRIGGER_COALESCE_MS` high as well, since approving and moving Cards writes Triggers.
