# Personal-board refocus

Status: active
Objective: turn kardboard from a board that starts Sessions into one person's agent-native kanban across all their projects, per [ADR 0011](../../adr/0011-one-persons-board-worked-by-their-own-agents.md) and [ADR 0012](../../adr/0012-one-access-token-reaches-every-board.md).
Plan: card 66ar6rp3 on the kardboard board, "Refocus kardboard as a personal, agent-native board", which lists the decisions of 2026-10-07 and the pull requests in order; each step has its own card in Ready.
Branch: one branch per step, merged once green, as the Admin chose on 2026-10-07.

Decisions the Admin made on 2026-10-07 that the ADRs do not spell out:
- Side-findings: an agent files them as Backlog Cards without asking and says so in one line of its reply.
- Card types: one fixed type per Card, from bug, feature, task, idea, chore, each with its own color and Lucide icon. No custom labels.
- The first version adds an all-boards overview. A Card's origin link (which thread it came from) and a quick-capture shortcut were offered and not chosen.
- Approved outside this repository: a migration dropping the Session tables after a verified snapshot on minicore; editing the kardboard stack in `chriscorbell/fleet` and on minicore; removing the `cbn*` firewall rule and its systemd unit; rewriting the kardboard-onboard skill in `chriscorbell/skills`.
- Left for the Admin: uninstalling and deleting both GitHub Apps, revoking the Claude setup-token and the Codex sign-in kardboard used.

Done:
- Step 1, the decision record: this note and ADRs 0011 and 0012 (PR 86).
- Step 2, Sessions, Approval, and Previews out of the app (PR 87, migration 0019). A verified snapshot was taken on minicore first, `backups/kardboard-before-sessions-removal-20261007T233833Z.db`, also copied to the NAS; production had 92 cards and 69 Session rows.
- Step 3, the runner, egress proxy, preview router, and agent image out of the repository (PR 88), and off minicore: fleet `8108a35`, the old containers, networks, volumes, and images removed, the `cbn*` firewall rule and its unit removed, 14 Session lines out of `.env` after a dated copy, the Codex sign-in file shredded, and the runner's logs archived under `~/.local/state/kardboard/`. What only the Admin can do (GitHub Apps, provider tokens, the Cloudflare wildcard route) is on card vfkfpnrx.
- Step 4, single-user (migration 0020): production had one admin and one removed Member who wrote nothing, so deleting non-admin users lost no authorship. The Admin panel became Settings at `/settings`, with `/admin` redirecting; the API paths stay under `/api/admin`.

Next action: step 5, one Access token for every Board (card h7cr8bca). The session that did steps 1 to 4 holds the kardboard MCP tools as they were at its start; after step 5 deploys, `get_board` and `create_card` need a `board` argument its cached schema lacks, so it calls the MCP endpoint with curl instead.
Close when: every step's card is in Done, the README and design describe the new scope, and minicore runs the app alone.
