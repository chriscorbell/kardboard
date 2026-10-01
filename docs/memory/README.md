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

2026-09-30 UTC: a security review and hardening pass, PRs 63 to 77, tracked on card vfkfpnrx with the open findings kept there rather than in this public repository. Reconciled by the task: the design, README, previews and domains runbooks, `.env.example` files and compose file in the PRs themselves; `context/claude-github-workflows.md` corrected for the pinned action and Dependabot; `context/kardboard-production-operations.md` and `lessons/codex-cli-drifts-between-releases.md` corrected for the 24-hour CLI cooldown; `context/provider-usage-limits-are-seen-in-the-proxy.md` corrected for turn-only 429s; `context/client-side-tests.md` extended; the new lesson `lessons/parallel-prs-conflict-in-design-md.md` and work note `work/2026-09-30-security-hardening.md`. The ordinary sample continued at `lessons/` entry 4 and covered entries 4, 5, and 7, entry 6 being reconciled by the task: `lessons/check-the-pull-request-merges-before-reporting.md` retained and extended with the `UNKNOWN` state seen while merging the PRs; `lessons/dev-auth-hides-unauthenticated-client-requests.md` retained after checking `resolveUser` in `auth.ts`; `lessons/runner-cli-tests-fail-on-agent-pc.md` retained, still provisional, the same two failures observed on every branch of the pass. No category exceeds its threshold. Next cursor: `lessons/` entry 8.
