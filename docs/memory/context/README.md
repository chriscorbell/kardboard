# Context

Durable workspace knowledge that is expensive to rediscover: hidden constraints, explanations of structure, and recurring procedures whose owner is not another document. Check [document maintenance](../documents.md) before adding a fact another document owns; link to that document instead.

One bullet per topic note, with a relative link and a concrete "read when" cue. Create a note only for a supported finding; keep the facts in the note.

Threshold: 12 entries. Past it, the bounded review in [maintenance](../maintenance.md) samples this category first.

- [minicore deployment constraints](minicore-deployment-constraints.md): read when deploying or exposing a stack on minicore, or picking a host port.
- [Operating kardboard on minicore](kardboard-production-operations.md): read when deploying a change, rotating a secret, reading a Session log, or querying the production database.
- [Testing client code](client-side-tests.md): read when a change in `packages/app/client` needs a test; there is no DOM harness.
- [Previewing the client locally](previewing-the-client-locally.md): read when checking a client change in a browser on the Mac, or when `/api` calls fail with `ECONNREFUSED` under `pnpm dev`.
- [Runner previews on the kardboard board](kardboard-runner-previews.md): read when requesting a preview, especially from a branch created before the root Dockerfile was added.
- [A provider's usage limit is only visible in the egress proxy](provider-usage-limits-are-seen-in-the-proxy.md): read when changing Provider fallback, touching `/limits`, or explaining why a Card did or did not switch Providers.
- [Testing server code that enqueues Triggers](testing-trigger-paths.md): read when a server test calls `createCard`, `moveCard`, or anything else that reaches `enqueueTrigger`, or has to run a Session against a fake runner.
- [Testing server code that calls GitHub or the MCP server](testing-github-and-mcp-paths.md): read when a server test needs the approval and merge path, a pull request check, or an MCP tool called the way a Session calls it.
- [The Claude GitHub workflows](claude-github-workflows.md): read when editing `claude-code-review.yml` or `claude.yml`, changing the model or effort a Claude review runs at, or when a Claude review check did nothing.
- [Session and Preview network isolation](session-network-isolation.md): read when changing which containers a Session or Preview may reach, adding a service to `kardboard_workload`, connecting a compose service to a runner-made network, or naming a Docker bridge.
