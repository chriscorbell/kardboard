import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeMcpAddCommand } from "../src/routes/settings/accessTokens.js";

describe("the command that adds a Board to Claude Code", () => {
  it("points at this app's MCP endpoint with the token as a bearer header", () => {
    assert.equal(claudeMcpAddCommand("https://kardboard.cc", "kbat_abc"), 'claude mcp add --transport http kardboard https://kardboard.cc/mcp --header "Authorization: Bearer kbat_abc"');
  });
});
