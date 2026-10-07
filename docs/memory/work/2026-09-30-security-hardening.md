# Security hardening pass

Status: active
Objective: a whole-system security review of kardboard and its deployment, with every code fix shipped and every remaining change that needs the Admin decided.
Branch: `main`; the work merged as PRs 63 to 82.
Plan and findings: card vfkfpnrx, "Security review and hardening pass across the app and its deployment", on the kardboard board. The findings still open stay on that card, out of this public repository, until they are fixed.

Shipped on 2026-09-30, each verified by CI and, where it could be, in production:
- #64 attachments never render as documents; #65 security headers, then #75 enforcing the page's script policy after no violation showed on kardboard.cc or a signed-in production build.
- #67 event streams close on lost access, constant-time internal tokens, 1 MB body limits; #72 per-Session write caps and an hourly per-person email cap; #70 Approve and merge only into the default branch, https-only Session links, no co-Member emails for Members; #73 sign-in links only a verified, unlinked address and Clerk redirects only to the app.
- #63 Previews kept out of Cloudflare's cache; #74 egress bounds and turn-only 429s; #71 a 24-hour cooldown on CLI releases, capped logs, init in Previews; #76 Docker logs of Session and Preview containers capped.
- #66 actions pinned by commit with Dependabot, and #77 limiting it to minor and patch releases.

Production changes on minicore, made on 2026-09-30 at the Admin's word ("make any and all production changes that are needed"), with the fleet compose synced in `chriscorbell/fleet` b358ae9:
- #80: separate router and egress tokens. Checked in production that each token opens only its own routes, and that neither the router nor the egress proxy holds the runner token.
- #81: memory and pids limits plus rotated logs on all four services. The app now binds `/srv/kardboard-nas`, a new automount of only `backup/minicore/kardboard` (`/etc/fstab`, with the old file saved as `/etc/fstab.bak-2026-09-30-kardboard`). Checked that the app sees and can write `/nas/kardboard`, and nothing else on the NAS.
- `CLERK_JWT_KEY` set from the instance's only JWKS key. Checked that it loads, that a forged token is refused on its signature, and that a made-up key id no longer calls Clerk. A real sign-in under it was not observed, since that needs the Admin's session.
- #82: the Claude review is skipped on Dependabot's pull requests.
- The Admin declined turning off SSH password logins on minicore.

Unverified in production: a real Clerk sign-in under `CLERK_JWT_KEY`. The per-Session caps, the cooldown, the runner, egress, and preview-router fixes, and the `cbn*` firewall rule went away with Sessions on 2026-10-07 ([ADR 0011](../../adr/0011-one-persons-board-worked-by-their-own-agents.md)), so nothing is left to verify about them; the card's list was cut down to match the same day.

Next action: the GitHub, Cloudflare, and token changes on the card only the Admin can make; then close this note.
Close when: every item on the card is applied or explicitly declined by the Admin.
