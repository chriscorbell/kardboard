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

2026-09-24 UTC: internal rename from `cardboard` to `kardboard` (PR 16), its production cutover, and the persisted LAN isolation rule (PR 17). Reconciled by the task: README, domains and network isolation runbooks, the operations and network isolation context notes, the v1 gaps work note, and a new archive note for the cutover. The ordinary sample began at `lessons/` entry 4. `lessons/check-the-pull-request-merges-before-reporting.md` was retained after checking that a Session's `--depth` clone is single-branch, and its date advanced. `lessons/codex-cli-drifts-between-releases.md` was retained after checking the pinned `CODEX_VERSION` and the entrypoint flags, and its date advanced. `work/` entry 1 was already reconciled by the task, so the sample wrapped to `context/` entry 1. `context/minicore-deployment-constraints.md` was corrected: the Hermes stack was removed from `chriscorbell/stacks`, port 7359 and kardboard's 3073 were added to the port list, and `ufw` is still inactive. No category exceeds its threshold. Next cursor: `context/` entry 2.
