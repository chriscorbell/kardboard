# Runner previews on the kardboard Board

Read when: requesting a preview on the kardboard Board, or working from a branch created before runner previews were enabled.
Status: verified
Scope: environment, the kardboard Board
Verified: 2026-09-15 UTC
Source: production Board configuration and access checks for Card mq729n; [PR 11](https://github.com/chriscorbell/kardboard/pull/11); [preview runbook](../../runbooks/previews.md)
Recheck when: the Board preview mode, root Dockerfile, or Cloudflare routing changes

The Board uses `runner` preview mode. DNS, the tunnel, the shared secret, and the preview network are configured on minicore. URLs use `{card}.kardboard.cc`; the certificate and setup details belong in the runbook. Card mq729n's rebuilt Preview was verified through Admin sign-in on the new domain, then retired when the Card reached Done.

[PR 12](https://github.com/chriscorbell/kardboard/pull/12) merged and deployed as `f6b868b`, including PR 11's root Dockerfile and port-aware health check. New branches inherit them. A Preview builds the requested branch, so an old branch without the Dockerfile still needs that change even after main has it.

A Session container still has no installed browser, as checked on 2026-09-14. It can request a preview URL for the Admin to inspect, but should not claim a visual check it did not perform.
