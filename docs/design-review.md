# Design review, 2026-09-13

**Status as of 2026-09-15.** Finding 1 resolved by [ADR 0008](adr/0008-two-github-apps-for-merge-authority.md): two GitHub Apps and a branch ruleset, verified by a merge on `chriscorbell/kardboard`. Finding 2 resolved: Approval records the head SHA and the merge uses GitHub's SHA precondition; leaving Review voids Approvals. Finding 3 resolved in code as of 2026-09-15: a Card the Agent created starts its own Session when it has a parent Card and lands in Ready, the parent leaves Blocked and receives a `children_done` Trigger when its last child reaches Done, that Trigger says of each child whether it was `implemented` or only `closed` — a new `cards.outcome` column, written from the recorded merge — and waiting Cards are taken in Priority, position, then age order. Nothing else an Agent does is a Trigger. The rules are unit-tested; no split request has run through them in production. Finding 4 partly resolved: idempotent container creation and boot reconciliation against runner inventory exist; a restart mid-Session has not been exercised. Finding 7 resolved: a human move to Done cancels the Session and consumes pending Triggers. Findings 5 and 6 resolved in code as of 2026-09-15 with runner-hosted Previews: a single-use authorization code becomes a host-only Preview cookie, cookie and authorization headers are stripped before proxying, a Board Preview epoch revokes outstanding cookies, and Preview containers sit alone on a `preview` network the runner cannot be reached from. On 2026-09-15 UTC, public HTTPS checks against the deployed router verified code exchange, host-only cookies, credential stripping, and membership revocation with a temporary Member. Finding 6 is carried further as of 2026-09-15: each Session now gets its own `kardboard-session-<id>` network with only the app and the egress proxy attached, so one Session cannot reach another, and every Session and Preview bridge is named `cbn*` so `deploy/network-isolation.sh` can drop their LAN traffic in the host firewall. The per-session wiring is covered by unit tests against a Docker double; neither it nor the firewall rule has run on minicore yet, and the rule is an Admin step, is lost on a host or Docker restart, and leaves host-published ports 3070 and 3073 reachable through the bridge gateway. See [network isolation](runbooks/network-isolation.md). A real Member's Clerk sign-in remains unverified. See [the preview runbook](runbooks/previews.md). Finding 8 remains open. Of the smaller corrections, the ADR 0002 scoping is resolved as of 2026-09-15, and certificate coverage is settled by the free `{card}.kardboard.cc` pattern; the rest remain open.

The execution and merge design needs revision before implementation. The single app process, SQLite, and separate runner fit the stated deployment. The gaps are in who enforces permissions, what Approval covers, and how work survives state changes and restarts.

Reviewed [the design](design.md), [the glossary](../CONTEXT.md), and all seven accepted ADRs. There is no application code yet. Findings below follow from the proposed behavior; they are not observed runtime failures. Proposed remedies are review recommendations, not accepted decisions.

P1 findings should be resolved before running Sessions against client repositories. P2 findings should be resolved before enabling the affected workflow.

## 1. P1: The GitHub token bypasses kardboard's merge authorization

References: [Provider credentials and MCP permissions](design.md#providers-and-credentials), [ADR 0006](adr/0006-approval-is-a-control-not-a-comment.md), [ADR 0007](adr/0007-github-app-installation-tokens-per-session.md).

Each Session receives a repository-scoped token that can push and merge. kardboard separately promises that a Session can merge only its own Card's pull request, after Approval. A Session can instead call GitHub directly with its token. GitHub knows the repository and App permissions, but has no knowledge of the Card or its Approval. Removing the token's pull-request write permission alone would not solve this: GitHub's merge endpoint requires contents write permission. Repository rules could restrict this, but the proposal requires no such rules or independent merge identity. [GitHub merge permissions](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request), [installation token scope](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

Keep GitHub write credentials in a trusted module that restricts pushes to the Session's branch and authorizes every merge against the Card's current Approval. Alternatively, specify and verify repository rules that enforce equivalent restrictions independently of the Session. A workflow prompt and an MCP permission check cannot govern a direct GitHub call.

Acceptance case: a Session attempts to merge its own unapproved pull request, merge another Card's pull request, and push directly to the default branch. Each attempt is rejected outside the model.

## 2. P1: Approval is not tied to the code the Member reviewed

References: [Review, Approval, and merge](design.md#review-approval-and-merge), [ADR 0006](adr/0006-approval-is-a-control-not-a-comment.md).

The proposal records Approval on a Card and then rebases, resolves overlap at merge time, runs checks, and merges. Conflict resolution can change the approved behavior. A pending feedback Session can also update the branch after Approval. No rule binds the Approval to a pull request, commit, or Preview, or invalidates it after these changes. Passing checks does not establish that the Member approved the resulting change.

Record Approval against the pull request and reviewed head SHA, with the Preview and checks associated with that SHA. Define which later changes invalidate Approval. The simplest rule is to update the branch before review and require renewed Approval after any later head change. If automatic rebasing after Approval is retained, define its allowed conditions and require renewed Approval after conflict resolution or implementation edits. The trusted merge operation must compare the expected head atomically; GitHub supports a head-SHA precondition. [GitHub merge precondition](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request).

Acceptance case: approve revision A, push revision B, then process the Approval. B must not merge under A's Approval. Repeat with a conflicting base-branch update and with a reopened Card that has an older Approval.

## 3. P1: Child Cards have no path to start work or wake their parent

Reference: [Sessions](design.md#sessions), especially the Trigger rule and request splitting.

Only human changes start Sessions. Agent actions never trigger them. A Session that splits a request creates child Cards and leaves the parent in Blocked, but those children receive no human Trigger. Their later Agent-driven completion also cannot start a Session on the parent. The nightly sweep can move and comment, but cannot implement the work. Priority and position have no defined role in selecting these Cards either.

Give the orchestrator explicit dispatch rules for Agent-created work and dependency completion, without making every Agent Comment a Trigger. Store parent-child relationships as data rather than only Comment links. Define when a Ready Card becomes eligible, how Priority and position affect dispatch, and how the parent resumes. Distinguish children that were implemented from children closed without implementation, since both currently reach Done.

Acceptance case: split one human request into two children and provide only the requested Approvals. Both children start, and the parent resumes once its dependencies are satisfied, without an extra human Comment to wake anything.

## 4. P1: Restarts can strand Claims or duplicate Sessions

References: [Session creation and limits](design.md#sessions), [Watchtower deployment](design.md#infrastructure).

The app takes a Claim and then asks a separate runner to create a container. A restart between these operations can leave a Claim with no container. A lost response after container creation can cause a retry to create a second container. If a container exits while the app is restarting, its Claim and Pending re-run can remain stuck. Watchtower makes app and runner restarts part of ordinary deployment, while Session containers remain running.

Define a persistent Session lifecycle in the app. Claim acquisition, consumed Trigger positions, and dispatch intent need a transaction. Runner creation needs a stable Session ID and idempotent behavior. On startup, reconcile recorded Sessions with runner inventory and observed exits. Define timeout ownership, terminal states, failed-start retry limits, token revocation, and when a Claim can safely be released. A database transaction alone cannot cover Docker creation or a GitHub merge.

Acceptance case: interrupt execution immediately before and after container creation, after a successful merge but before recording Done, and during completion delivery. Recovery must neither repeat completed work nor leave the Card permanently claimed.

## 5. P1: The Preview cookie can escape through sibling applications

Reference: [Runner Preview authentication](design.md#review-approval-and-merge).

The design puts a signed authentication cookie on `.xode.cc`. Browsers send a domain cookie to matching subdomains, including sibling applications and Preview hosts. HttpOnly prevents JavaScript from reading it, but does not stop a receiving server from seeing it. If the router forwards it to branch-controlled Preview code, that code can capture it. Stripping it at the router still does not protect it from another application under `xode.cc`. A signature prevents forgery, not replay. [Cookie domain and HttpOnly behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

Use a sign-in redirect that exchanges a short-lived, single-use authorization code for a host-only Preview cookie. Bind the authorization to the intended Board and Preview, check current membership, and remove kardboard credentials before proxying to the Preview. Keep the app's own session host-only. Require expiry and revocation behavior explicitly. Since Preview pages share the parent site with the app, also require origin or CSRF checks on app mutations.

Acceptance case: visit a Preview that records all incoming headers and attempts an app mutation. It must receive no reusable kardboard credential, and the mutation must fail without the app's authorization checks. Removing Board membership must remove Preview access.

## 6. P1: "Internal only" does not define isolation from Session code

References: [Infrastructure network table](design.md#infrastructure), [ADR 0003](adr/0003-unrestricted-agent-egress-in-v1.md), [ADR 0005](adr/0005-runner-service-owns-the-docker-socket.md).

The runner has root-equivalent Docker authority and listens on the stack's internal network. The design does not specify which networks Session and Preview containers join, or how the runner authenticates its caller. If workloads join that network to reach MCP or egress, they can also reach the runner unless an explicit restriction prevents it. Docker containers on the same user-defined bridge can reach each other's ports. [Docker bridge networking](https://docs.docker.com/engine/network/drivers/bridge/).

Specify separate control and workload networks and require app-to-runner authentication. Sessions should reach only the intended MCP and credential-proxy interfaces, and the internet required by builds. Previews should have no access to runner control or Session credentials. Define treatment of host, LAN, and other Board addresses as well. Accepting repository-content exfiltration over public internet, as ADR 0003 does, does not establish that access to the rest of minicore is acceptable.

Acceptance case: from both a Session and a Preview, attempt runner control, access to another Board's workload, and access to private host services. The stated policy must be enforced by networking and authorization rather than by the workflow prompt.

## 7. P2: Moving an active Card to Done races with ongoing work

References: [Human moves](design.md#boards-and-cards), [Pending re-run and Claim rules](design.md#sessions), [Board-wide Session mutation rights](design.md#providers-and-credentials).

A human move to Done closes a Card without work. If a Session already holds its Claim, the move becomes Pending re-run while the Session continues from its earlier view. It can push more work and move the Card back to Review before the next Session processes the closure. Another Card's Session can also move it, because Claims restrict concurrent Sessions on one Card but do not restrict Board-wide mutation rights.

Make human closure an immediate server-side state transition. Define cancellation of the active Session and invalidation of its outstanding mutations and Approval. Reject stale state-changing requests using the Card's current revision and Session authority. Decide whether Hygiene sweeps skip claimed Cards or use the same conditional mutation rules. Handle a merge already accepted by GitHub as completed work; cancellation cannot reverse it.

Acceptance case: move a Card to Done immediately before its Session reports Review. The stale report must not reopen it. Repeat with a sweep and another Card's Session attempting the move.

## 8. P2: External Previews do not inherit Board membership checks

Reference: [External Preview mode](design.md#review-approval-and-merge).

The external mode stores a URL from project CI. That URL does not pass through kardboard's preview router. Cloudflare Pages Preview URLs, the proposal's example, are public by default. Requiring sign-in to view the Card therefore cannot make the linked deployment private. [Cloudflare Pages Preview access](https://developers.cloudflare.com/pages/configuration/preview-deployments/).

Give external mode an explicit access contract. Either require independently configured protection and verify it during Board setup, or identify external Previews as potentially public and scope the membership-only guarantee to runner mode. If private access through kardboard is required, the external origin must also reject direct unauthenticated access; adding a protected link alone is insufficient.

Acceptance case: request the external deployment directly in a signed-out browser. Its behavior must match the Board's configured access policy.

## Smaller corrections and deployment prerequisites

- ~~[ADR 0002](adr/0002-subscription-credentials-stay-in-the-egress-proxy.md) says a compromised Session cannot take the provider token out, while its Codex exception places the sign-in file inside a Session with unrestricted egress. Scope that guarantee to the proxied Provider. Automatic fallback can enter the weaker credential mode, so make that transition an explicit configuration decision until the proxy path is verified.~~ Resolved 2026-09-15: the Codex proxy path was verified, so the exception is closed and the ADR's guarantee is scoped to a proxied Provider. Fallback is a Board-independent Admin setting, on by default, which a host still mounting the Codex sign-in file should turn off.
- [The tunnel setup](design.md#manual-steps-the-admin-performs) needs a certificate-coverage check for `*.preview.xode.cc`. In a full Cloudflare zone, Universal SSL covers the apex and first-level subdomains; `<card>.preview.xode.cc` is deeper. Record the required certificate or change the hostname plan if coverage is absent. The current zone's certificate configuration was not inspected. [Cloudflare Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/). Answered as of 2026-09-15 by making the shape a setting rather than a constant: `KARDBOARD_PREVIEW_HOST_PATTERN` defaults to `{card}.preview.{domain}` and accepts `{card}-preview.{domain}`, which Universal SSL covers. Which one this zone uses is still an Admin decision, and the zone's certificates remain uninspected from inside a Session.
- [ADR 0004](adr/0004-sqlite-in-a-single-server-process.md) describes backup as a file copy. An uncoordinated copy of a live database can be inconsistent, and the WAL can contain required state. Keep SQLite, but describe a safe snapshot using its backup API, `VACUUM INTO`, or a coordinated offline copy. This corrects the stated recovery mechanism without adding an unrequested backup system. [SQLite backup hazards](https://www.sqlite.org/howtocorrupt.html#backup_or_restore_while_a_transaction_is_active), [SQLite backup API](https://www.sqlite.org/backup.html).

## Recommended revision order

First define the app-owned rules for dispatch, dependencies, Session recovery, closure, and Approval. Then specify the GitHub write authority and workload network topology that enforce those rules. Finish the Preview authentication contract before inviting Members to use deployments.

The acceptance cases above are focused checks for the eventual implementation. No tests were added or run during this document review.
