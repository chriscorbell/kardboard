import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { settingsSchema } from "@kardboard/shared";

// The database module opens its file at import time, so point it at a scratch directory first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-settings-"));
process.env.KARDBOARD_DATA_DIR = root;

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { getSettings, updateSettings } = await import("../src/services/settings.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(async () => {
  await db.delete(schema.settings);
});

describe("the Session wall clock", () => {
  it("cannot be set past the hour a Session's GitHub token lasts", () => {
    assert.equal(settingsSchema.safeParse({ sessionWallClockMinutes: 55 }).success, true);
    assert.equal(settingsSchema.safeParse({ sessionWallClockMinutes: 56 }).success, false);
  });

  it("reads a value stored before the cap as the cap", async () => {
    await db.insert(schema.settings).values({ key: "sessionWallClockMinutes", value: "240" });
    assert.equal((await getSettings()).sessionWallClockMinutes, 55);
  });

  it("keeps a value under the cap as it was saved", async () => {
    await updateSettings({ sessionWallClockMinutes: 30 });
    assert.equal((await getSettings()).sessionWallClockMinutes, 30);
  });

  it("falls back to the default for a value that is not a number", async () => {
    await db.insert(schema.settings).values({ key: "sessionWallClockMinutes", value: "soon" });
    assert.equal((await getSettings()).sessionWallClockMinutes, 45);
  });
});
