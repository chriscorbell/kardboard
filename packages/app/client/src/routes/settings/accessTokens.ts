// What the User pastes into a terminal to connect an agent on their own machine to every Board. Each
// installs the server for the user rather than for one project, so the agent has kardboard in every
// checkout and finds the Board from the repository it is in.

/** Claude Code: one command, the token travelling as a header in the user's own Claude config. */
export function claudeMcpAddCommand(origin: string, secret: string): string {
  return `claude mcp add --scope user --transport http kardboard ${origin}/mcp --header "Authorization: Bearer ${secret}"`;
}

// Codex reads a bearer token from an environment variable rather than taking it on the command line.
export const CODEX_TOKEN_VARIABLE = "KARDBOARD_TOKEN";

/** Codex: the variable to export from the shell profile, then the command that adds the server. */
export function codexMcpAddCommands(origin: string, secret: string): { env: string; add: string } {
  return {
    env: `export ${CODEX_TOKEN_VARIABLE}=${secret}`,
    add: `codex mcp add kardboard --url ${origin}/mcp --bearer-token-env-var ${CODEX_TOKEN_VARIABLE}`,
  };
}
