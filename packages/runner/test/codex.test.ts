import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { CODEX_AUTH_STAGE, codexWiring } from "../src/codex.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("giving a Codex Session a credential", () => {
  const egressUrl = "http://egress:8787";

  it("points Codex at the proxy and mounts nothing when the proxy holds the sign-in file", () => {
    const wiring = codexWiring({ viaEgress: true, egressUrl, authFile: "" });
    assert.deepEqual(wiring, { env: ["KARDBOARD_CODEX_EGRESS_URL=http://egress:8787/openai"], binds: [] });
  });

  it("prefers the proxy over a mount when both are configured", () => {
    const wiring = codexWiring({ viaEgress: true, egressUrl, authFile: "/host/codex-auth.json" });
    assert.deepEqual("binds" in wiring && wiring.binds, [], "the container gets no credential of its own");
  });

  it("stages the host sign-in file read-only when the proxy does not hold it", () => {
    const wiring = codexWiring({ viaEgress: false, egressUrl, authFile: "/host/codex-auth.json" });
    assert.deepEqual(wiring, {
      env: [`KARDBOARD_CODEX_AUTH_STAGE=${CODEX_AUTH_STAGE}`],
      binds: [`/host/codex-auth.json:${CODEX_AUTH_STAGE}:ro`],
    });
  });

  it("never binds over the path Codex itself writes, which would make the refresh fail", () => {
    const wiring = codexWiring({ viaEgress: false, egressUrl, authFile: "/host/codex-auth.json" });
    assert.equal("binds" in wiring && wiring.binds.some((b) => b.includes("/.codex/auth.json")), false);
  });

  it("refuses a Session that would have no way to reach the provider", () => {
    const wiring = codexWiring({ viaEgress: false, egressUrl, authFile: "" });
    assert.equal("error" in wiring, true);
    assert.match("error" in wiring ? wiring.error : "", /KARDBOARD_CODEX_VIA_EGRESS|CODEX_AUTH_FILE/);
  });
});

// The image is built by CI, so nothing here runs Codex. These guard the two mistakes that made the
// Codex path fail silently: a flag Codex no longer accepts, and config keys it quietly ignores.
describe("the Session entrypoint's Codex invocation", () => {
  // Comments in the scripts explain the flags that were removed, so read only what bash will run.
  const code = (file: string) =>
    fs
      .readFileSync(path.join(repoRoot, "images/agent", file), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
  const script = code("entrypoint.sh");
  // The config.toml it writes, shared with the check a new Codex release must pass.
  const config = code("codex-config.sh");

  it("writes its config.toml from the shared config", () => {
    assert.match(script, /\. \/usr\/local\/lib\/kardboard\/codex-config\.sh/);
    assert.match(script, /codex_config > "\$CODEX_HOME\/config\.toml"/);
  });

  it("does not use --full-auto, which codex-cli 0.154 removed", () => {
    assert.equal(script.includes("--full-auto"), false);
  });

  it("carries the Session token in the environment rather than writing it into config.toml", () => {
    assert.match(config, /bearer_token_env_var = "KARDBOARD_TOKEN"/);
    assert.equal(/http_headers = .*KARDBOARD_TOKEN/.test(config + script), false);
  });

  it("asks Codex to reject configuration it does not recognise", () => {
    assert.match(script, /--strict-config/);
  });

  it("names a model provider when the proxy holds the credential, so the WebSocket transport is off", () => {
    assert.match(config, /model_provider = "kardboard"/);
    assert.match(config, /base_url = "\$KARDBOARD_CODEX_EGRESS_URL"/);
  });
});
