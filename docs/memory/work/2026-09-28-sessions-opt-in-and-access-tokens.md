# Sessions opt-in per Board, and Access tokens for the Admin's own agent

Status: active
Objective: let the Admin work a Board from their own local coding agent, with kardboard starting nothing on it, as asked on 2026-09-28. Sessions become an opt-in Board setting, off for a new Board; an Access token lets an outside agent act as the Agent on a Board without them.

- [PR 46](https://github.com/chriscorbell/kardboard/pull/46), branch `sessions-opt-in-per-board`: the setting, migration `0017` (existing Boards migrated on), ADR 0009.
- [PR 47](https://github.com/chriscorbell/kardboard/pull/47), branch `access-tokens-for-local-agents`, stacked on 46: `access_tokens`, migration `0018`, the token tools on `/mcp`, the settings panel, ADR 0010.

Checked before opening: typecheck, 609 app tests, the app build, and a real `claude -p` run using a token made in the UI against a dev server, which read the Board, created a Card, and moved one. Two runner tests fail on agent-pc only; see [the lesson](../lessons/runner-cli-tests-fail-on-agent-pc.md).

Merged and deployed on 2026-09-29 UTC as `85ab336` (PR 46) and `a92e5b2` (PR 47). Observed on minicore: each migration ran after its own pre-migration snapshot, copied to the NAS; the kardboard, kino, and ptsblite Boards all read `sessions_enabled = 1` with no pending Trigger; `access_tokens` exists and is empty; the public `https://kardboard.cc/mcp` answers 401 to an unknown `kbat_` token and to an unknown Session token.

Still unobserved: an Access token used against production, and the copied `claude mcp add` command working from the Admin's own machine.

The Admin set the `kardboard` ruleset on this repository to require no approving review on 2026-09-29, and settled what that means the same day: the kardboard Board will run without Sessions, worked by the Admin's local agent, which opens and merges the pull requests. Recorded in [the production operations note](../context/kardboard-production-operations.md) with what to restore before Sessions return to that Board.

Next action: the Admin turns Sessions off in the kardboard Board's settings (production showed them on after the deploy), makes a token there, and runs the copied command in the project folder on the Mac.
Close when: a token has been used against production.
