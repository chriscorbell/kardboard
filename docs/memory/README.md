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
- [Design](../design.md): the agreed design after the 2026-10-07 refocus on one person's Boards, with links to the decision records and a Status section of what is not built yet.
- [Decision records](../adr/): twelve ADRs. 0011 (kardboard is one person's Board, worked by their own agents; no Sessions) and 0012 (one Access token reaches every Board) are current and supersede 0002, 0003, and 0005 to 0010; 0001 (identity) and 0004 (SQLite) still hold.
- [Design review](../design-review.md): eight findings against the v1 design, dated 2026-09-13, all about Sessions; superseded by ADR 0011 and kept as history.
- The [kardboard-onboard skill](https://github.com/chriscorbell/skills/tree/main/kardboard-onboard): how an agent is connected to kardboard and a project onboarded.
- [README](../../README.md): how to run, build, and deploy; the Status section says what is not built.

## Review record

2026-10-05 UTC: renamed the Inbox column to Backlog as a label only (PR 84). Reconciled by the task: `CONTEXT.md`, the design, and the README; `lessons/runner-cli-tests-fail-on-agent-pc.md` re-observed and its date refreshed. The ordinary sample continued at `lessons/` entry 4 and covered entries 4 to 6: `lessons/check-the-pull-request-merges-before-reporting.md` corrected, since a repository whose ruleset requires no approving review reads `CLEAN`, not `BLOCKED` (PR 84); `lessons/dev-auth-hides-unauthenticated-client-requests.md` retained after checking that `resolveUser` reads only the bearer header and the `/events` query token; `lessons/codex-cli-drifts-between-releases.md` retained after checking `CODEX_VERSION` 0.154.0 and the Codex entries in `ALLOWED_CALLS`. No category exceeds its threshold. Next cursor: `lessons/` entry 7.
