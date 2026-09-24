# GitHub Apps for kardboard

kardboard uses two GitHub Apps with identical repository permissions and different trust. Sessions
receive one-hour tokens from the first and can push branches and open pull requests. Only the app
itself, on a recorded Approval, uses the second to merge. A branch ruleset on the default branch
requires a pull request with one approval and lists the merge app as its only bypass actor, so a
Session cannot merge its own work no matter what its prompt says. See ADR 0008.

## 1. Create the apps

Twice, at https://github.com/settings/apps/new (once per app):

| Field | kardboard-sessions | kardboard-merge |
| --- | --- | --- |
| GitHub App name | Kardboard (Sessions) | Kardboard (Merge) |
| Homepage URL | https://kardboard.cc | https://kardboard.cc |
| Webhook | Uncheck **Active** | Uncheck **Active**. kardboard polls instead: every two minutes, and once after it starts, it reads the pull request of every Card not in Done |
| Repository permissions | Contents: Read and write. Pull requests: Read and write. Metadata: Read. | Same, plus Workflows: Read and write, so kardboard can merge a pull request that touches `.github/workflows`, and Checks: Read and Commit statuses: Read, so it can see CI |
| Where can this app be installed | Any account | Any account |

kardboard reads CI with the merge app's token: check runs (GitHub Actions and most CI apps) need
**Checks: Read**, and older integrations that report commit statuses need **Commit statuses:
Read**. Both matter only for private repositories; a public repository's checks are readable
without them. The Card shows CI in its Review block, a Session reads it with the `get_checks` tool,
and Approve is refused while a check is failing unless the Admin chooses to merge anyway. Without
the permissions a private repository's checks read as unknown: the Card says nothing about CI to
Members (the Admin sees "GitHub did not say how the checks went"), `get_checks` answers `unknown`,
and Approve is never held back by CI. Since the merge app bypasses the branch ruleset, that gate is
the only thing standing between a red build and `main`, so grant both.

To add them to an existing app: the app's settings, **Permissions & events**, set both to
Read-only, and save. GitHub emails the owner of each account the app is installed on, who has to
approve the new permissions from the app's installation settings; until they do, that
installation keeps its old ones ([GitHub's guide](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app)).
kardboard reuses a merge token for up to ten minutes, so an approved change shows within that.

The Sessions app needs neither. Do not add Checks or Commit statuses to the permissions kardboard
requests for a Session token in `github.ts` unless every installation of the Sessions app has
been granted them first: GitHub refuses to mint a token that asks for a permission the
installation lacks, and every Session on that repository would then fail to start.

Adding a permission here does not widen what a Session can do. kardboard mints each Session token
with a fixed `{ contents: write, pull_requests: write, metadata: read }` (`mintInstallationToken`
in `packages/app/server/src/services/github.ts`), and an installation token can only narrow the
installation's permissions, never widen them. In particular no Session can push a change to
`.github/workflows/`, because GitHub requires `workflows: write` for that; such an edit is a job
for a human on the default branch.

"Any account" is required because installation is always performed by a repository's owner: a
client installs the apps on their own repository, which "Only on this account" would prevent. The
apps stay unlisted; only someone with the install link can add them.

After creating each app: note the **App ID** on its settings page, then **Generate a private key**
and keep the downloaded `.pem`. Store both with:

```bash
deploy/add-github-key.sh sessions <app id> ~/Downloads/kardboard-sessions.<date>.private-key.pem
deploy/add-github-key.sh merge <app id> ~/Downloads/kardboard-merge.<date>.private-key.pem
```

If you named the apps differently, set `GITHUB_SESSIONS_APP_SLUG` and `GITHUB_MERGE_APP_SLUG` in
`deploy/.env` to the app slugs (the URL name). Commits from Sessions appear as `<slug>[bot]`.

## 2. Install both apps on each project repository

From each app's settings page, **Install App**, pick the account, choose **Only select
repositories**, and select the repository. A client-owned repository works the same way once the
client installs both apps on it. The board settings dialog in the admin panel shows whether each
app is installed on the board's repository.

## 3. Protect the default branch

In the repository: Settings, Rules, Rulesets, **New branch ruleset**.

- Name: `kardboard`, enforcement **Active**, target **Default branch**.
- Bypass list: add the **Kardboard (Merge)** app, mode **Always**.
- Rules: **Require a pull request before merging** with **Required approvals: 1**. Leave
  "Dismiss stale approvals" on. Optionally **Block force pushes** and **Restrict deletions**.

With that ruleset, `kardboard-sessions[bot]` can push branches and open pull requests but every
merge attempt from it fails, while the app's own merge on Approval succeeds through the bypass.

On a client-owned repository the client creates this ruleset, or grants you admin on the
repository so you can. Until it exists, the Sessions token could merge, so treat the ruleset as
part of onboarding a Board, not an optional extra.

## 4. Deploy

Copy `deploy/.env` to minicore and recreate the app service:

```bash
scp deploy/.env minicore:/home/chris/docker/stacks/kardboard/.env
ssh minicore 'cd ~/docker/stacks/kardboard && docker compose up -d app'
```
