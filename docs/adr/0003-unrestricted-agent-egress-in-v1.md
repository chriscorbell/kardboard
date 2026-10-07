---
status: superseded by ADR 0011 on 2026-10-07
date: 2026-09-13
---
# Session containers get unrestricted outbound network in v1

A domain allowlist on Session egress would be the strongest defence against a prompt-injected Session exfiltrating repository contents, but package installs and build tools reach many hosts and an immature allowlist breaks builds silently. We ship v1 with unrestricted egress and put the effort into the credential proxy in ADR 0002, which removes the most damaging exfiltration target. The proxy is designed so an allowlist can be added per Board later without changing the Session image.

## Consequences

- Repository contents of a Board are considered exposed to any Member who can write Card text, which is already true since Members can read the Preview and the PR.
- Revisit when a Board hosts a repository whose contents are more sensitive than its Members.
