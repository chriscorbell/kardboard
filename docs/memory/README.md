# Workspace memory

Read this index and [the protocol](protocol.md) when starting or resuming a session. Load topic notes only when their retrieval cue matches the task.

| When needed | Read |
| --- | --- |
| Workspace constraints, non-obvious structure, or recurring procedures | [Context](context/README.md) |
| A failure, gotcha, or previously corrected assumption | [Lessons](lessons/README.md) |
| Continuing unfinished work | [Work](work/README.md) |
| Writing or updating a memory note | [Note format](note-format.md) |
| Deciding which document owns a fact, whether a change owes a documentation edit, or repairing `AGENTS.md` | [Document maintenance](documents.md) |
| Finish step 4, a category over its threshold, or a requested memory review | [Bounded review](maintenance.md) |
| Several agents writing memory at once | [Concurrency](concurrency.md) |

## Canonical project documents

- [CONTEXT.md](../../CONTEXT.md): the glossary. Terms are used with these meanings everywhere.
- [Design](../design.md): the agreed v1 design, dated 2026-09-13, with links to the decision records.
- [Decision records](../adr/): ten ADRs covering identity, credentials, egress, storage, the runner, Approval, GitHub tokens, the two-app merge authority, Sessions as a per-Board choice, and Access tokens.
- [Design review](../design-review.md): eight findings against the design, dated 2026-09-13, with a status header saying which are resolved. Read before implementing Previews or child-Card dispatch; it does not supersede accepted decisions.
- [GitHub Apps guide](../../deploy/github-apps.md) and the [kardboard-onboard skill](https://github.com/chriscorbell/skills/tree/main/kardboard-onboard): how a repository is prepared for a board.
- [README](../../README.md): how to run, build, and deploy; the Status section says what is not built.

## Review record

2026-09-28 UTC: made Sessions a per-Board choice and added Access tokens (PRs 46 and 47). Reconciled by the task: `CONTEXT.md`, the design, the README, ADRs 0009 and 0010; `context/testing-trigger-paths.md` corrected for Boards inserted without Sessions; `context/testing-github-and-mcp-paths.md` extended to the token path; the new lesson `lessons/runner-cli-tests-fail-on-agent-pc.md` (provisional) and work note `work/2026-09-28-sessions-opt-in-and-access-tokens.md`, closed on 2026-09-29 once a token had been used against production. The ordinary sample continued at `lessons/` entry 1 and covered entries 1 to 3: `lessons/pnpm-11-build-approvals.md` retained after checking `allowBuilds` in `pnpm-workspace.yaml` and `verify-deps-before-run=false` in `.npmrc`; `lessons/docker-image-and-compose-gotchas.md` retained after checking that `packages/app/Dockerfile` copies the whole `packages/shared` directory and that compose sets `init: true`; `lessons/session-token-cannot-push-workflow-files.md` retained after checking the Sessions token permissions in `mintInstallationToken`. No category exceeds its threshold. Next cursor: `lessons/` entry 4.
