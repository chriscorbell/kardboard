# kardboard design

kardboard is a kanban board for every project one person works on, kept up to date by that person and by their own coding agents. It exists so that work items, and the side-findings agents mention along the way, live in one place where they can be seen, instead of across chat threads. Nothing on a Board starts on its own: the person decides which agent works on what, and when, in the agent they are already talking to. This document records the agreed design as of 2026-10-07, when [ADR 0011](adr/0011-one-persons-board-worked-by-their-own-agents.md) removed Sessions and Members and [ADR 0012](adr/0012-one-access-token-reaches-every-board.md) let one Access token reach every Board. Vocabulary is defined in [CONTEXT.md](../CONTEXT.md) and is used here with its glossary meaning. Decisions with real trade-offs have their own record under [docs/adr](adr/). What is not built yet is listed under [Status](#status).

## Actors

The User is the one person kardboard is for: Chris. The Agent is one non-human identity, named "Milo" by default and renamed in Settings, under which every coding agent holding an Access token acts. The Board tells the User's own words from the Agent's: a Card or Comment the User wrote by hand carries their name, and one an agent wrote carries the Agent's, whichever machine or conversation it came from.

kardboard has no sign-in. Like the User's other apps on minicore, it is a plain port reached from their home network and tailnet and never from the public internet, and every request that reaches it is the User ([ADR 0014](adr/0014-a-plain-port-like-the-other-apps.md)). Agents still present an Access token.

## Boards and Cards

One Board per project, usually with its repository. A Board has a name, a slug for its URL, and an optional GitHub repository URL, which is how an agent finds the Board for the repository it is working in. Six fixed Columns:

| Column | Meaning |
| --- | --- |
| Backlog | New Cards not yet looked at, including what an agent filed along the way. |
| Blocked | Waiting on the User's answer. |
| Ready | Understood and worth doing, not started. |
| In Progress | Being worked on. |
| Review | A pull request is open for a look. |
| Done | Merged, closed, or a duplicate. |

A Card has a title, Markdown description, Card type, Priority (none, low, medium, high), Column, position within the Column, creator, and Comments. The Card type is one of bug, feature, task, idea, or chore, each with its own color and icon, so a Board reads at a glance; a new Card is a task unless its creator says otherwise. Attachments belong to Comments only. A PNG, JPEG, GIF, WebP, or AVIF attachment opens in a viewer over the card, fitted to the screen, with a click to see it at full size and arrows between the Comment's images; any other file downloads, an SVG among them, since an SVG can carry script. Files chosen, pasted, or dropped while creating a Card are posted as one Comment by its creator right after the Card; an image pasted into an existing description is not handled. Authors may edit their own Comments, which shows an "edited" marker; earlier bodies stay in the event log with no history UI. A Comment can be deleted, and goes for good with its revisions and Attachments, the stored file too once nothing else refers to it; the event log records who deleted it but not what it said. A Card can be deleted the same way, with its Comments and their Attachments and its own events; the event log keeps who deleted it and whose it was. An agent deletes only Cards the Agent created. Deleting leaves the repository alone. Each Card shows an activity trail of edits, moves, and pull-request links alongside its Comments.

A Card in Blocked whose last word is the Agent's shows that question at the top of the Card and "Needs your answer" on its tile. The Board can be searched by title, description, and id, and filtered to Cards waiting on the User, Cards the User wrote, a Card type, or a Priority; the filter lives in the URL. Done starts as a narrow strip with its name and count, which opens into the full Column when clicked and closes again from its header; whether it is open is remembered per Board in each browser. A Card dropped on the strip goes to Done. Open, Done shows its ten most recently updated Cards and folds the rest. The first time the User opens a Board, a short explanation of the Columns appears, which stays dismissed on every device.

Cards move by hand or by an agent, anywhere. Every Card carries a revision number, and every edit or move names the revision it was based on and is refused when the Card has moved on, so a stale agent cannot undo a change it never saw. A Card reaching Done records how it ended: `implemented` when the agent that merged its pull request says so as it moves the Card, `closed` otherwise. A Card that leaves Done forgets it. A Card may have a parent, from when a large request was split into pieces; the parent shows its pieces and how far they have got.

## The Overview

The home page shows every Board at once, so nothing is lost across projects: the Cards waiting on the User (a question in Blocked, a pull request in Review), the Cards In Progress, and the eight newest in Backlog with a count of the rest, each with its type, Board, and age, and a mark on the ones an agent filed. Beside them, each Board with what is open on it and how much waits on the User, one click away.

## Working a Board from an agent

Any coding agent the User runs can read and change every Board through an Access token, at the `/mcp` endpoint. The User makes one in Settings, named for where it runs. The secret is shown once, with the command that installs the server for the user in Claude Code, or in Codex with the token in an environment variable, so one install works in every project; only its hash is kept. A token records when it was last used and stops working when the User revokes it; its row stays, so the events it signed still name it. See [ADR 0012](adr/0012-one-access-token-reaches-every-board.md).

A token acts as the Agent: its Cards, Comments, and moves carry the Agent's name, and the event log records which token acted. The tools list the Boards with their repositories, open Cards, and replies waiting; create a Board; read a Board, which marks each Card where the User has commented since the Agent last did, so an agent that works only when asked can find the answers waiting for it; read a Card and an attachment; create a Card in any Column, with its type and Priority; edit any Card's title, description, type, or Priority; move a Card, at the top or the bottom of its Column; comment; record a Card's pull request and branch; and delete a Card the Agent created. A tool that acts on a Card finds its Board from the Card; the others name the Board.

The server's instructions tell an agent how to work:

- Find the Board for the repository it is in by matching `git remote get-url origin` against the Boards' repositories. When none matches, ask the User whether to create one.
- Keep the Board true to the work: In Progress when it starts a Card, Blocked with a question when it needs the User, Review once the pull request is open and recorded, Done once it has merged it.
- File side-findings without asking. Something worth doing that is outside the task at hand, such as a bug it noticed, a cleanup, or an idea, becomes a Backlog Card on the right Board, with its type, a title that says what it asks for, and enough in the description to pick it up later without the conversation: where it was found, the files involved, and the Card being worked on at the time. The agent says so in one line of its reply, and does not file what it is about to fix in the current task.

kardboard does not read a pull request, check that it exists, or merge it; it checks only that the pull request is in the Board's repository. The agent merges the pull request with the User's own credentials and then moves the Card to Done saying so.

## Notifications and alerts

The Board changes live: every open Board follows its changes over server-sent events, and the Overview reads every Board again every twenty seconds and whenever its tab comes back into view. kardboard sends the User no notifications, by email or otherwise, since the Board, the Overview, and `replyWaiting` already say what needs them. A daily snapshot or its off-disk copy that failed shows at the top of the Overview until the next one succeeds, and every failure is in the app's log under `[alert]`.

## Settings

- Boards: create, rename, set the repository, delete. Deleting a Board removes its Cards and everything on them and its event log, after the User types its slug, and is refused when the snapshot taken first fails, so a deleted Board can be restored from Backups; for the same reason its attachments stay in the off-disk copy. The repository on GitHub is not touched.
- Agent: name and avatar, and the Access tokens that connect agents: make, list with last use, revoke.
- Backups: snapshots, the last attempt, and the last off-disk copy, and a snapshot on demand.

## Infrastructure

kardboard runs on minicore as one compose stack named `kardboard` in `chriscorbell/fleet` (`hosts/minicore/stacks/kardboard`), with data under `/home/chris/docker/data/kardboard`. It is one service, `app`: web, REST API, MCP server, and SQLite, published on host port 3071.

The app keeps its state in SQLite in WAL mode, see [ADR 0004](adr/0004-sqlite-in-a-single-server-process.md). Once a day it writes a snapshot with `VACUUM INTO` to `backups/` on the same bind mount, verifies it, and keeps the newest fourteen; when migrations are waiting at boot it takes one more first, named `kardboard-pre-migrate-<stamp>.db`. With `KARDBOARD_BACKUP_COPY_DIR` set it also copies each snapshot, and every attachment it does not hold yet, to that directory in the background, but only once the directory carries a `.kardboard-backup-target` marker, so a NAS share that failed to mount never receives a copy that reports success. Restoring one is an operator procedure with the app stopped, described in [the backups runbook](runbooks/backups.md). Attachments are stored on the data bind mount with content-addressed names and served through the app; there are no public file URLs. An Attachment's type is stored as its bare lowercase `type/subtype`. Only PNG, JPEG, GIF, WebP, and AVIF are served for display; everything else is served as a download, under a sandbox policy. A file the app has fetched is shown or saved from a blob URL, which keeps none of the server's headers, so the app types each one again first: a picture as its raster type, anything else as one no browser renders. An uploaded SVG or HTML page therefore never opens as a page on the app's origin.

Nothing is public. The app is reached at `http://minicore.saanen-monitor.ts.net:3071` from the tailnet, and at minicore's LAN address at home; [the access runbook](runbooks/access.md) has the details.

This repository is a pnpm monorepo in TypeScript: `packages/app` (Vite + React front end, Node back end, Drizzle on SQLite) and `packages/shared`. One GitHub Actions workflow builds the image on every pull request and publishes it to GHCR on push to `main`, and Watchtower on minicore updates the app within a minute.

## Manual steps the User performs

These need host or account access: removing the Cloudflare routes that served `kardboard.cc`, as [the access runbook](runbooks/access.md) describes. Connecting an agent is described in the README, and the `kardboard-onboard` skill in [chriscorbell/skills](https://github.com/chriscorbell/skills/tree/main/kardboard-onboard) walks an agent through it.

## Status

As of 2026-10-07 the app runs alone on minicore at `http://minicore.saanen-monitor.ts.net:3071`; Sessions, Approval, Previews, the services that ran them, and Members, Invitations, Mentions, and notifications are gone. Everything above is built, as of 2026-10-07; card 66ar6rp3 on the kardboard Board tracked the refocus.

## Out of scope

Board archival, sharing a Board with another person, inbound email, per-Board custom Columns or labels, reading pull-request or CI state from GitHub, and Git hosts other than GitHub.
