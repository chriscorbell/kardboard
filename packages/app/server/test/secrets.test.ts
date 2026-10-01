import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// The runner's and the preview router's tokens guard the internal routes, which the tunnel makes
// reachable from the internet. The database opens at import time, so it is pointed at a scratch
// directory first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-secrets-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_RUNNER_TOKEN = "test-runner-token";
process.env.KARDBOARD_ROUTER_TOKEN = "test-router-token";
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { runMigrations } = await import("../src/db/index.js");
const { hasBearer, sameSecret } = await import("../src/secrets.js");
const { internal } = await import("../src/routes/internal.js");

await runMigrations();

describe("comparing a secret", () => {
  it("matches only the same secret, whatever its length", () => {
    assert.equal(sameSecret("s3cret", "s3cret"), true);
    assert.equal(sameSecret("s3cre", "s3cret"), false);
    assert.equal(sameSecret("s3cret!", "s3cret"), false);
    assert.equal(sameSecret("S3cret", "s3cret"), false);
  });

  it("matches nothing when the secret was never set, not even an empty guess", () => {
    assert.equal(sameSecret("", ""), false);
    assert.equal(sameSecret("anything", ""), false);
  });

  it("reads a bearer token only from a header that says Bearer", () => {
    assert.equal(hasBearer("Bearer s3cret", "s3cret"), true);
    assert.equal(hasBearer("s3cret", "s3cret"), false);
    assert.equal(hasBearer("Basic s3cret", "s3cret"), false);
    assert.equal(hasBearer("Bearer ", "s3cret"), false);
    assert.equal(hasBearer(undefined, "s3cret"), false);
    assert.equal(hasBearer("Bearer ", ""), false);
  });
});

describe("the internal routes", () => {
  const previews = (authorization?: string) => internal.request("/previews", { headers: authorization ? { authorization } : {} });
  const exit = (authorization: string) =>
    internal.request("/sessions/no-such-session/exit", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ exitCode: 0 }) });

  it("refuse a caller without a token", async () => {
    assert.equal((await previews()).status, 401);
    assert.equal((await previews("Bearer wrong-token")).status, 401);
    assert.equal((await previews("test-router-token")).status, 401);
  });

  it("answer the preview router on its own routes, and only there", async () => {
    assert.equal((await previews("Bearer test-router-token")).status, 200);
    assert.equal((await exit("Bearer test-router-token")).status, 401);
  });

  it("answer the runner on its own routes, and only there", async () => {
    assert.equal((await exit("Bearer test-runner-token")).status, 200);
    assert.equal((await previews("Bearer test-runner-token")).status, 401);
  });
});
