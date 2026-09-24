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
- [Decision records](../adr/): eight ADRs covering identity, credentials, egress, storage, the runner, Approval, GitHub tokens, and the two-app merge authority.
- [Design review](../design-review.md): eight findings against the design, dated 2026-09-13, with a status header saying which are resolved. Read before implementing Previews or child-Card dispatch; it does not supersede accepted decisions.
- [GitHub Apps guide](../../deploy/github-apps.md) and the [kardboard-onboard skill](https://github.com/chriscorbell/skills/tree/main/kardboard-onboard): how a repository is prepared for a board.
- [README](../../README.md): how to run, build, and deploy; the Status section says what is not built.

## Review record

2026-09-24 UTC, later: the feature-gap stack (branches `kardboard/session-failures` through `kardboard/docs-feature-gaps`, see [its work note](work/2026-09-24-feature-gaps-stack.md)). Reconciled by the task: `CONTEXT.md`, `docs/design.md`, ADR 0008, `AGENTS.md`'s image-build fact, the README, the backups and previews runbooks, the production operations, provider limits, and GitHub and MCP testing notes, and the v1 gaps note. The ordinary sample began at `context/` entry 2, already reconciled by the task, so it covered entries 3, 4, and 6: `context/client-side-tests.md` retained with the new pure client modules listed, `context/kardboard-runner-previews.md` retained after checking the agent image still installs no browser, and `context/testing-trigger-paths.md` retained with a line on the new batching cap, checked in `waiting.ts`. Entry 5 was reconciled by the task. No category exceeds its threshold. Next cursor: `context/` entry 7.
