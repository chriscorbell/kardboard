# Testing server code through the MCP server or the REST API

Read when: a server test needs an MCP tool called the way an agent with an Access token calls it, or a REST route called as the User.

Status: verified
Scope: `packages/app/server`
Verified: 2026-10-07
Source: [mcp-tools.test.ts](../../../packages/app/server/test/mcp-tools.test.ts), [access-tokens.test.ts](../../../packages/app/server/test/access-tokens.test.ts), [body-limits.test.ts](../../../packages/app/server/test/body-limits.test.ts), [api.test.ts](../../../packages/app/server/test/api.test.ts), [mcp.ts](../../../packages/app/server/src/routes/mcp.ts)
Recheck when: `routes/mcp.ts` stops handing the raw Node request to the SDK transport, or Access tokens stop being made through `POST /admin/boards/:id/tokens`.

- MCP. The route gives the SDK transport the raw Node request and response, so `mcp.request()` cannot drive it. Serve `mcp.fetch` with `@hono/node-server` on port 0, make an Access token through `POST /admin/boards/:id/tokens` with `api.request()`, and connect the SDK's `Client` through `StreamableHTTPClientTransport` with the returned secret as the bearer token. A tool that throws comes back as `isError: true` with the message as its text. Close every client and the server in `after`, or the test run never exits. `access-tokens.test.ts` also shows a bare `initialize` POST for asserting the route's 401 before any tool runs.
- REST. `api.request()` works directly. Tests run in dev authentication, where every request is the one User.
