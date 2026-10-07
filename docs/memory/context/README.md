# Context

Durable workspace knowledge that is expensive to rediscover: hidden constraints, explanations of structure, and recurring procedures whose owner is not another document. Check [document maintenance](../documents.md) before adding a fact another document owns; link to that document instead.

One bullet per topic note, with a relative link and a concrete "read when" cue. Create a note only for a supported finding; keep the facts in the note.

Threshold: 12 entries. Past it, the bounded review in [maintenance](../maintenance.md) samples this category first.

- [minicore deployment constraints](minicore-deployment-constraints.md): read when deploying or exposing a stack on minicore, or picking a host port.
- [Operating kardboard on minicore](kardboard-production-operations.md): read when deploying a change, rotating a secret, reading a Session log, or querying the production database.
- [Testing client code](client-side-tests.md): read when a change in `packages/app/client` needs a test; there is no DOM harness.
- [Previewing the client locally](previewing-the-client-locally.md): read when checking a client change in a browser on the Mac, or when `/api` calls fail with `ECONNREFUSED` under `pnpm dev`.
- [Testing server code through the MCP server or the REST API](testing-mcp-and-api-paths.md): read when a server test needs an MCP tool called the way an agent with an Access token calls it.
- [The Claude GitHub workflows](claude-github-workflows.md): read when editing `claude-code-review.yml` or `claude.yml`, changing the model or effort a Claude review runs at, or when a Claude review check did nothing.
- [Session and Preview network isolation](session-network-isolation.md): read when changing which containers a Session or Preview may reach, adding a service to `kardboard_workload`, connecting a compose service to a runner-made network, or naming a Docker bridge.
