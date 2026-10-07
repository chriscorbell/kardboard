# First implementation pass

Status: complete, archived 2026-09-14. Its close condition was met: the stack runs on minicore behind `cardboard.xode.cc` and Sessions have completed against two repositories. Durable facts moved to `context/cardboard-production-operations.md` and `lessons/docker-image-and-compose-gotchas.md`; open items continue in `archive/2026-09-14-v1-gaps.md`.
Objective: bring Cardboard from design to a deployable v1. Overnight on 2026-09-13/14 the scaffold, server, client, MCP endpoint, runner, egress, preview-router, images, compose file, and CI were written; see [README.md](../../../README.md) for what runs and the "Status" section for what is missing.
Branch: `main`, pushed to `github.com/chriscorbell/cardboard` (public since 2026-09-14). CI publishes five images to GHCR on every push to main; the first green run was 2026-09-14.

## Verified on 2026-09-14

- `pnpm -r typecheck` and `pnpm --filter @cardboard/app build` pass. The built server starts under `node dist/server/index.js` with Node 26 type-stripping resolving `@cardboard/shared` from TypeScript source.
- Dev server seeds an Admin plus two demo Boards. Posting a comment enqueues a Trigger, which becomes a Session after the 60 s window (noop runner mode).
- MCP over HTTP answered `tools/list`, `announce_intent`, `get_card`, and `post_comment` with a token hashed into the sessions table.
- All five Docker images build in CI (app, runner, egress, preview-router, agent). None has been run yet.

## Decisions taken without the user (reversible)

- Dev auth mode (`CARDBOARD_AUTH=dev`) exists so the UI works without Clerk keys.
- The runner delivers the workflow prompt on container stdin, not in env, so it stays out of `docker inspect`.
- Boot recovery marks active Sessions failed only when a real runner is configured; in noop mode it leaves them so demo data survives restarts.
- Schema already carries what the design review asked for: `approvals.head_sha`, `cards.parent_card_id`, `cards.revision` for optimistic concurrency, `cards.pending_rerun`, and session token hashes.

## Needs the user

- Decisions on the eight findings in [docs/design-review.md](../../design-review.md), especially GitHub merge authority (two GitHub Apps with a ruleset bypass was the candidate) and Approval binding to a head SHA.
- Cloudflare hostnames, Clerk app, Resend domain, GitHub App, `claude setup-token`.
- Whether the local Qwen model should take "workhorse" tasks; the user wants to set that up together.

## Review findings already absorbed in code

- Finding 7 (human move to Done races with work): a human move to Done now cancels the active Session, consumes pending Triggers, and clears the re-run flag (`closeCardWork` in `server/src/services/orchestrator.ts`). Verified 2026-09-14 by moving a card with a running Session.
- Finding 2 (Approval not bound to reviewed code): leaving Review invalidates standing Approvals; `approvals.head_sha` exists but nothing writes it until GitHub integration lands.
- Finding 4 (restarts): boot recovery fails stale Sessions and re-schedules pending Triggers; runner container creation is idempotent by container name. Runner inventory reconciliation is still missing.

## Known gaps in the code

- Egress proxy header rewrite verified 2026-09-14 with a raw API call from a workload container on minicore (model replied). Claude Code CLI through the proxy is still unobserved.
- Codex MCP config syntax in `images/agent/entrypoint.sh` is unverified.
- `/api/internal/previews` and `/preview-auth` are referenced by the preview router but not implemented in the app.
- Nightly sweep scheduler exists (`server/src/services/sweep.ts`, 03:00 local, skipped in noop mode) but has never started a real container. No GitHub App token minting. `read_attachment` inlines text only up to 200 KB.
- Browser-automation note: the in-app browser's `key` action does not reach React keydown handlers; dispatching a KeyboardEvent does. Not an app bug.

## Deployed 2026-09-14

The stack runs on minicore from `~/docker/stacks/cardboard` (compose committed to `chriscorbell/stacks`, `.env` copied by scp, secrets never committed). `https://cardboard.xode.cc/healthz` answers through the Cloudflare Tunnel. Clerk production instance (secondary application, Google OAuth with custom credentials) is configured; the publishable key is injected into the page at request time from `CLERK_PUBLISHABLE_KEY` or `VITE_CLERK_PUBLISHABLE_KEY`. All server secrets are set as of 2026-09-14, including Resend and the Claude Code token. Image lessons: the app image must ship `packages/shared` source plus its `node_modules`; compose services need `init: true` or SIGTERM waits 30 s; every push rebuilds all five images so Watchtower restarts every service.

## End-to-end verified 2026-09-14

Two real Sessions ran on minicore against a Sandbox board with no repository: Claude Code started in the agent container in about 15 s, called the MCP tools (ledger, board, card, announce, comment, move), and exited cleanly. The runner's exit report reaches the app (internal routes are registered before the user API). Resend delivered a mention email from `milo@cardboard.xode.cc` after the sending domain was changed to the verified `cardboard.xode.cc`. Boot reconciliation against the runner inventory exists but has not been exercised by a real restart mid-Session.

## Full loop with GitHub verified 2026-09-14

On `chriscorbell/cardboard-sandbox` with both GitHub Apps installed and the `cardboard` ruleset active: a clarification reply triggered a Session that branched, edited, ran `check.sh`, pushed with the Sessions-app token, opened PR #1 with `gh` (author `app/cardboard-sessions`), recorded it on the card, and moved the card to Review. Approve in the UI merged PR #1 through the Merge app (`mergedBy app/cardboard-merge`, squash, SHA precondition), deleted the branch, moved the card to Done, and commented. Per-board model (`opus`) and reasoning (`high`) reached the container as `CARDBOARD_MODEL` and `CARDBOARD_REASONING`; whether Claude Code honours the effort variable is still unobserved.

Remaining before a client board: design-review findings 3 (child-card dispatch), 5 (preview cookie scope) and 6 (network isolation between workloads and the runner); runner-hosted previews; a real run of the nightly sweep; Codex through the egress proxy. Onboarding steps for a new repository live in `skills/cardboard-onboard`.

A Session then ran against this repository itself on 2026-09-14: it read the board over MCP, branched, committed a documentation repair, passed the acceptance command, and opened a pull request with `gh`. Approval and merge on this repository are unobserved, as is any Preview: the board is in external preview mode and this repository's CI publishes images on push to `main` rather than deploying per-pull-request previews.

Next action: decide findings 3, 5, and 6 with the user, then onboard the first real project with the skill.
Close when: the stack runs on minicore behind `cardboard.xode.cc` and one real Session completes against a test repository.
