import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeMcpAddCommand, codexMcpAddCommands } from "../src/routes/settings/accessTokens.js";

describe("the commands that connect an agent to kardboard", () => {
  it("adds the server to Claude Code for the user, with the token as a bearer header", () => {
    assert.equal(claudeMcpAddCommand("https://kardboard.cc", "kbat_abc"), 'claude mcp add --scope user --transport http kardboard https://kardboard.cc/mcp --header "Authorization: Bearer kbat_abc"');
  });

  it("gives Codex the token through an environment variable", () => {
    assert.deepEqual(codexMcpAddCommands("https://kardboard.cc", "kbat_abc"), {
      env: "export KARDBOARD_TOKEN=kbat_abc",
      add: "codex mcp add kardboard --url https://kardboard.cc/mcp --bearer-token-env-var KARDBOARD_TOKEN",
    });
  });
});
