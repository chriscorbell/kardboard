# minicore deployment constraints for kardboard

Read when: deploying, exposing, or wiring kardboard's compose stack on minicore, or choosing a host port.
Status: verified
Scope: environment, minicore
Verified: 2026-09-24
Source: read-only SSH inspection of minicore on 2026-09-13, ports and `ufw` rechecked 2026-09-24, and `~/Code/fleet/AGENTS.md`, `~/Code/stacks/*/compose.yaml`
Recheck when: `chriscorbell/stacks` gains a shared network, proxy, database, or object store, or the Cloudflare Tunnel switches from token to file configuration

Facts that took a full fleet survey to establish and that `~/Code/fleet` does not state outright:

- Public exposure is only the token-based Cloudflare Tunnel in `stacks/cloudflared`. Ingress rules live in the Cloudflare dashboard and target minicore's LAN IP `10.0.0.20` plus a published host port. Adding a hostname is a dashboard change, not a file edit.
- No shared Postgres, Redis, MinIO, reverse proxy, or shared Docker network exists. Every stack uses its own default bridge and bind mounts under `/home/chris/docker/data/<stack>`.
- At the initial survey, only Watchtower mounted the Docker socket; kardboard's runner now also mounts it. Watchtower watches every container by default, polls every 60 s, and revives stopped containers, so ephemeral containers need the opt-out label `com.centurylinklabs.watchtower.enable: "false"`.
- Host ports in use: 3050, 3060, 3147, 3834, 4533, 5030, 7359, 8080, 8096, 8409, 8443, 8554, 8555, 8971, 25565, 50300. kardboard takes 3070 for the app and 3073 for the preview router.
- `ufw` is inactive; every published port is open on the LAN. The only host firewall rules kardboard adds are the `kardboard-lan-isolation` ones, which restrict Session and Preview bridges and nothing else; see [the network isolation runbook](../../runbooks/network-isolation.md).
- Canonical CI workflow to copy: `chriscorbell/invox` `.github/workflows/ci.yml` (validate job, then publish to GHCR `:latest` and `:sha` on push to `main`). Source repos of the other GHCR images are not cloned on mbp.
- Compose file changes are manual: commit to `chriscorbell/stacks`, then `git pull` and `docker compose up -d` on minicore.
