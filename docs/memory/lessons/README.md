# Lessons

Verified failure mechanisms and corrections that change a future attempt. Search here when a symptom resembles a past failure.

One bullet per lesson, with a relative link and the symptom or task that should trigger reading it. A provisional lesson says "provisional" in its cue so a reader knows it is a hypothesis before relying on it. Update the matching lesson when evidence changes; [the note format](../note-format.md) states what a lesson records.

Threshold: 12 entries. Past it, the bounded review in [maintenance](../maintenance.md) samples this category first.

- [pnpm 11 build approvals](pnpm-11-build-approvals.md): read when `pnpm install` or `pnpm exec` fails with `ERR_PNPM_IGNORED_BUILDS`.
- [Docker image and compose gotchas](docker-image-and-compose-gotchas.md): read when a service image fails at boot with a missing module, a container takes 30 s to stop, an internal API call returns 401, or a compose environment value arrives mangled.
- [A branch can conflict with `main` without the agent noticing](check-the-pull-request-merges-before-reporting.md): read before reporting a card ready, when resuming a card whose pull request is already open, or when no GitHub Actions run appears on a pull request head.
- [Parallel pull requests conflict in `docs/design.md`](parallel-prs-conflict-in-design-md.md): read when preparing several pull requests at once, or when a rebase stops on `docs/design.md`.
