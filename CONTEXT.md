# kardboard

A self-hosted kanban platform for work done by coding agents. On a board that runs Sessions, every human change summons a disposable coding agent that either does the work or asks for what it needs.

## Language

### People and actors

**User**:
A human account that can sign in. Every User is either the Admin or a Member of one or more Boards.
_Avoid_: Client, account, person

**Admin**:
The single global operator who invites Users, creates Boards, and configures the Agent.
_Avoid_: Owner, superuser

**Member**:
A User granted access to a specific Board. Membership is per Board.
_Avoid_: Client, collaborator, guest

**Agent**:
The single non-human identity, with its own name and avatar, under which every Session, and every agent holding an Access token, acts on every Board. Named "Milo" by default.
_Avoid_: Bot, assistant, worker

**Invitation**:
The Admin's act of allowlisting an email address so that identity may sign in as a User.
_Avoid_: Signup, registration

### Boards

**Board**:
The kanban board for exactly one project and its repository. Owns its Members, Cards, and project settings, among them whether it runs Sessions, which a new Board does not until the Admin turns them on.
_Avoid_: Project, workspace

**Column**:
One of the six fixed stages of a Board. Backlog holds new Cards not yet triaged. Blocked holds Cards waiting on a human answer. Ready holds triaged Cards not being worked on. In Progress holds Cards being implemented. Review holds Cards with a pull request awaiting a look, and on a Board that runs Sessions, Approval. Done holds merged, closed, or duplicate Cards.
_Avoid_: List, lane, stage, status

**Card**:
A unit of requested work on a Board, with a title, description, Priority, and Comments. A Card sits in exactly one Column.
_Avoid_: Ticket, issue, task, item

**Priority**:
A Card's urgency: none, low, medium, or high. Position within a Column is the finer ordering signal.
_Avoid_: Severity, urgency, rank

**Comment**:
A message posted on a Card by a User or the Agent. Authors may edit their own Comments.
_Avoid_: Note, reply, message

**Attachment**:
A file uploaded with a Comment.
_Avoid_: Upload, asset

**Mention**:
A reference to a User or the Agent inside a Comment that notifies the mentioned party.
_Avoid_: Tag, ping

### Agent work

**Session**:
One disposable run of the Agent in its own container on one Provider. A card Session holds a Claim on exactly one Card; a sweep Session holds no Claim and performs a Hygiene sweep.
_Avoid_: Job, run, task, execution

**Provider**:
The coding-agent product a Session runs on: Claude Code or Codex.
_Avoid_: Model, backend, harness

**Trigger**:
A human change to a Board that runs Sessions, which starts or queues a Session on the affected Card: creating a Card, editing its description, posting a Comment, moving it between Columns, or pressing Try again after its last Session failed. kardboard itself writes three kinds and no more: `provider_fallback`, when a Session's Provider ran out of usage and the Card should be picked up again on the other one; `child_card_created`, on a Card a Session created as a child of another and left in Ready; and `children_done`, on a parent whose last child has reached Done.
_Avoid_: Event, webhook, action

**Claim**:
A Session's exclusive hold on its Card, taken by kardboard when the Session is created and released when it ends.
_Avoid_: Lock, lease

**Transcript**:
The record of what a Session did, read from its container log: the Agent's messages, its tool calls and their results. Visible to the Admin only, and live while the Session runs.
_Avoid_: History, output, trace

**Ledger**:
A Board's live list of active Sessions, each with its Card, branch, pull request, Provider, and announced intent, read by every Session at start.
_Avoid_: Registry, status board

**Preview**:
A temporary deployment of a Card's branch that Members use to review and test the change.
_Avoid_: Staging, demo, environment

**Approval**:
A Member's recorded sign-off, given through the Approve control on a Card in Review of a Board that runs Sessions, bound to the pull request revision the Member saw. kardboard, not a Session, performs the merge it authorizes. A later change to the pull request voids it. A Comment is never an Approval.
_Avoid_: Sign-off, LGTM, acceptance

**Pending re-run**:
The state of a Card that received a Trigger while a Session held its Claim; a new Session starts when the current one ends.
_Avoid_: Queued, dirty, stale

**Access token**:
The Admin's credential that lets a coding agent running outside kardboard act as the Agent on one Board that does not run Sessions.
_Avoid_: API key, personal access token, PAT

**Pause**:
The Admin's switch on a Board that runs Sessions that stops new Sessions starting there. Its Triggers wait, Sessions already running finish, and resuming dispatches what waited.
_Avoid_: Freeze, disable, hold

**Hygiene sweep**:
An Agent pass that checks every Card on a Board is in the right Column and corrects drift.
_Avoid_: Cleanup, grooming, triage
