# Sessions opt-in per Board, and Access tokens for the Admin's own agent

Status: active
Objective: let the Admin work a Board from their own local coding agent, with kardboard starting nothing on it, as asked on 2026-09-28. Sessions become an opt-in Board setting, off for a new Board; an Access token lets an outside agent act as the Agent on a Board without them.

- [PR 46](https://github.com/chriscorbell/kardboard/pull/46), branch `sessions-opt-in-per-board`: the setting, migration `0017` (existing Boards migrated on), ADR 0009.
- [PR 47](https://github.com/chriscorbell/kardboard/pull/47), branch `access-tokens-for-local-agents`, stacked on 46: `access_tokens`, migration `0018`, the token tools on `/mcp`, the settings panel, ADR 0010.

Checked before opening: typecheck, 609 app tests, the app build, and a real `claude -p` run using a token made in the UI against a dev server, which read the Board, created a Card, and moved one. Two runner tests fail on agent-pc only; see [the lesson](../lessons/runner-cli-tests-fail-on-agent-pc.md).

Unverified until deployed: migration `0017` setting every production Board's Sessions on, `/mcp` accepting a token through the Cloudflare tunnel, and the copied `claude mcp add` command working from the Admin's own machine.

Next action: the Admin merges 46. PRs are squash-merged, so 47 then needs `main` merged into it before it merges cleanly. After each deploy, confirm the production Boards still show Sessions on, then make a token on a Board with Sessions off and connect Claude Code with it.
Close when: both PRs are merged and a token has been used against production.
