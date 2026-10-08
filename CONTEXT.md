# kardboard

A kanban board for every project one person works on, kept up to date by that person and by their own coding agents, so work items and the side-findings agents mention stay visible in one place instead of across chat threads. Nothing on a Board starts on its own.

## Language

### People and actors

**User**:
The one person kardboard is for, whose projects the Boards track. Nobody signs in: kardboard knows the User only by the name they give the first time they open it.
_Avoid_: Admin, Member, owner, client, account

**Agent**:
The single non-human identity, with its own name and avatar, under which every coding agent holding an Access token acts on every Board. Named "Agent" by default.
_Avoid_: Bot, assistant, worker

**Access token**:
The User's credential that lets a coding agent act as the Agent on every Board.
_Avoid_: API key, personal access token, PAT

### Boards

**Board**:
The kanban board for exactly one project, usually with its repository. Owns its Cards.
_Avoid_: Project, workspace

**Column**:
One of the six fixed stages of a Board. Backlog holds new Cards not yet looked at. Blocked holds Cards waiting on the User's answer. Ready holds understood Cards nobody has started. In Progress holds Cards being worked on. Review holds Cards with a pull request open for a look. Done holds merged, closed, or duplicate Cards.
_Avoid_: List, lane, stage, status

**Card**:
A unit of work on a Board, with a title, description, Card type, Priority, and Comments. A Card sits in exactly one Column.
_Avoid_: Ticket, issue, task, item

**Card type**:
What kind of work a Card is: bug, feature, task, idea, or chore. Exactly one per Card, from that fixed set.
_Avoid_: Label, tag, category, kind

**Side-finding**:
Something an agent noticed while working on another task and filed as a Backlog Card instead of fixing it there.
_Avoid_: Follow-up, TODO, note

**Priority**:
A Card's urgency: none, low, medium, or high. Position within a Column is the finer ordering signal.
_Avoid_: Severity, urgency, rank

**Comment**:
A message posted on a Card by the User or the Agent. Authors may edit their own Comments.
_Avoid_: Note, reply, message

**Attachment**:
A file uploaded with a Comment.
_Avoid_: Upload, asset

**Overview**:
The page that shows every Board's Cards that need the User's attention at once.
_Avoid_: Dashboard, home page
