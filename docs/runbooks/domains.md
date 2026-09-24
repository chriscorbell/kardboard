# Domain configuration

The product name is always lowercase: `kardboard`. The app's canonical URL is `https://kardboard.cc`; a Card's preview uses `https://<first-eight-id-characters>.kardboard.cc`.

## Routing and certificates

The `homelab` tunnel points the apex at minicore port 3070 and the wildcard at preview-router port 3073. Both DNS records are proxied CNAMEs targeting the same tunnel. Unknown preview hosts return 404. Exact app aliases must precede the wildcard tunnel route.

Cloudflare creates an explicit DNS record when adding a tunnel route, and refuses an existing record with the same name. Wildcard routes do not create DNS records; add their proxied wildcard CNAME separately. The apex and first-level previews fit Universal SSL.

`KARDBOARD_PUBLIC_URL=https://kardboard.cc` controls app links, preview sign-in redirects, and accepted Clerk token origins. `KARDBOARD_REDIRECT_HOSTS=cardboard.xode.cc,app.kardboard.cc` preserves old app links with a 308 redirect, retaining the path and query. GET and HEAD requests redirect; API mutations do not.

## Authentication

Use the existing Clerk production instance, with `kardboard.cc` as its primary domain. Keep the users and Secret Key. Clerk infrastructure uses these DNS-only CNAMEs:

| Name | Target |
| --- | --- |
| `clerk` | `frontend-api.clerk.services` |
| `accounts` | `accounts.clerk.services` |
| `clkmail` | The mail target shown by Clerk |
| `clk._domainkey` | The first DKIM target shown by Clerk |
| `clk2._domainkey` | The second DKIM target shown by Clerk |

Clerk supplies certificates for its own hosts. A domain change regenerates the three mail CNAME targets; copy the new values and use Verify records in the Clerk dashboard. Its frontend API can return Cloudflare Error 1000 until Clerk has verified and deployed the domain. Its session cookie is [scoped to the app host](https://clerk.com/docs/guides/how-clerk-works/overview); the long-lived client cookie stays on the Clerk frontend API host. Enable the instance subdomain allowlist, permitting `accounts.kardboard.cc` for the account portal. Preview hosts must not be accepted as Clerk app origins. Backend token verification sets `authorizedParties` to the canonical app URL and reads bearer tokens, rather than ambient cookies.

The Google OAuth client needs `https://kardboard.cc` as an authorized JavaScript origin and `https://clerk.kardboard.cc/v1/oauth_callback` as an authorized redirect. Its consent-screen name is `kardboard`, with `kardboard.cc` registered as an authorized domain.

A [Clerk primary-domain change](https://clerk.com/docs/guides/development/deployment/changing-domains) signs users out and generates a new Publishable Key. Prepare DNS and Google settings first, then update the existing instance, save the new Publishable Key in `deploy/.env`, and recreate the app and preview router with the matching Compose configuration. Verify sign-in and reject requests originating from a preview hostname before declaring the move complete. Test `/v1/client`: the root and accounts portal should return 200, while a Preview origin returns 403 `subdomain_not_allowed`. `/v1/environment` is public and does not test this restriction.

## Email

Resend sends as `Milo <milo@kardboard.cc>`. Verify `resend._domainkey` (TXT), `send` (MX and SPF TXT), and `_dmarc` (TXT) using the values in Resend. These records are DNS-only. The existing sending key can be renamed and restricted to the new domain without changing its value. Change that restriction with the deployed sender address so mail delivery stays aligned.

## Compose alignment

`deploy/compose.yaml` and `chriscorbell/stacks/kardboard/compose.yaml` must remain aligned; Watchtower applies image updates but does not apply Compose edits.

## Migration verification

On 2026-09-15 UTC, the existing Clerk instance moved to the root with all DNS records verified and both certificates issued. Google sign-in and Admin email-code sign-in succeeded. The Admin opened the rebuilt Preview on its new hostname. Clerk denied Preview origins on `/v1/client`; unknown Preview hosts returned 404. Resend verified the new domain and the existing sending key was restricted to it. Both GitHub Apps remained installed after the repository rename. The apps were later renamed to Kardboard (Sessions) and Kardboard (Merge), with slugs `kardboard-sessions` and `kardboard-merge`; their IDs, and so the `kardboard` ruleset bypass, did not change. Production switched to the new slugs on 2026-09-15 and both apps still reported as installed on both project repositories.

[PR 12](https://github.com/chriscorbell/kardboard/pull/12) deployed as `f6b868b`. [CI](https://github.com/chriscorbell/kardboard/actions/runs/34926475377) passed validation and published all five images; all four production services were verified at that revision. Production browser checks confirmed the lowercase wordmark, authenticated Board access, and a fresh Preview authorization exchange. Both legacy app aliases returned path- and query-preserving 308 redirects.

Card mq729n reached Done after verification and its Preview was retired. New Cards use the same `{card}.kardboard.cc` pattern.
