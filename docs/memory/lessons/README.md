# Lessons

Verified failure mechanisms and corrections that change a future attempt. Search here when a symptom resembles a past failure.

One bullet per lesson, with a relative link and the symptom or task that should trigger reading it. A provisional lesson says "provisional" in its cue so a reader knows it is a hypothesis before relying on it. Update the matching lesson when evidence changes; [the note format](../note-format.md) states what a lesson records.

Threshold: 12 entries. Past it, the bounded review in [maintenance](../maintenance.md) samples this category first.

- [pnpm 11 build approvals](pnpm-11-build-approvals.md): read when `pnpm install` or `pnpm exec` fails with `ERR_PNPM_IGNORED_BUILDS`.
- [Docker image and compose gotchas](docker-image-and-compose-gotchas.md): read when a service image fails at boot with a missing module, a container takes 30 s to stop, an internal API call returns 401, or a compose environment value arrives mangled.
- [A Session cannot push a change to `.github/workflows/`](session-token-cannot-push-workflow-files.md): read when a push is refused for want of `workflows` permission, or before planning a workflow-file edit.
- [A Session's branch can conflict with `main` without the Session noticing](check-the-pull-request-merges-before-reporting.md): read before reporting a card ready, when resuming a card whose pull request is already open, or when no GitHub Actions run appears on a pull request head.
- [Dev auth hides client requests that carry no bearer token](dev-auth-hides-unauthenticated-client-requests.md): read when a client change loads from `/api` without `request()`, or when something works locally and returns 401 in production.
- [The Codex CLI drops flags and config keys between releases](codex-cli-drifts-between-releases.md): read when a Codex Session exits at once or reaches no provider, when editing the Codex branch of the entrypoint, or before bumping `CODEX_VERSION`.
