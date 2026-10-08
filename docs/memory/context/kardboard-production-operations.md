# Operating kardboard on minicore

Read when: deploying a change to production, merging a pull request on this repository, rotating a secret, reading the app's log, or inspecting the production database.
Status: verified
Scope: environment, minicore
Verified: 2026-10-07, while removing Sessions and moving the app to a plain port
Source: the deployment of 2026-09-14; the internal-rename cutover of 2026-09-24; the Sessions removal of 2026-10-07; `deploy/compose.yaml`; `hosts/minicore/stacks/kardboard/compose.yaml` in `chriscorbell/fleet`
Recheck when: the compose file moves, the app's log directory changes, or the app image stops bundling `@libsql/client`

- Every pull request on this repository is opened and merged by the Admin's own agent with `gh pr merge --squash`. The repository's `kardboard` ruleset requires a pull request but no approving review.
- Code deploys itself: push to `main`, CI publishes the app image when its inputs changed since the last successful run on `main`, and Watchtower restarts the app within a minute. A docs-only push publishes nothing, and a manual run on `main` publishes the image whatever changed. Pull requests build the image without pushing. Until 2026-10-07 the stack had four services and five images; see [the archive note](../archive/2026-09-24-internal-rename.md) for how the stack was moved by hand before.
- The stack's settings live in `/home/chris/docker/stacks/kardboard/.env` on minicore, mode 600, and change there, followed by `docker compose up -d` in that directory. That file is the only live copy; dated copies taken before each change sit in `~/.local/state/kardboard/` on minicore. Since 2026-10-07 it holds no secret, only `KARDBOARD_ADMIN_EMAIL`. The compose file itself is committed in `chriscorbell/fleet` under `hosts/minicore/stacks/kardboard/`, identical to `deploy/compose.yaml`; pull fleet on minicore (`ssh -A minicore 'git -C ~/fleet pull --ff-only'`) before `up -d`. `/home/chris/docker/stacks` is a symlink into that checkout.
- Production database: no `sqlite3` in the image. Query it with `docker compose exec app node -e` using `@libsql/client` against `file:/data/kardboard.db`.
- Health: `curl http://127.0.0.1:3071/healthz` on minicore and `docker compose ps` in the stack directory. The answer is 503 when the app cannot read its database. The app writes its console to `~/docker/data/kardboard/app/logs/app-YYYY-MM-DD.log`, kept 14 days and at most 200 MB a day, so a recreated container does not take its log with it. From any tailnet device: `http://minicore.saanen-monitor.ts.net:3071/healthz`. How the app is reached is in [the access runbook](../../runbooks/access.md).

Watchtower only follows image names already running. A change to image names, env keys, networks, or data paths needs the stack moved by hand, as on 2026-09-24 when every `cardboard` name became `kardboard`. Private environment and Compose backups from cutovers are under `~/.local/state/kardboard/` on minicore. These are recovery artifacts, not the current deploy configuration.
