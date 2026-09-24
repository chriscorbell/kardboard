import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

// images/agent/clis.sh never runs in CI's image build, so it runs here under the host's bash, with a
// fake `npm` that "installs" a shell script in place of each CLI. A fake CLI answers --version,
// --help, and `codex doctor --json` as the real ones do, reading the config the script wrote, and a
// version listed in FAKE_BROKEN drops a flag the entrypoint passes.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, "images/agent/clis.sh");
const entrypoint = fs.readFileSync(path.join(repoRoot, "images/agent/entrypoint.sh"), "utf8");

const FAKE_CLI = String.raw`#!/usr/bin/env bash
version="__VERSION__"
broken=0; for v in ${"$"}{FAKE_BROKEN:-}; do [ "$v" = "$version" ] && broken=1; done
case "$(basename "$0")" in
  claude)
    case "$1" in
      --version) echo "$version (Claude Code)" ;;
      --help) echo "  -p, --print  --model <m>  --mcp-config <f>  --permission-mode <m>  --output-format <f>  --verbose"; [ $broken = 1 ] || echo "  --allowedTools <t>" ;;
    esac ;;
  codex)
    case "$1" in
      --version) echo "codex-cli $version" ;;
      exec) echo "  --dangerously-bypass-approvals-and-sandbox  --skip-git-repo-check  -m, --model  -c, --config"; [ $broken = 1 ] || echo "  --strict-config" ;;
      --strict-config)
        servers=$(grep -c '^\[mcp_servers\.' "$CODEX_HOME/config.toml")
        if grep -q '^model_provider = "kardboard"' "$CODEX_HOME/config.toml"; then ws="Responses WebSocket is not enabled for the active provider"; else ws="Responses WebSocket reachable"; fi
        printf '{"checks":{"config.load":{"status":"ok"},"mcp.config":{"details":{"configured servers":"%s"}},"network.websocket_reachability":{"summary":"%s"}}}\n' "$servers" "$ws" ;;
    esac ;;
esac
`;

const FAKE_NPM = String.raw`#!/usr/bin/env bash
# npm install --global --prefix DIR ... PKG@VERSION
prefix=""; spec=""
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift 2 ;; -*|install) shift ;; *) spec="$1"; shift ;; esac; done
version="${"$"}{spec##*@}"
case "$spec" in @anthropic-ai/claude-code@*) bin=claude ;; @openai/codex@*) bin=codex ;; *) exit 1 ;; esac
[ "$version" = "0.0.404" ] && { echo "npm error 404" >&2; exit 1; }
mkdir -p "$prefix/bin"
sed "s/__VERSION__/$version/" "$FAKE_CLI_TEMPLATE" > "$prefix/bin/$bin"
chmod 755 "$prefix/bin/$bin"
`;

let dir: string;
let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-clis-"));
  root = path.join(dir, "volume");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, "fake-cli"), FAKE_CLI);
  fs.writeFileSync(path.join(bin, "npm"), FAKE_NPM, { mode: 0o755 });
  env = {
    PATH: `${bin}:${process.env.PATH}`,
    KARDBOARD_CLIS_DIR: root,
    KARDBOARD_CODEX_CONFIG: path.join(repoRoot, "images/agent/codex-config.sh"),
    FAKE_CLI_TEMPLATE: path.join(dir, "fake-cli"),
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function ensure(tool: string, version: string, extra: NodeJS.ProcessEnv = {}) {
  const res = spawnSync("bash", [script, "ensure", tool, version], { env: { ...env, ...extra }, encoding: "utf8" });
  return { status: res.status, log: res.stderr };
}
const current = (tool: string) => (fs.existsSync(path.join(root, tool, "current")) ? fs.readlinkSync(path.join(root, tool, "current")) : null);
const versions = (tool: string) => fs.readdirSync(path.join(root, tool)).filter((n) => !n.startsWith(".") && n !== "current").sort();

describe("kardboard-clis ensure", () => {
  it("installs a release, checks it, and makes it current", () => {
    assert.equal(ensure("claude-code", "2.1.282").status, 0);
    assert.equal(current("claude-code"), "2.1.282");
    assert.ok(fs.existsSync(path.join(root, "claude-code/2.1.282/.kardboard-checked")));
    assert.equal(ensure("codex", "0.156.1").status, 0);
    assert.equal(current("codex"), "0.156.1");
  });

  it("refuses a release that drops a flag the entrypoint passes, and keeps the current one", () => {
    ensure("codex", "0.156.1");
    const refused = ensure("codex", "0.157.0", { FAKE_BROKEN: "0.157.0" });
    assert.equal(refused.status, 1);
    assert.match(refused.log, /no longer lists --strict-config/);
    assert.match(refused.log, /Sessions stay on 0\.156\.1/);
    assert.equal(current("codex"), "0.156.1");
    assert.deepEqual(versions("codex"), ["0.156.1"], "the refused install is removed");

    const claude = ensure("claude-code", "2.1.283", { FAKE_BROKEN: "2.1.283" });
    assert.match(claude.log, /no longer lists --allowedTools/);
    assert.match(claude.log, /the version built into the image/);
  });

  it("checks Codex against the Session's own config: the MCP server, and no WebSocket past the proxy", () => {
    // A config without the egress provider would send inference over the WebSocket.
    const noEgress = path.join(dir, "no-egress.sh");
    fs.writeFileSync(noEgress, fs.readFileSync(env.KARDBOARD_CODEX_CONFIG!, "utf8").replace('if [ -n "${KARDBOARD_CODEX_EGRESS_URL:-}" ]', "if false"));
    const res = ensure("codex", "0.156.1", { KARDBOARD_CODEX_CONFIG: noEgress });
    assert.equal(res.status, 1);
    assert.match(res.log, /doctor did not accept the Session's config/);
  });

  it("takes a version out of use when it no longer passes a newer image's checks", () => {
    ensure("claude-code", "2.1.282");
    const res = ensure("claude-code", "2.1.282", { FAKE_BROKEN: "2.1.282" });
    assert.equal(res.status, 1);
    assert.equal(current("claude-code"), null);
    assert.match(res.log, /Sessions use the built-in version/);
  });

  it("replaces an install that died before its checks", () => {
    fs.mkdirSync(path.join(root, "codex/0.156.1/bin"), { recursive: true });
    assert.equal(ensure("codex", "0.156.1").status, 0);
    assert.ok(fs.existsSync(path.join(root, "codex/0.156.1/bin/codex")));
  });

  it("fails without touching anything when npm cannot install", () => {
    ensure("codex", "0.156.1");
    assert.equal(ensure("codex", "0.0.404").status, 1);
    assert.equal(current("codex"), "0.156.1");
    assert.deepEqual(versions("codex"), ["0.156.1"]);
  });

  it("takes only release versions and known tools", () => {
    assert.equal(ensure("codex", "latest").status, 2);
    assert.equal(ensure("codex", "1.0.0; touch pwned").status, 2);
    assert.equal(ensure("gemini", "1.0.0").status, 2);
    assert.ok(!fs.existsSync(path.join(root, "codex")) || versions("codex").length === 0);
  });

  it("keeps the newest two, and any older one replaced within the last three hours", () => {
    const hour = 3600;
    const now = Math.floor(Date.now() / 1000);
    for (const v of ["1.0.0", "1.0.1", "1.0.2"]) ensure("codex", v);
    // 1.0.0 was replaced when 1.0.1 arrived, four hours ago; 1.0.1 by 1.0.2, one hour ago.
    const stamp = (v: string, at: number) => fs.writeFileSync(path.join(root, "codex", v, ".kardboard-checked"), `${at}\n`);
    stamp("1.0.0", now - 6 * hour);
    stamp("1.0.1", now - 4 * hour);
    stamp("1.0.2", now - hour);
    ensure("codex", "1.0.3");
    assert.deepEqual(versions("codex"), ["1.0.1", "1.0.2", "1.0.3"], "1.0.1 was replaced an hour ago and stays");
    // Four hours on, 1.0.1 has been replaced for more than three and goes.
    stamp("1.0.1", now - 6 * hour);
    stamp("1.0.2", now - 5 * hour);
    stamp("1.0.3", now - 4 * hour);
    ensure("codex", "1.0.3");
    assert.deepEqual(versions("codex"), ["1.0.2", "1.0.3"]);
  });
});

describe("the entrypoint's choice of CLI", () => {
  const start = entrypoint.indexOf("use_cli() {");
  const fn = entrypoint.slice(start, entrypoint.indexOf("\n}\n", start) + 3);
  const pathFor = (tool: string) => execFileSync("bash", ["-c", `set -euo pipefail\n${fn}\nuse_cli ${tool}\necho "$PATH"`], { env: { PATH: "/usr/bin:/bin", KARDBOARD_CLIS_DIR: root }, encoding: "utf8" }).trim();

  it("runs the checked current version, by its own directory rather than the pointer", () => {
    ensure("claude-code", "2.1.282");
    assert.equal(pathFor("claude-code"), `${fs.realpathSync(path.join(root, "claude-code/2.1.282"))}/bin:/usr/bin:/bin`);
  });

  it("falls back to the image's own CLI when the volume has none", () => {
    assert.equal(pathFor("codex"), "/usr/bin:/bin");
    fs.mkdirSync(path.join(root, "codex/0.156.1/bin"), { recursive: true });
    fs.symlinkSync("0.156.1", path.join(root, "codex/current"));
    assert.equal(pathFor("codex"), "/usr/bin:/bin", "a version without the checked marker is never used");
  });
});
