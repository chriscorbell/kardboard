import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type { Me } from "@kardboard/shared";

// Signing in through Tailscale: Serve, on the same host, puts the tailnet user behind each request in
// `Tailscale-User-Login`, and the app lets in the one login it is given. Nothing here talks to
// Tailscale; the requests carry the headers Serve would add.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-tailscale-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "tailscale";
process.env.KARDBOARD_TAILSCALE_LOGIN = "chris@github";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");
const { decodeHeaderWord } = await import("../src/auth.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(async () => {
  await db.delete(schema.users);
  await db.insert(schema.users).values({ id: "user", email: "chris@example.com", name: "Chris" });
});

const me = (headers: Record<string, string>) => api.request("/me", { headers });

describe("signing in through Tailscale", () => {
  it("lets in the configured login, whatever its case", async () => {
    const res = await me({ "Tailscale-User-Login": "Chris@GitHub" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Me;
    assert.equal(body.user.id, "user");
    assert.equal(body.authMode, "tailscale");
  });

  it("turns away a request that did not come through Tailscale Serve", async () => {
    const res = await me({});
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthenticated" });
  });

  it("turns away any other Tailscale login", async () => {
    const res = await me({ "Tailscale-User-Login": "someone@github" });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "not_allowed" });
  });

  it("takes the User's name and avatar from their Tailscale profile", async () => {
    const res = await me({ "Tailscale-User-Login": "chris@github", "Tailscale-User-Name": "Chris Corbell", "Tailscale-User-Profile-Pic": "https://avatars.example.com/u/1" });
    const body = (await res.json()) as Me;
    assert.deepEqual([body.user.name, body.user.avatarUrl], ["Chris Corbell", "https://avatars.example.com/u/1"]);
    const row = (await db.select().from(schema.users).get())!;
    assert.deepEqual([row.name, row.avatarUrl], ["Chris Corbell", "https://avatars.example.com/u/1"]);
  });

  it("keeps the name it has when Tailscale sends none", async () => {
    const body = (await (await me({ "Tailscale-User-Login": "chris@github" })).json()) as Me;
    assert.equal(body.user.name, "Chris");
  });
});

describe("a header word Tailscale encoded", () => {
  it("reads a name written outside ASCII", () => {
    assert.equal(decodeHeaderWord("=?utf-8?q?Ren=C3=A9e_Fran=C3=A7ois?="), "Renée François");
    assert.equal(decodeHeaderWord("=?UTF-8?B?UmVuw6ll?="), "Renée");
  });

  it("leaves plain ASCII, and a word it cannot read, as written", () => {
    assert.equal(decodeHeaderWord("Chris Corbell"), "Chris Corbell");
    assert.equal(decodeHeaderWord("=?x-unknown?q?abc?="), "=?x-unknown?q?abc?=");
  });
});
