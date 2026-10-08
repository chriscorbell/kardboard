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
- [Decision records](../adr/): thirteen ADRs. 0011 (kardboard is one person's Board, worked by their own agents; no Sessions), 0012 (one Access token reaches every Board), and 0013 (reached over Tailscale, which is the sign-in) are current and supersede 0001 to 0003 and 0005 to 0010; 0004 (SQLite) still holds.
- [Design review](../design-review.md): eight findings against the v1 design, dated 2026-09-13, all about Sessions; superseded by ADR 0011 and kept as history.
- The [kardboard-onboard skill](https://github.com/chriscorbell/skills/tree/main/kardboard-onboard): how an agent is connected to kardboard and a project onboarded.
- [README](../../README.md): how to run, build, deploy, and connect agents.
- [Tailscale runbook](../runbooks/tailscale.md): how the app is reached and signed in to.

## Review record

2026-10-07 UTC: the refocus on one person's Boards (ADRs 0011 and 0012, PRs 86 to 92) reconciled `CONTEXT.md`, the design, the design review, the README, `AGENTS.md`, the backups and domains runbooks, every context note, and lessons 1 to 5; retired the notes about Sessions, Previews, the runner, Codex, provider limits, Trigger tests, and the get_checks test; archived `work/2026-09-14-v1-gaps.md` and `work/2026-10-07-personal-board-refocus.md`. The ordinary sample found `lessons/` entry 7 gone and `work/` holding only a note the task reconciled, so it wrapped to `context/` and took the three notes the task had not touched: `context/client-side-tests.md` corrected (its examples listed modules deleted with Sessions and Mentions; checked against `packages/app/client/test`); `context/previewing-the-client-locally.md` corrected and re-verified by running its command on agent-pc, with the headless-screenshot finding added; `context/claude-github-workflows.md` retained after checking that both workflows still pin `claude-code-action` v1.0.238. No category exceeds its threshold. Next cursor: `work/` entry 1.
