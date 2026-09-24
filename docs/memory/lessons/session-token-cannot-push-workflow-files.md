# A Session cannot push a change to `.github/workflows/`

Read when: a push is rejected with `refusing to allow a GitHub App to create or update workflow .github/workflows/<file> without workflows permission`, or when a task would edit a workflow file.

Status: verified
Scope: every kardboard board, because the limit is in kardboard's own token minting
Verified: 2026-09-15
Source: [`packages/app/server/src/services/github.ts`](../../../packages/app/server/src/services/github.ts), `mintInstallationToken`; the quoted permission line re-read there on 2026-09-15 and unchanged
Recheck when: the `permissions` object in `mintInstallationToken` changes, or a board's Sessions App installation changes its permissions.

Symptom: `git push` fails with the message above and no commit reaches the branch. The rejection is GitHub's, not the ruleset's; nothing in the repository can relax it.

Cause, in two layers. GitHub refuses any push from a GitHub App that creates or updates a workflow file unless the pushing token carries `workflows: write`. kardboard mints each Session token with a fixed permission set:

```ts
const body: Record<string, unknown> = { repositories: [repo] };
if (kind === "sessions") body.permissions = { contents: "write", pull_requests: "write", metadata: "read" };
```

An installation access token can only narrow the installation's permissions, never widen them, so a Session token never carries `workflows` however the Sessions App is configured. Granting the App the permission is therefore necessary but not sufficient: it was granted on the kardboard board on 2026-09-14 and two pushes minutes later were still rejected with the same message. A newly added App permission also has to be accepted on each installation before it takes effect, which is a second thing to check before concluding the code is at fault.

What works: a human with write access edits the workflow file directly on the default branch, or in a branch of their own. That keeps Session tokens narrow, which is the point of [ADR 0008](../../adr/0008-two-github-apps-for-merge-authority.md): widening them to `workflows: write` would let any Session write a job that runs on `main` with the repository's secrets.

The merge side is no longer symmetric: `mintInstallationToken` sends no `permissions` field for `kind === "merge"`, so the merge token takes everything the Merge App installation holds, and a pull request touching a workflow file can be merged once that App is granted `workflows: write`. Unobserved in practice — no workflow change has reached a pull request on this board.

Plan around it: keep workflow edits out of a Session's branch entirely. Put the exact file and line in a Card for the Admin instead, and say in the pull request that the workflow half is not included.
