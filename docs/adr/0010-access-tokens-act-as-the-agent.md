---
status: accepted
date: 2026-09-28
---
# Access tokens act as the Agent, on one Board without Sessions, and only the Admin makes them

A Board without Sessions ([ADR 0009](0009-sessions-are-opt-in-per-board.md)) is still worked by a coding agent: the Admin's own, running on the Admin's machine. It needs to read and change the Board the way a Session does, so it reaches the same MCP endpoint with a bearer token. That token is an Access token: made by the Admin in the Board's settings, good for that one Board, stored only as a hash, and refused while the Board runs Sessions.

Whoever holds one acts as the Agent, not as the Admin. The Board then reads the same as a Board worked by Sessions: the Admin's own words are the Admin's, and the agent's are the Agent's, whichever machine the agent ran on. The event log names the token, so what one did can still be told apart after it is revoked. For notifications the token counts as the Admin's own action: moving the Admin's Card does not notify them.

## Considered options

- **Act as the Admin.** Simpler to explain, but the Board could no longer tell what the Admin wrote from what their agent wrote, and the agent's moves and edits would pass for decisions the Admin made by hand.
- **Tokens for any User, or for every Board.** Members are mostly clients with no agent of their own, and a token that reaches every Board is one leak away from all of them. One Board per token, and the Admin only, until there is a reason to widen either.
- **Tokens on Boards that run Sessions.** A second agent acting as the Agent would race the Sessions for the same Cards with no Claim to stop it. Refusing the token while Sessions are on keeps one kind of agent per Board. The token is kept, not revoked, so turning Sessions off again brings it back.

## Consequences

- An Access token is a bearer credential for a public endpoint. It has the `kbat_` prefix so a secret scanner can find it where it should not be.
- An agent holding one records a Card's pull request without kardboard asking GitHub anything, and merges it with the Admin's own credentials. A repository with the kardboard ruleset would refuse that merge unless the Admin can bypass the ruleset.
