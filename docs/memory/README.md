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

2026-09-25 UTC: pinned the Claude code review workflow to Opus 5.5 at xhigh effort. Reconciled by the task: the new note `context/claude-github-workflows.md`; the README does not describe the Claude workflows, so it owes no edit. The ordinary sample continued at `context/` entry 7 and covered entries 7, 8, and 10, skipping the new entry 9: `context/testing-trigger-paths.md` retained after checking the unref'd dispatch timer, the coalesce and cap defaults, and the exported `runner` object, though not which function owns the other unref'd timers; `context/testing-github-and-mcp-paths.md` retained after checking `githubAppEnv` and its use in the approval and reconcile tests, with the MCP and REST claims unchecked; `context/session-network-isolation.md` retained after checking the bridge and network naming and the peer skip in `networks.ts`, with the `PEER_GW_PRIORITY` value, where `kardboard_workload` membership is read, and the minicore firewall unit unchecked. No category exceeds its threshold. Next cursor: `lessons/` entry 1.
