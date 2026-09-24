---
status: accepted
date: 2026-09-13
amended: 2026-09-14 by ADR 0008, which splits the single App into a Sessions app and a Merge app
---
# One GitHub App, one-hour installation token per Session

Sessions need to clone, push a branch, open and merge pull requests, and read Cloudflare Pages preview URLs. A fine-grained personal access token per Board or a deploy key would be long-lived and broader than one Session needs. A GitHub App installed per repository lets kardboard mint a one-hour installation token scoped to that single repository for each Session, and attributes commits and merges to the App's bot identity, which matches the single Agent identity. Client-owned repositories work as long as the client installs the App on that repository. GitHub is the only supported host in v1.
