# Feature-gap stack

Status: active
Objective: land the feature-gap work, audited on 2026-09-24, as a stack of branches off `main` at `f989af0`, then carry out the Admin steps and observe the unverified parts in production.

Branches, each based on the one before, in merge order:

1. `kardboard/session-failures`: failure notices, Try again, waiting states, the batching cap, the stranded-Trigger pump, Board pause. Migration `0008`.
2. `kardboard/github-sync`: the pull request poll, CI summary and gate, Try merging again, the Review block. Migration `0009`.
3. `kardboard/agent-tools`: Preview SHA and rebuilds, MCP `update_card` and `preview_status`, child limits, the workflow prompt, blobless clones, per-Board caches, the 55-minute cap. Migration `0010`.
4. `kardboard/member-ux`: people, the Blocked callout, attachments, search and filters, email preferences, the explainer, comment delete. Migration `0011`.
5. `kardboard/admin-ops`: alerts, health checks, the app log file, usage and cost, the Sessions tab, off-disk backups, CI publishing only what changed. Migration `0012`.
6. `kardboard/review-fixes`: fixes from reviewing branches 1 to 5. Migrations from `0013`.
7. `kardboard/docs-feature-gaps`: documentation for all of it.

A branch merged with a squash leaves the next one carrying its commits; rebase the next onto `main` with `git rebase --onto main <previous-branch-tip> <next-branch>` before merging it. The full audit, with evidence, is in `.scratch/feature-gaps/audit-2026-09-24.md` (untracked).

Admin steps, all outside a Session's reach:

- Grant the Merge GitHub App Checks: Read and Commit statuses: Read, and approve the new permissions on each installation ([github-apps.md](../../../deploy/github-apps.md)). Without them a private repository's CI reads as unknown and never blocks.
- On minicore, `mkdir -p /nas/backup/minicore/kardboard && touch /nas/backup/minicore/kardboard/.kardboard-backup-target`, check uid 1000 can write there, then copy the `deploy/compose.yaml` changes (the backup bind, `KARDBOARD_BACKUP_COPY_DIR`, the four health checks) into `chriscorbell/stacks` and `docker compose up -d`.
- The agent image, the runner's cache volume mount, and the CI workflow change can only be proven after a merge.

Unverified until observed in production: the pull request poll against real GitHub, the checks read through the Merge app, Claude Code's `result` usage parsing, a per-Board cache volume on first use, a blobless clone merging the default branch, the app log file across a Watchtower recreate, and a copy to the NAS.

Next action: push the branches and open the stacked pull requests when the Admin asks, then merge in order.
Close when: every branch is merged, the Admin steps are done, and each unverified item has been observed or moved into the v1 gaps note.
