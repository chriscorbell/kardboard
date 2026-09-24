# Internal rename from cardboard to kardboard

Status: complete
Release: [PR 16](https://github.com/chriscorbell/kardboard/pull/16), merged as `f8bd363` on `main`.
Source: Chris's 2026-09-24 request to correct every remaining `cardboard` reference and ship autonomously.
Close when: no live code, configuration, deployment, or integration name says `cardboard`, and production runs on the new names.

## What changed

The 2026-09-15 rebrand renamed the product and the domain but kept internal names for compatibility. This pass renamed the rest: `@kardboard/*` packages, `KARDBOARD_*` environment variables, `ghcr.io/chriscorbell/kardboard-*` images, the `kardboard` Compose project with `kardboard_control`, `kardboard_workload`, and `kardboard_preview` networks, `kardboard.*` Docker labels and container names, `kardboard.db` and `kardboard-<stamp>.db` snapshots, the `kardboard` MCP server name, the `kardboard/` Session branch prefix, the `kardboard_preview` cookie, and the `/__kardboard/auth` preview path.

Deliberately kept: `cardboard.xode.cc` in `KARDBOARD_REDIRECT_HOSTS`, which is a real legacy hostname that still redirects; the branch and Card of the open [PR 14](https://github.com/chriscorbell/kardboard/pull/14), whose Card stores that branch name; branch names recorded on finished Cards; and dated records under `archive/` and `history/`.

## Production cutover, 2026-09-24 UTC

- New GHCR packages inherited the public repository's visibility; anonymous manifest pulls returned 200 for all five before cutover.
- With no Session or Preview container present, the old stack was stopped, `~/docker/data/cardboard` moved to `~/docker/data/kardboard`, the database and eleven snapshots renamed, and the stack folder moved to `~/docker/stacks/kardboard` through [chriscorbell/stacks](https://github.com/chriscorbell/stacks) commit `7bb18be`. That Compose copy had also been missing PR 13's `cbnprev` bridge and per-session setting.
- `deploy/.env` keys were renamed on mbp and copied to minicore. A duplicate `PREVIEW_SECRET` line was dropped after its hash showed it was not the value the app was using; the live value was kept. `KARDBOARD_CODEX_AUTH_FILE` now points at the moved secrets folder.
- The kardboard Board's slug changed from `cardboard` to `kardboard`, so older `/b/cardboard/...` links no longer resolve.
- Public health, the legacy 308 redirect, and the preview router's 404 for an unknown host were checked after startup. A verification Card on the kardboard Board ran a real Session on the new agent image and its own `kardboard-session-<id>` network. The Session reached all eleven `kardboard` MCP tools and ran `git ls-remote` against the renamed repository. The Card was then closed.
- The `cardboard` rulesets on `chriscorbell/kardboard` and `chriscorbell/kino` were renamed in place to `kardboard`. The [kardboard-onboard skill](https://github.com/chriscorbell/skills/tree/main/kardboard-onboard) now creates a `kardboard` ruleset and describes the `kardboard/` branch prefix.
- The LAN isolation rule from PR 13 had never been applied on minicore. It was applied, verified, and persisted with a systemd unit; see [the network isolation runbook](../../runbooks/network-isolation.md).

## Recovery

The pre-cutover `.env` and Compose file are `pre-internal-rename.env` and `pre-internal-rename-compose.yaml` under `~/.local/state/kardboard/` on minicore. mbp has the `.env` copy only. The old `cardboard-*` images were removed from minicore, but their GHCR packages still exist. Rolling back means restoring those two files into `~/docker/stacks/cardboard`, reversing the folder and file renames, and running `docker compose up -d`.

## Left for Chris

- The Sandbox Board still points at `https://github.com/chriscorbell/cardboard-sandbox`, which no longer exists on GitHub.
- The old `cardboard-*` GHCR packages can be deleted once the rollback path is no longer wanted.
- The local checkout is still at `~/Code/cardboard`, which also names this machine's Claude project folder.
