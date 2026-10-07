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
- Step 1, the decision record: this note and ADRs 0011 and 0012.

Next action: step 2, remove Sessions, Approval, and Previews from the app (card rn4yp6cr).
Close when: every step's card is in Done, the README and design describe the new scope, and minicore runs the app alone.
