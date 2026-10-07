---
status: accepted
date: 2026-10-07
---
# One Access token reaches every Board, and the agent names the Board

[ADR 0010](0010-access-tokens-act-as-the-agent.md) made an Access token good for one Board, so a leaked token reached one project and the MCP server needed no Board argument. Now that kardboard tracks every project the User has ([ADR 0011](0011-one-persons-board-worked-by-their-own-agents.md)), that design costs a token and an MCP install per project, and an agent working in one repository cannot file a Card it notices about another. So an Access token now reaches every Board, and the MCP tools say which Board they act on. An agent finds its Board from the repository it is working in, by matching the git remote to a Board's repository, and it can create a Board for a project that has none. One token, installed once in an agent's user-level configuration, works in every project.

Whoever holds a token still acts as the Agent, not as the User, for the reasons ADR 0010 gives: the Board must show what the User wrote apart from what their agents wrote.

## Considered options

- **One token per Board (ADR 0010).** The blast radius is smaller, but onboarding a project needs a visit to the settings and a per-project MCP configuration, which is the friction this change exists to remove. With one User and no Members, a token that reaches every Board reaches nothing the User could not already see.
- **The Board chosen by the MCP URL** (`/mcp/<board>`). The tools would stay unchanged, but onboarding would still need a per-project install, and an agent still could not file a Card on another project's Board.

## Consequences

- This decision supersedes ADR 0010. Tokens keep its `kbat_` prefix, its hashing, and its attribution in the event log.
- A leaked token can read and change every Board. Each token is named after where it runs and can be revoked from the settings.
- A Board's repository becomes optional. For a project with no repository, the agent names the Board explicitly.
