import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";

// The database module opens its file at import time, so point it at a scratch directory first. With
// no Resend key an email is logged and marked as such, which is enough to count them.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-alerts-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_PUBLIC_URL = "https://kardboard.test";
process.env.RESEND_API_KEY = "";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { alertAdmin, ALERT_DEDUPE_MS } = await import("../src/services/alerts.js");

await runMigrations();
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of [schema.outboundEmails, schema.settings, schema.users]) await db.delete(t);
  await db.insert(schema.users).values([
    { id: "admin", email: "root@example.com", handle: "root", name: "Root", role: "admin", status: "active" },
    { id: "admin-2", email: "second@example.com", handle: "second", name: "Second", role: "admin", status: "active" },
    { id: "invited-admin", email: "later@example.com", handle: "later", name: "Later", role: "admin", status: "invited" },
    { id: "revoked-admin", email: "gone@example.com", handle: "gone", name: "Gone", role: "admin", status: "revoked" },
    { id: "ada", email: "ada@example.com", handle: "ada", name: "Ada", role: "member", status: "active" },
  ]);
});

async function recipients(): Promise<string[]> {
  return (await db.select().from(schema.outboundEmails)).map((e) => e.toUserId).sort();
}

const NOW = new Date("2026-09-24T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("alertAdmin", () => {
  it("emails every active Admin and nobody else", async () => {
    assert.equal(await alertAdmin({ key: "test.one", subject: "Something broke", body: "Details." }, NOW), true);
    assert.deepEqual(await recipients(), ["admin", "admin-2"]);
    const email = (await db.select().from(schema.outboundEmails).where(eq(schema.outboundEmails.toUserId, "admin")).get())!;
    assert.equal(email.subject, "kardboard: Something broke");
    assert.match(email.html, /Details\./);
    assert.match(email.html, /https:\/\/kardboard\.test\/admin/);
  });

  it("sends the same key once in six hours, and again after", async () => {
    assert.equal(await alertAdmin({ key: "test.repeat", subject: "A", body: "a" }, NOW), true);
    assert.equal(await alertAdmin({ key: "test.repeat", subject: "A", body: "a" }, later(60_000)), false);
    assert.equal(await alertAdmin({ key: "test.repeat", subject: "A", body: "a" }, later(ALERT_DEDUPE_MS - 1)), false);
    assert.equal(await alertAdmin({ key: "test.other", subject: "B", body: "b" }, later(60_000)), true, "another key is another alert");
    assert.equal(await alertAdmin({ key: "test.repeat", subject: "A", body: "a" }, later(ALERT_DEDUPE_MS)), true);
    assert.equal((await recipients()).length, 6);
  });

  it("remembers what it sent in the database, so a restart does not send it again", async () => {
    await alertAdmin({ key: "test.persisted", subject: "A", body: "a" }, NOW);
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, "alert:test.persisted")).get();
    assert.equal(row?.value, NOW.toISOString());
  });

  it("gives the slot back when the emails could not be queued, so the next occurrence tries again", async () => {
    const insert = db.insert.bind(db);
    let failing = true;
    // Queueing an email is an insert into outbound_emails; fail that one, leave the claim alone.
    (db as { insert: unknown }).insert = ((table: unknown) => {
      if (failing && table === schema.outboundEmails) throw new Error("disk full");
      return insert(table as typeof schema.settings);
    }) as unknown;
    try {
      await assert.rejects(alertAdmin({ key: "test.retry", subject: "A", body: "a" }, NOW), /disk full/);
      assert.equal(await db.select().from(schema.settings).where(eq(schema.settings.key, "alert:test.retry")).get(), undefined);
      failing = false;
      assert.equal(await alertAdmin({ key: "test.retry", subject: "A", body: "a" }, later(1_000)), true);
    } finally {
      (db as { insert: unknown }).insert = insert;
    }
  });

  it("sends once when two callers race on one key", async () => {
    const results = await Promise.all([1, 2, 3].map(() => alertAdmin({ key: "test.race", subject: "A", body: "a" }, NOW)));
    assert.deepEqual(results.filter(Boolean).length, 1);
    assert.equal((await recipients()).length, 2);
  });
});
