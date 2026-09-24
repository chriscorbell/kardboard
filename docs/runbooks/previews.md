# Runner-hosted previews

## minicore configuration

The production hostname configuration is:

- The app uses `https://kardboard.cc`.
- Preview URLs use `{card}.kardboard.cc`, where `{card}` is the first eight characters of the Card ID. `KARDBOARD_PREVIEW_HOST_PATTERN={card}.{domain}` selects this shape; the app derives `kardboard.cc` from its public URL.
- The `homelab` Cloudflare Tunnel routes `kardboard.cc` to `http://10.0.0.20:3070` and `*.kardboard.cc` to `http://10.0.0.20:3073`. The explicit `app.kardboard.cc` alias precedes the wildcard and reaches the app, which redirects it to the root domain.
- The apex and wildcard have proxied CNAME records pointing to the tunnel. Clerk's explicit DNS-only records override the wildcard.
- Cloudflare Universal SSL covers `kardboard.cc` and `*.kardboard.cc`. No paid certificate add-on is needed.
- The app and preview router share `KARDBOARD_PREVIEW_SECRET`. The runner uses `KARDBOARD_PREVIEW_NETWORK=kardboard_preview`, the network the preview router lives on. Each Preview gets a network of its own, `kardboard_preview_<previewId>`, shared only with the router; see [network isolation](network-isolation.md#one-network-per-preview).

Cloudflared's hostname matcher requires a `*.` prefix. Unknown hosts return 404 from the preview router. See [Cloudflare's wildcard DNS rules](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/) and [its hostname matcher](https://github.com/cloudflare/cloudflared/blob/master/ingress/ingress.go).

See [domain configuration](domains.md) for Clerk, Google sign-in, email, and the migration from xode.cc.

## Host changes

Compose reads values from `.env`; it does not execute shell commands in that file. Run `openssl rand -base64 32` in a terminal, then save its output as `KARDBOARD_PREVIEW_SECRET`. Saving `$(openssl rand -base64 32)` literally creates a predictable value instead. Do not print or commit the secret. Changing an existing secret signs open previews out.

Keep `deploy/compose.yaml` and `chriscorbell/stacks/kardboard/compose.yaml` aligned. Publish the stacks change, pull it on minicore, copy `deploy/.env` to `/home/chris/docker/stacks/kardboard/.env`, and run `docker compose up -d`. Watchtower updates images but does not apply Compose changes.

Check both `http://127.0.0.1:3070/healthz` and `http://127.0.0.1:3073/healthz` on minicore. Request an unused `https://<id>.kardboard.cc/` hostname: valid TLS followed by `No preview at this address.` confirms DNS and tunnel routing. It does not prove an image builds or a Member can sign in.

## Enable a Board

Set the Board's preview mode to `runner`. Its repository needs a root `Dockerfile` that starts a server on `$PORT`, currently 3000. This repository links that path to `packages/app/Dockerfile`; its health check uses the same port. The app starts with its own seeded database in dev authentication mode, behind the production preview router's membership gate. Dev mode is refused anywhere else the image runs with `NODE_ENV=production`; the app allows it here because the runner sets `KARDBOARD_PREVIEW_HOST` on every Preview container, and a Preview needs no `KARDBOARD_AUTH`. The preview container receives no production credentials or host mounts.

A Session pushes its branch and calls `request_preview`. The Card receives a URL while the image builds, and the Session follows the build with `preview_status`, which reports the status, the commit built, and for a failed build its error and the end of the build log. The card sheet shows the same status beside the link: building, failed with the error one click away, or running, marked "Older commit" when the build is of a different commit than the pull request head the Card shows. A Member without a Preview cookie is redirected to kardboard to sign in. The router exchanges a single-use code for a host-only cookie and strips cookies and authorization headers before forwarding the request. Code on one Preview can still set a `kardboard_preview` cookie for all of `kardboard.cc` from JavaScript, so the router tries every cookie of that name until one verifies, and it strips `Domain` from the cookies a Preview's responses set and drops any carrying that name. After sign-in it returns the Member only to a path on the same Preview host.

## Builds

The runner builds with Docker's classic builder, named explicitly, because BuildKit ignores a custom network and would run `RUN` steps on `docker0`, which the host firewall's `cbn*` rule does not cover. `RUN` steps join the Preview's own network, so they reach the internet and nothing on the LAN or the stack. A build gets the Preview's CPU limit (`KARDBOARD_PREVIEW_NANO_CPUS`) and a memory ceiling of its own, `KARDBOARD_PREVIEW_BUILD_MEMORY_BYTES`, 2 GiB by default, because installing and compiling needs more than serving: this repository's app build peaked near 0.7 GiB in its largest process when measured on 2026-09-24.

A build that runs longer than `KARDBOARD_PREVIEW_BUILD_TIMEOUT_MINUTES`, 15 by default, counting from the clone, is stopped and the Preview fails with `the build took longer than 15 minutes and was stopped`. Only one build runs per Preview: a new `request_preview` stops the one in flight and replaces it, and removing a Preview stops its build. After a rebuild starts its container, the image it replaced is removed.

The runner reports each build's outcome with the commit it cloned, stored as the preview row's `sha`, and retries that report for about a minute, as it does a Session's exit. A rebuild does not take a working Preview away: the router keeps proxying to the previous container until the new one replaces it, and shows the holding page only when there is nothing to serve, or the error page when the build failed. A failed rebuild leaves the previous container running, but the router shows the failure.

A build lives only in the runner's memory, so a runner restart, which every deploy causes, loses the builds in flight. When the runner starts it tells the app when, and the app marks every Preview still building from before then as failed, with an error saying the build was interrupted and the preview should be requested again. As a backstop the app also fails any Preview still building five minutes past the build limit, checked at boot and every five minutes. The app reads the limit from the same `KARDBOARD_PREVIEW_BUILD_TIMEOUT_MINUTES`, so if it is ever changed, set it on both the app and the runner.

What a build can still do that a running Preview cannot:

- **Fetch from the host's network.** `ADD <url>` is downloaded by the Docker daemon itself, not by a build container, so it is not on the Preview's bridge and the firewall rule does not apply. A Dockerfile can `ADD http://10.0.0.1/...` and bake a LAN service's reply into its image. This is open; closing it needs a builder that runs outside the daemon, such as a `buildkitd` container on a `cbn` bridge.
- **Keep Docker's default capabilities.** The build API has memory and CPU limits but no pids limit, capability drop, or `no-new-privileges`, so `RUN` steps run with the defaults a plain `docker run` gets.
- **Depend on a deprecated builder.** Docker marks the classic builder deprecated. If an Engine upgrade removes it, builds fail outright rather than moving off the Preview network.

## Verification and limits

A temporary Member and preview were checked through the deployed app, public HTTPS tunnel, and preview router. The check verified the sign-in redirect, code exchange, Secure/HttpOnly/SameSite=Lax cookie without a Domain attribute, code replay rejection, removal of cookie and authorization headers, and revocation after membership removal. Temporary records and the header-check container were removed afterwards. This exercised membership authorization with a synthetic Member; it did not exercise a real Member's Clerk sign-in.

The router polls routes every 15 seconds. Membership revocation therefore takes effect on the next successful refresh. A failed refresh keeps the last routing table. A separate preview Docker network is verified; LAN and host access from it is dropped by the host firewall, verified on 2026-09-24 in [network isolation](network-isolation.md). The per-Preview networks and the build limits have not yet run on minicore.

Before the rebrand, the kardboard Board was switched to runner mode. Its runner cloned the branch for [PR 11](https://github.com/chriscorbell/kardboard/pull/11), built the root Dockerfile, and started a healthy preview on port 3000 with no host mounts or credential variables. Chris's existing Admin sign-in opened the preview in the browser and showed its separate demo database. [PR 12](https://github.com/chriscorbell/kardboard/pull/12) includes those build fixes and the rebrand. PR 12 merged and deployed as `f6b868b`; new branches inherit the root Dockerfile. The preview hostname moved to `mq729nev.kardboard.cc`.

On 2026-09-15 UTC, the rebrand branch for PR 12 rebuilt the same Card preview at `https://mq729nev.kardboard.cc`. Admin sign-in by email code on the new root followed by Preview access succeeded; the Preview displayed the lowercase wordmark and its separate demo data. Unknown hosts returned 404, and anonymous requests for this Preview redirected to the new root.

After deployment, a fresh authorization exchange still opened the Preview through the new backend origin restriction. Card mq729n then moved to Done and its Preview was removed. Its historical URL now returns 404; this is the expected lifecycle for a completed Card.
