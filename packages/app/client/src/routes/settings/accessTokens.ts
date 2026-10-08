// What the User pastes into a terminal to give Claude Code on their own machine this Board. Run from
// the project's folder, `claude mcp add` keeps the server to that project and to the User alone.
export function claudeMcpAddCommand(origin: string, secret: string): string {
  return `claude mcp add --transport http kardboard ${origin}/mcp --header "Authorization: Bearer ${secret}"`;
}
