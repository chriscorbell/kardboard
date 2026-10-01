# Security hardening pass

Status: active
Objective: a whole-system security review of kardboard and its deployment, with every code fix shipped and every remaining change that needs the Admin decided.
Branch: `main`; the work merged as PRs 63 to 77.
Plan and findings: card vfkfpnrx, "Security review and hardening pass across the app and its deployment", on the kardboard board. The findings still open stay on that card, out of this public repository, until they are fixed.

Shipped on 2026-09-30, each verified by CI and, where it could be, in production:
- #64 attachments never render as documents; #65 security headers, then #75 enforcing the page's script policy after no violation showed on kardboard.cc or a signed-in production build.
- #67 event streams close on lost access, constant-time internal tokens, 1 MB body limits; #72 per-Session write caps and an hourly per-person email cap; #70 Approve and merge only into the default branch, https-only Session links, no co-Member emails for Members; #73 sign-in links only a verified, unlinked address and Clerk redirects only to the app.
- #63 Previews kept out of Cloudflare's cache; #74 egress bounds and turn-only 429s; #71 a 24-hour cooldown on CLI releases, capped logs, init in Previews; #76 Docker logs of Session and Preview containers capped.
- #66 actions pinned by commit with Dependabot, and #77 limiting it to minor and patch releases.

Unverified in production: the per-Session caps, the email cap, and the cooldown have not met a real flood or a real release yet; `CLERK_JWT_KEY` is supported but not set on minicore.

Next action: the Admin decides the host, vendor, and secret changes listed on the card; apply the ones approved, then close this note.
Close when: every item on the card is applied or explicitly declined by the Admin.
