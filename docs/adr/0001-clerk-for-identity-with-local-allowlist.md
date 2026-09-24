---
status: accepted
date: 2026-09-13
---
# Clerk for identity, kardboard's User table for access

kardboard is publicly exposed and its users are non-technical clients, so sign-in has to be polished and low-friction while access stays invite-only. We use Clerk for identity (email code and Google, no passwords) and keep kardboard's own User table authoritative: an identity that authenticates but matches no Invitation lands on a "not invited" page and touches nothing. The alternative, better-auth with magic links over Resend, would have removed a vendor but made us own session security on a public host with a single maintainer.

## Consequences

- Clerk webhooks or on-sign-in checks sync identities into the User table; the User table, not Clerk metadata, decides Board membership.
- Swapping identity providers later means replacing the sign-in layer only, since authorization never reads Clerk data.
