import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-auth-mode-"));
process.env.KARDBOARD_DATA_DIR = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { resolveAuthMode } = await import("../src/env.js");

describe("which authentication the app runs", () => {
  it("is dev outside production when nothing is set, so local work and tests need no keys", () => {
    assert.equal(resolveAuthMode({ auth: "", production: false, preview: false }), "dev");
  });

  it("is clerk when asked for, however it is written", () => {
    assert.equal(resolveAuthMode({ auth: "clerk", production: true, preview: false }), "clerk");
    assert.equal(resolveAuthMode({ auth: " Clerk ", production: true, preview: false }), "clerk");
  });

  it("refuses dev in production, whether it was left unset or asked for", () => {
    assert.throws(() => resolveAuthMode({ auth: "", production: true, preview: false }), /Refusing to start/);
    assert.throws(() => resolveAuthMode({ auth: "dev", production: true, preview: false }), /Refusing to start/);
  });

  it("allows dev in a Preview container, which sits behind the preview router's membership check", () => {
    assert.equal(resolveAuthMode({ auth: "", production: true, preview: true }), "dev");
  });

  it("refuses a value it does not know rather than falling back to dev", () => {
    assert.throws(() => resolveAuthMode({ auth: "clerck", production: false, preview: false }), /must be "clerk" or "dev"/);
  });
});

describe("starting the app in production", () => {
  // A fresh process with the production image's environment. It runs from a scratch directory so no
  // developer .env is picked up.
  const envModule = fileURLToPath(new URL("../src/env.ts", import.meta.url));
  function start(extra: Record<string, string>) {
    const vars: Record<string, string> = { PATH: process.env.PATH ?? "", NODE_ENV: "production", KARDBOARD_DATA_DIR: root, ...extra };
    return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", `const { env } = await import(${JSON.stringify(envModule)}); console.log(env.authMode);`], { cwd: root, env: vars, encoding: "utf8" });
  }

  it("exits instead of running open when KARDBOARD_AUTH is missing", () => {
    const run = start({});
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Refusing to start/);
  });

  it("still starts a Preview", () => {
    const run = start({ KARDBOARD_PREVIEW_HOST: "abcd1234.kardboard.cc" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "dev");
  });
});
