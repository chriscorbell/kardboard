import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const entrypoint = fs.readFileSync(path.join(repoRoot, "images/agent/entrypoint.sh"), "utf8");

// The image is built by CI, so the entrypoint never runs in a test. Its time limit is a plain shell
// function, though, and runs the same under the host's bash with the environment a Session gets.
const start = entrypoint.indexOf("session_time_limit() {");
const fn = entrypoint.slice(start, entrypoint.indexOf("\n}\n", start) + 3);

function limit(env: { WALL_CLOCK_MINUTES: string; GITHUB_TOKEN_EXPIRES_AT?: string }): number {
  const out = execFileSync("bash", ["-c", `log() { :; }\n${fn}\nsession_time_limit`], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  return Number(out.trim());
}

const now = () => Math.floor(Date.now() / 1000);

describe("how long the Session's agent may run", () => {
  it("is the wall clock when there is no GitHub token", () => {
    assert.equal(limit({ WALL_CLOCK_MINUTES: "55" }), 55 * 60);
  });

  it("is the wall clock when the token outlasts it", () => {
    assert.equal(limit({ WALL_CLOCK_MINUTES: "55", GITHUB_TOKEN_EXPIRES_AT: String(now() + 3_600) }), 55 * 60);
  });

  it("stops two minutes before the token expires when the token runs out first", () => {
    // A slow image pull left the hour-long token 50 minutes by the time the container ran.
    const seconds = limit({ WALL_CLOCK_MINUTES: "55", GITHUB_TOKEN_EXPIRES_AT: String(now() + 50 * 60) });
    assert.ok(seconds <= 48 * 60 && seconds >= 48 * 60 - 2, String(seconds));
  });

  it("still gives a minute to a token that is all but expired, since `timeout 0` would mean no limit", () => {
    assert.equal(limit({ WALL_CLOCK_MINUTES: "55", GITHUB_TOKEN_EXPIRES_AT: String(now() + 30) }), 60);
  });

  it("keeps a fraction of a minute, and ignores an expiry it cannot read", () => {
    assert.equal(limit({ WALL_CLOCK_MINUTES: "0.5" }), 30);
    assert.equal(limit({ WALL_CLOCK_MINUTES: "55", GITHUB_TOKEN_EXPIRES_AT: "2026-09-24T12:00:00Z" }), 55 * 60);
  });

  it("is what both providers are run under", () => {
    const runs = entrypoint.split("\n").filter((line) => line.includes("exec timeout"));
    assert.equal(runs.length, 2);
    for (const line of runs) assert.match(line, /timeout --signal=TERM "\$\{TIME_LIMIT\}s"/);
  });
});
