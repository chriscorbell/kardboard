# Operating kardboard on minicore

Read when: deploying a change to production, rotating a secret, reading a Session's log, or inspecting the production database.
Status: verified
Scope: environment, minicore
Verified: 2026-09-14
Source: the deployment and Session runs of 2026-09-14; `deploy/compose.yaml`; `~/Code/stacks/kardboard/compose.yaml`
Recheck when: the compose file moves, the runner's log directory changes, the agent entrypoint's output format changes, or the app image stops bundling `@libsql/client`

- Code deploys itself: push to `main`, CI publishes five images, Watchtower restarts the four services within a minute. Every push rebuilds all five images, so every service restarts on every push.
- Secrets never leave `deploy/.env` on mbp except by `scp deploy/.env minicore:/home/chris/docker/stacks/kardboard/.env` followed by `docker compose up -d` in that directory. The compose file itself is committed in `chriscorbell/stacks` under `kardboard/`; `git pull` there before `up -d`.
- Session logs: `~/docker/data/kardboard/runner/logs/<session id>.log` on minicore, kept 14 days. Since 2026-09-14 the agent entrypoint runs Claude Code with `--output-format stream-json --verbose`, so the log fills line by line during the run; before that it held only the clone and start lines until exit. The admin panel reads the same file through the runner's `GET /sessions/:id/log`, so SSH is no longer the only way in.
- Production database: no `sqlite3` in the image. Query it with `docker compose exec app node -e` using `@libsql/client` against `file:/data/kardboard.db`.
- Service health: `curl http://127.0.0.1:3070/healthz` on minicore, `docker compose ps` in the stack directory. Public check: `https://kardboard.cc/healthz`. The current hostnames, Clerk, and email configuration are in [domain configuration](../../runbooks/domains.md).
- Session containers carry the label `kardboard.session=<id>`; `docker ps -a --filter label=kardboard.session` lists them. The runner removes them after exit.

Preview host configuration and verification are recorded in [the preview runbook](../../runbooks/previews.md). Watchtower applies image updates only; applying PR 10 required separately updating the stacks Compose file to create `kardboard_preview` and wire the app secret and hostname pattern.

The domain migration deployed as `f6b868b` on 2026-09-15 UTC. Before cutover, snapshot `kardboard-20260915T032551Z.db` was verified. Private environment backups are under `~/.local/state/kardboard/` on mbp and minicore. These are recovery artifacts, not the current deploy configuration.
