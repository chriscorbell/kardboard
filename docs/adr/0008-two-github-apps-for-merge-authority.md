---
status: accepted
date: 2026-09-14
---
# Two GitHub Apps separate what a Session can push from what kardboard can merge

A Session holds a repository-scoped token and executes text written by clients, so any merge right
in that token is a merge right for a prompt injection. GitHub cannot scope a token to "this pull
request after kardboard says so", and a prompt or an MCP permission check cannot govern a direct
API call. We therefore use two GitHub Apps with the same repository permissions: "kardboard
Sessions" mints one-hour installation tokens for Sessions, and "kardboard Merge" is used only by
the app itself on a recorded Approval. A branch ruleset on the default branch requires a pull
request with one approval and lists the merge app as its sole bypass actor, so a Session's merge
attempt is refused by GitHub, not by kardboard.

Approval is recorded with the pull request head SHA the Member reviewed, and the merge sends that
SHA as GitHub's precondition. A push after Approval makes the merge fail with 409, which
invalidates the Approval and asks the Member to look again. A pull request that is not mergeable
sends the approval trigger to a Session to update the branch, and its push likewise needs a fresh
Approval.

## Consequences

- Both apps must be installed on every project repository, including client-owned ones. The
  admin panel shows installation status per board.
- The ruleset is configured by hand per repository and is part of onboarding a Board. Without it
  the separation is advisory only.
- Squash merges only; the branch is deleted after merging.
