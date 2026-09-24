# Runner-hosted previews

## minicore configuration

The production hostname configuration is:

- The app uses `https://kardboard.cc`.
- Preview URLs use `{card}.kardboard.cc`, where `{card}` is the first eight characters of the Card ID. `KARDBOARD_PREVIEW_HOST_PATTERN={card}.{domain}` selects this shape; the app derives `kardboard.cc` from its public URL.
- The `homelab` Cloudflare Tunnel routes `kardboard.cc` to `http://10.0.0.20:3070` and `*.kardboard.cc` to `http://10.0.0.20:3073`. The explicit `app.kardboard.cc` alias precedes the wildcard and reaches the app, which redirects it to the root domain.
- The apex and wildcard have proxied CNAME records pointing to the tunnel. Clerk's explicit DNS-only records override the wildcard.
- Cloudflare Universal SSL covers `kardboard.cc` and `*.kardboard.cc`. No paid certificate add-on is needed.
- The app and preview router share `KARDBOARD_PREVIEW_SECRET`. The runner uses `KARDBOARD_PREVIEW_NETWORK=kardboard_preview`; only preview containers and the preview router join that network.

Cloudflared's hostname matcher requires a `*.` prefix. Unknown hosts return 404 from the preview router. See [Cloudflare's wildcard DNS rules](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/) and [its hostname matcher](https://github.com/cloudflare/cloudflared/blob/master/ingress/ingress.go).

See [domain configuration](domains.md) for Clerk, Google sign-in, email, and the migration from xode.cc.

## Host changes

Compose reads values from `.env`; it does not execute shell commands in that file. Run `openssl rand -base64 32` in a terminal, then save its output as `KARDBOARD_PREVIEW_SECRET`. Saving `$(openssl rand -base64 32)` literally creates a predictable value instead. Do not print or commit the secret. Changing an existing secret signs open previews out.

Keep `deploy/compose.yaml` and `chriscorbell/stacks/kardboard/compose.yaml` aligned. Publish the stacks change, pull it on minicore, copy `deploy/.env` to `/home/chris/docker/stacks/kardboard/.env`, and run `docker compose up -d`. Watchtower updates images but does not apply Compose changes.

Check both `http://127.0.0.1:3070/healthz` and `http://127.0.0.1:3073/healthz` on minicore. Request an unused `https://<id>.kardboard.cc/` hostname: valid TLS followed by `No preview at this address.` confirms DNS and tunnel routing. It does not prove an image builds or a Member can sign in.

## Enable a Board

Set the Board's preview mode to `runner`. Its repository needs a root `Dockerfile` that starts a server on `$PORT`, currently 3000. This repository links that path to `packages/app/Dockerfile`; its health check uses the same port. The app starts with its own seeded database in dev authentication mode, behind the production preview router's membership gate. The preview container receives no production credentials or host mounts.

A Session pushes its branch and calls `request_preview`. The Card receives a URL while the image builds. A Member without a Preview cookie is redirected to kardboard to sign in. The router exchanges a single-use code for a host-only cookie and strips cookies and authorization headers before forwarding the request.

## Verification and limits

A temporary Member and preview were checked through the deployed app, public HTTPS tunnel, and preview router. The check verified the sign-in redirect, code exchange, Secure/HttpOnly/SameSite=Lax cookie without a Domain attribute, code replay rejection, removal of cookie and authorization headers, and revocation after membership removal. Temporary records and the header-check container were removed afterwards. This exercised membership authorization with a synthetic Member; it did not exercise a real Member's Clerk sign-in.

The router polls routes every 15 seconds. Membership revocation therefore takes effect on the next successful refresh. A failed refresh keeps the last routing table. A separate preview Docker network is verified, but access through the Docker host's published ports and other LAN services has not been audited.

Before the rebrand, the kardboard Board was switched to runner mode. Its runner cloned the branch for [PR 11](https://github.com/chriscorbell/kardboard/pull/11), built the root Dockerfile, and started a healthy preview on port 3000 with no host mounts or credential variables. Chris's existing Admin sign-in opened the preview in the browser and showed its separate demo database. [PR 12](https://github.com/chriscorbell/kardboard/pull/12) includes those build fixes and the rebrand. PR 12 merged and deployed as `f6b868b`; new branches inherit the root Dockerfile. The preview hostname moved to `mq729nev.kardboard.cc`.

On 2026-09-15 UTC, the rebrand branch for PR 12 rebuilt the same Card preview at `https://mq729nev.kardboard.cc`. Admin sign-in by email code on the new root followed by Preview access succeeded; the Preview displayed the lowercase wordmark and its separate demo data. Unknown hosts returned 404, and anonymous requests for this Preview redirected to the new root.

After deployment, a fresh authorization exchange still opened the Preview through the new backend origin restriction. Card mq729n then moved to Done and its Preview was removed. Its historical URL now returns 404; this is the expected lifecycle for a completed Card.
