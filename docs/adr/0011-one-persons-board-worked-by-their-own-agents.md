---
status: accepted
date: 2026-10-07
---
# kardboard is one person's board, worked by their own agents

kardboard was built so that every human change on a Board would start a disposable Session that did the work, with Approval, Previews, two GitHub Apps, and three supporting services to keep that safe. The Admin no longer wants that. They want to decide which agent works on which Card and when, from the coding agent they are already talking to, and they want the Board for something else: one place where the work across all their projects stays visible, including what their agents notice along the way, instead of being scattered across chat threads. So kardboard no longer runs agents at all. Sessions and everything that exists only for them are removed, not switched off: the runner, the egress proxy, the preview router, the agent image, both GitHub Apps, Approval, Triggers, Previews, Provider fallback, Hygiene sweeps, and Transcripts. Every Board is worked the way a Board without Sessions already was ([ADR 0009](0009-sessions-are-opt-in-per-board.md)): the User's own agent reads and changes it through an Access token, and merges with the User's own credentials.

kardboard also becomes single-user. Members and Invitations existed so that clients could ask a Session for work, and without Sessions there is no one else to invite. Clerk stays as the identity layer ([ADR 0001](0001-clerk-for-identity-with-local-allowlist.md)), with one allowed address. Mentions and notification emails go with Members. The alerts kardboard sends its operator, such as a failed backup, stay.

## Considered options

- **Keep Sessions, off by default.** The code is written and it works. But it means four services, a Docker socket, a provider credential, and two GitHub Apps to maintain and secure for a feature that is never used, and every design and glossary entry has to describe two kinds of Board.
- **Sessions started by hand.** A "Start agent" control on a Card would keep the runner and drop the automatic Triggers. But the User already starts agents from the tool they work in, which sees their machine and their conversation. A second way to start one, in a sandbox that sees neither, would compete with it.
- **Keep Members.** Members cost little to keep, but every Board, Card, Comment, and notification path carries membership checks for a second person who does not exist. Sharing a Board can be built again if it is ever wanted.

## Consequences

- This decision supersedes ADRs 0002, 0003, 0005, 0006, 0007, 0008, and 0009. ADR 0004 still holds: one process over SQLite. ADR 0001 still holds for identity, but its allowlist has one address.
- A migration drops the Session, Approval, Preview, and membership tables after a verified snapshot. After that, the snapshot and Git history are the only record of them.
- kardboard ships as one Docker image. A deployment needs no GitHub App, no provider credential, and no host firewall rule.
- kardboard itself never calls GitHub. A Card's pull request is the link the agent records, and kardboard does not read its state.
