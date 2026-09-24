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

2026-09-15 UTC: preview setup review for Card mq729n. Corrected the kardboard preview context note after enabling runner mode and observing a real build and Admin browser visit. Added the preview runbook and reconciled README, design, design-review status, operations notes, and the preview entries in the v1 work note. Host secret, Compose network wiring, Cloudflare DNS and tunnel routing were verified in production. The subsequent rebrand moved the app to `kardboard.cc` and previews to `{card}.kardboard.cc`; [domain configuration](../runbooks/domains.md) owns the verified setup. PR 12 includes PR 11 and deployed as `f6b868b` after Chris authorized the Admin override. All image publications passed. Live branding, authenticated app and Preview access, redirects, and Card closure were verified; the completed migration note was archived.

The ordinary sample began at `context/` entry 4. That preview note and the image/Compose lesson were already reconciled by the task, so the sample covered `context/provider-usage-limits-are-seen-in-the-proxy.md`, retained after reading provider-limits and egress 429/Map handling, verification date unchanged; `lessons/pnpm-11-build-approvals.md`, retained and date advanced after the acceptance command passed; and `lessons/session-token-cannot-push-workflow-files.md`, retained after checking the unchanged permission narrowing in github.ts. No category exceeds its threshold. The broader minicore inventory remains deferred; only the Docker socket claim was corrected to include kardboard's runner. Next cursor: `lessons/` entry 4.
