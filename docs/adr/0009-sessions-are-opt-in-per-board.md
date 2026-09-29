---
status: accepted
date: 2026-09-28
---
# Sessions are opt-in per Board, and a Board without them merges nothing through kardboard

kardboard began as a place where every human change summons a Session, which suits a client asking for changes and watching them land. The Admin also wants Boards for projects worked alone, where the coding agent runs on the Admin's own machine under the Admin's control and the Board is only a shared record of the work. So whether a Board runs Sessions is a Board setting, off for a new Board. Boards that existed when the setting arrived were migrated with it on, so nothing changed for them.

On a Board without Sessions no human change is a Trigger, and none is kept for later: turning Sessions on answers only changes made after the switch, and turning them off drops what was waiting. kardboard also stops merging there. Approve, Try merging again, and the pull-request poll exist so that a Member's sign-off, not a Session, decides a merge ([ADR 0006](0006-approval-is-a-control-not-a-comment.md), [ADR 0008](0008-two-github-apps-for-merge-authority.md)). A Board worked by the Admin's own agent has no Session to keep merge authority from, and the Admin decides merges in their own conversation with that agent, so the agent merges and moves the Card to Done itself. ADRs 0006 and 0008 still govern every Board that runs Sessions.

## Considered options

- **Pause, left on.** Pause holds Triggers and replays them on resume, and every Card on a paused Board says it is waiting. A Board meant never to run Sessions would show that forever, and resuming it would start a Session for everything that ever changed.
- **A choice per Card.** Cards handed to the Agent one at a time, on a Board otherwise worked by hand. More flexible, but it puts a second question on every Card and mixes Sessions with an outside agent on one Board. It can be added later on top of this setting.

## Consequences

- Turning Sessions on or off is refused while a Session is active on the Board.
- A Board without Sessions needs neither GitHub App: kardboard never mints a token for it or reads its pull requests.
