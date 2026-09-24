import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createClient, type Client } from "@libsql/client";

// The service reads the data directory at import time, so point it at a scratch directory first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-backup-"));
process.env.KARDBOARD_DATA_DIR = path.join(root, "data");
// Zero would have the prune step remove the snapshot it had just written.
process.env.KARDBOARD_BACKUP_KEEP = "0";

process.env.RESEND_API_KEY = "";

const { backupsView, copyOffDisk, lastScheduledTime, listSnapshots, mirrorUploads, pruneSnapshots, restoreBackupState, runDueBackup, snapshotBeforeMigrations, snapshotFilename, takeSnapshot, verifySnapshot } =
  await import("../src/services/backup.js");
const { atLeastOne } = await import("../src/env.js");
const { db, schema, runMigrations } = await import("../src/db/index.js");

// The app's own database, for what the service keeps between restarts and the alerts it sends. The
// snapshots themselves are taken of throwaway databases below.
await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
async function sourceDb(): Promise<{ client: Client; file: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(root, `case-${n++}-`));
  const file = path.join(dir, "kardboard.db");
  const client = createClient({ url: `file:${file}` });
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("CREATE TABLE cards (id integer primary key, title text)");
  await client.execute("INSERT INTO cards (title) VALUES ('before')");
  return { client, file, dir: path.join(dir, "backups") };
}

async function titles(file: string): Promise<string[]> {
  const client = createClient({ url: `file:${file}` });
  try {
    const rows = await client.execute("SELECT title FROM cards ORDER BY id");
    return rows.rows.map((r) => String(r.title));
  } finally {
    client.close();
  }
}

describe("snapshot names", () => {
  it("stamps the file with whole UTC seconds", () => {
    assert.equal(snapshotFilename(new Date("2026-09-14T04:00:07.412Z")), "kardboard-20260914T040007Z.db");
    assert.equal(snapshotFilename(new Date("2026-09-14T04:00:07.412Z"), 2), "kardboard-20260914T040007Z-2.db");
  });

  it("marks a snapshot taken before migrations in its name", () => {
    assert.equal(snapshotFilename(new Date("2026-09-14T04:00:07.412Z"), 0, "pre_migrate"), "kardboard-pre-migrate-20260914T040007Z.db");
  });
});

describe("takeSnapshot", () => {
  it("captures committed rows, ignores later writes, and leaves one self-contained file", async () => {
    const { client, dir } = await sourceDb();
    const { snapshot } = await takeSnapshot({ client, dir, keep: 10 });
    await client.execute("INSERT INTO cards (title) VALUES ('after')");

    const file = path.join(dir, snapshot.name);
    assert.deepEqual(fs.readdirSync(dir), [snapshot.name]);
    assert.deepEqual(await titles(file), ["before"]);
    assert.deepEqual(await titles(path.join(dir, snapshot.name)), ["before"]);
    assert.ok(snapshot.bytes > 0);
    assert.equal(listSnapshots(dir)[0]?.name, snapshot.name);
    client.close();
  });

  it("captures rows a bare copy of the database file would miss", async () => {
    const { client, file, dir } = await sourceDb();
    const { snapshot } = await takeSnapshot({ client, dir, keep: 10 });

    // The row lives in the WAL until a checkpoint, which is why copying the database file is unsafe.
    const bare = path.join(dir, "bare-copy.db");
    fs.copyFileSync(file, bare);
    const bareTitles = await titles(bare).catch(() => null);
    assert.notDeepEqual(bareTitles, ["before"], "a bare copy should not match the snapshot");
    assert.deepEqual(await titles(path.join(dir, snapshot.name)), ["before"]);
    client.close();
  });

  it("does not overwrite a snapshot taken in the same second", async () => {
    const { client, dir } = await sourceDb();
    const at = new Date("2026-09-14T04:00:00.000Z");
    const first = await takeSnapshot({ client, dir, at, keep: 10 });
    const second = await takeSnapshot({ client, dir, at, keep: 10 });
    assert.equal(first.snapshot.name, "kardboard-20260914T040000Z.db");
    assert.equal(second.snapshot.name, "kardboard-20260914T040000Z-1.db");
    assert.equal(listSnapshots(dir).length, 2);
    client.close();
  });

  it("serialises snapshots started at the same moment", async () => {
    const { client, dir } = await sourceDb();
    const at = new Date("2026-09-14T04:00:00.000Z");
    const results = await Promise.all([takeSnapshot({ client, dir, at, keep: 10 }), takeSnapshot({ client, dir, at, keep: 10 })]);
    const names = results.map((r) => r.snapshot.name).sort();
    assert.deepEqual(names, ["kardboard-20260914T040000Z-1.db", "kardboard-20260914T040000Z.db"]);
    assert.deepEqual(fs.readdirSync(dir).sort(), names);
    client.close();
  });

  it("publishes nothing when the copy fails verification", async () => {
    const { dir } = await sourceDb();
    const broken = {
      execute: async ({ args }: { args: string[] }) => {
        fs.mkdirSync(path.dirname(args[0]!), { recursive: true });
        fs.writeFileSync(args[0]!, "not a database");
        return {};
      },
    } as unknown as Client;
    await assert.rejects(takeSnapshot({ client: broken, dir, keep: 10 }));
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.deepEqual(listSnapshots(dir), []);
  });

  it("prunes to the newest snapshots it is told to keep", async () => {
    const { client, dir } = await sourceDb();
    for (const day of [11, 12, 13]) await takeSnapshot({ client, dir, at: new Date(`2026-09-${day}T04:00:00.000Z`), keep: 10 });
    const { pruned } = await takeSnapshot({ client, dir, at: new Date("2026-09-14T04:00:00.000Z"), keep: 2 });
    assert.deepEqual(pruned, ["kardboard-20260912T040000Z.db", "kardboard-20260911T040000Z.db"]);
    assert.deepEqual(
      listSnapshots(dir).map((s) => s.name),
      ["kardboard-20260914T040000Z.db", "kardboard-20260913T040000Z.db"],
    );
    client.close();
  });
});

describe("how many snapshots to keep", () => {
  it("is never fewer than one, so the snapshot just written survives its own prune", async () => {
    const { client, dir } = await sourceDb();
    for (const day of [11, 12]) await takeSnapshot({ client, dir, at: new Date(`2026-09-${day}T04:00:00.000Z`), keep: 10 });
    for (const keep of [0, -3, Number.NaN]) {
      const { snapshot } = await takeSnapshot({ client, dir, keep });
      assert.deepEqual(
        listSnapshots(dir).map((s) => s.name),
        [snapshot.name],
      );
    }
    client.close();
  });

  it("reads KARDBOARD_BACKUP_KEEP as at least one, and a value that is not a number as the default", () => {
    assert.equal(backupsView().keep, 1, "KARDBOARD_BACKUP_KEEP=0 in this test's environment");
    assert.equal(atLeastOne("KEEP", "0", 14), 1);
    assert.equal(atLeastOne("KEEP", "-2", 14), 1);
    assert.equal(atLeastOne("KEEP", "fourteen", 14), 14);
    assert.equal(atLeastOne("KEEP", "7", 14), 7);
    assert.equal(atLeastOne("KEEP", "", 14), 14);
  });
});

describe("a snapshot that hangs", () => {
  it("is abandoned after its timeout, leaves nothing behind, and does not hold up the next one", async () => {
    const { client, dir } = await sourceDb();
    const stuck = { execute: () => new Promise(() => {}) } as unknown as Client;

    await assert.rejects(takeSnapshot({ client: stuck, dir, keep: 10, timeoutMs: 50 }), /did not finish/);
    assert.equal(backupsView().lastAttempt?.ok, false);
    assert.match(backupsView().lastAttempt?.error ?? "", /did not finish/);

    const { snapshot } = await takeSnapshot({ client, dir, keep: 10 });
    assert.deepEqual(fs.readdirSync(dir), [snapshot.name]);
    assert.equal(backupsView().lastAttempt?.ok, true);
    assert.equal(backupsView().lastAttempt?.error, null);
    client.close();
  });
});

describe("verifySnapshot", () => {
  it("rejects a file that is not a readable database", async () => {
    const file = path.join(root, "junk.db");
    fs.writeFileSync(file, "not a database");
    await assert.rejects(verifySnapshot(file));
  });

  it("rejects an empty database with no tables", async () => {
    const file = path.join(root, "empty.db");
    const client = createClient({ url: `file:${file}` });
    await client.execute("PRAGMA user_version = 1");
    client.close();
    await assert.rejects(verifySnapshot(file), /no tables/);
  });
});

describe("the daily schedule", () => {
  it("resolves the most recent occurrence of the hour", () => {
    const hour = 4;
    const morning = lastScheduledTime(new Date(2026, 8, 14, 9, 30), hour);
    assert.equal(morning.getDate(), 14);
    assert.equal(morning.getHours(), hour);
    const beforeHour = lastScheduledTime(new Date(2026, 8, 14, 1, 30), hour);
    assert.equal(beforeHour.getDate(), 13);
    assert.equal(beforeHour.getHours(), hour);
  });

  it("takes one snapshot per scheduled hour and catches up after downtime", async () => {
    const { client, dir } = await sourceDb();
    const opts = { client, dir, keep: 10, hour: 4 };

    const first = await runDueBackup(new Date(2026, 8, 14, 9, 0), opts);
    assert.ok(first, "the first run has nothing on disk and takes a snapshot");
    assert.equal(await runDueBackup(new Date(2026, 8, 14, 23, 59), opts), null, "the hour has already been served");
    assert.equal(await runDueBackup(new Date(2026, 8, 15, 3, 59), opts), null, "the next hour has not arrived");
    // The server was down at 04:00 and comes back at noon: the missed snapshot is taken on the next tick.
    assert.ok(await runDueBackup(new Date(2026, 8, 15, 12, 0), opts));
    assert.equal(listSnapshots(dir).length, 2);
    client.close();
  });

  it("stays off when the hour is out of range", async () => {
    const { client, dir } = await sourceDb();
    assert.equal(await runDueBackup(new Date(), { client, dir, hour: -1 }), null);
    assert.deepEqual(listSnapshots(dir), []);
    client.close();
  });
});

describe("pruneSnapshots", () => {
  it("leaves unrelated files alone and clears only abandoned partials", () => {
    const dir = fs.mkdtempSync(path.join(root, "prune-"));
    const write = (name: string, mtime?: Date) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, "x");
      if (mtime) fs.utimesSync(file, mtime, mtime);
    };
    const now = new Date("2026-09-14T04:00:00.000Z");
    write("kardboard-20260913T040000Z.db");
    write("kardboard-20260914T040000Z.db");
    write("notes.txt");
    write("kardboard-20260914T040000Z-1.db.partial", new Date("2026-09-13T04:00:00.000Z"));
    write("kardboard-20260914T035900Z.db.partial", now);

    const removed = pruneSnapshots(1, dir, now);
    assert.deepEqual(removed, ["kardboard-20260913T040000Z.db", "kardboard-20260914T040000Z-1.db.partial"]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["kardboard-20260914T035900Z.db.partial", "kardboard-20260914T040000Z.db", "notes.txt"]);
  });

  it("keeps each kind to the count on its own, so deploys cannot push the daily snapshots out", () => {
    const dir = fs.mkdtempSync(path.join(root, "prune-kinds-"));
    for (const name of [
      "kardboard-20260911T040000Z.db",
      "kardboard-20260912T040000Z.db",
      "kardboard-pre-migrate-20260912T120000Z.db",
      "kardboard-pre-migrate-20260913T120000Z.db",
      "kardboard-pre-migrate-20260913T180000Z.db",
    ]) {
      fs.writeFileSync(path.join(dir, name), "x");
    }
    assert.deepEqual(
      listSnapshots(dir).map((s) => [s.name, s.kind]),
      [
        ["kardboard-pre-migrate-20260913T180000Z.db", "pre_migrate"],
        ["kardboard-pre-migrate-20260913T120000Z.db", "pre_migrate"],
        ["kardboard-pre-migrate-20260912T120000Z.db", "pre_migrate"],
        ["kardboard-20260912T040000Z.db", "regular"],
        ["kardboard-20260911T040000Z.db", "regular"],
      ],
    );
    assert.deepEqual(pruneSnapshots(2, dir).sort(), ["kardboard-pre-migrate-20260912T120000Z.db"]);
  });
});

describe("the snapshot before migrations", () => {
  // A migrations folder whose journal has one entry the database has and one it does not.
  function journal(entries: number[]): string {
    const folder = fs.mkdtempSync(path.join(root, "drizzle-"));
    fs.mkdirSync(path.join(folder, "meta"));
    fs.writeFileSync(path.join(folder, "meta", "_journal.json"), JSON.stringify({ entries: entries.map((when, idx) => ({ idx, when, tag: `000${idx}` })) }));
    return folder;
  }

  async function migratedDb(applied: number[]) {
    const source = await sourceDb();
    await source.client.execute("CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)");
    for (const at of applied) await source.client.execute({ sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h', ?)", args: [at] });
    return source;
  }

  it("is taken when the journal has migrations the database has not had, and named for it", async () => {
    const { client, dir } = await migratedDb([1000]);
    const snapshot = await snapshotBeforeMigrations({ client, dir, folder: journal([1000, 2000, 3000]), at: new Date("2026-09-24T10:00:00.000Z"), copyDir: null });
    assert.equal(snapshot?.name, "kardboard-pre-migrate-20260924T100000Z.db");
    assert.equal(snapshot?.kind, "pre_migrate");
    assert.deepEqual(await titles(path.join(dir, snapshot!.name)), ["before"]);
    client.close();
  });

  it("is not taken when every migration is applied, or for a new database with none", async () => {
    const current = await migratedDb([1000, 2000]);
    assert.equal(await snapshotBeforeMigrations({ client: current.client, dir: current.dir, folder: journal([1000, 2000]), copyDir: null }), null);
    const fresh = await sourceDb();
    assert.equal(await snapshotBeforeMigrations({ client: fresh.client, dir: fresh.dir, folder: journal([1000]), copyDir: null }), null);
    assert.deepEqual(listSnapshots(current.dir), []);
    assert.deepEqual(listSnapshots(fresh.dir), []);
    current.client.close();
    fresh.client.close();
  });

  it("does not stand in for the daily snapshot", async () => {
    const { client, dir } = await migratedDb([1000]);
    await snapshotBeforeMigrations({ client, dir, folder: journal([1000, 2000]), at: new Date(2026, 8, 14, 9, 0), copyDir: null });
    const daily = await runDueBackup(new Date(2026, 8, 14, 9, 30), { client, dir, keep: 10, hour: 4, copyDir: null });
    assert.equal(daily?.kind, "regular", "a pre-migration snapshot after the hour does not count as the day's");
    client.close();
  });
});

describe("copying off the disk", () => {
  function uploads(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(root, "uploads-"));
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.join(dir, name.slice(0, 2)), { recursive: true });
      fs.writeFileSync(path.join(dir, name.slice(0, 2), name), body);
    }
    return dir;
  }

  it("copies each snapshot, prunes the copies to the same count, and brings attachments up to date", async () => {
    const { client, dir } = await sourceDb();
    const copyDir = path.join(fs.mkdtempSync(path.join(root, "nas-")), "kardboard");
    const uploadsDir = uploads({ aa11: "first", bb22: "second" });

    const first = await takeSnapshot({ client, dir, keep: 2, copyDir, uploadsDir, at: new Date("2026-09-12T04:00:00.000Z") });
    assert.deepEqual(first.copy && [first.copy.ok, first.copy.snapshot, first.copy.uploadsCopied], [true, "kardboard-20260912T040000Z.db", 2]);
    assert.deepEqual(await titles(path.join(copyDir, "kardboard-20260912T040000Z.db")), ["before"]);
    assert.equal(fs.readFileSync(path.join(copyDir, "uploads", "aa", "aa11"), "utf8"), "first");

    fs.mkdirSync(path.join(uploadsDir, "cc"));
    fs.writeFileSync(path.join(uploadsDir, "cc", "cc33"), "third");
    const second = await takeSnapshot({ client, dir, keep: 2, copyDir, uploadsDir, at: new Date("2026-09-13T04:00:00.000Z") });
    assert.equal(second.copy?.uploadsCopied, 1, "only the attachment the copy did not have");
    await takeSnapshot({ client, dir, keep: 2, copyDir, uploadsDir, at: new Date("2026-09-14T04:00:00.000Z") });

    assert.deepEqual(
      listSnapshots(copyDir).map((s) => s.name),
      ["kardboard-20260914T040000Z.db", "kardboard-20260913T040000Z.db"],
    );
    assert.deepEqual(fs.readdirSync(path.join(copyDir, "uploads")).sort(), ["aa", "bb", "cc"]);
    assert.equal(backupsView().lastCopy?.snapshot, "kardboard-20260914T040000Z.db");
    client.close();
  });

  it("reports a copy that fails without failing the snapshot or touching the ones on disk", async () => {
    const { client, dir } = await sourceDb();
    const before = await takeSnapshot({ client, dir, keep: 10, copyDir: null, at: new Date("2026-09-12T04:00:00.000Z") });
    // A file where the directory should be: nothing can be written under it.
    const blocked = path.join(fs.mkdtempSync(path.join(root, "blocked-")), "not-a-dir");
    fs.writeFileSync(blocked, "x");

    const { snapshot, copy } = await takeSnapshot({ client, dir, keep: 10, copyDir: blocked, uploadsDir: uploads({}) });
    assert.equal(copy?.ok, false);
    assert.ok(copy?.error);
    assert.deepEqual(
      listSnapshots(dir).map((s) => s.name),
      [snapshot.name, before.snapshot.name],
    );
    assert.equal(backupsView().lastCopy?.ok, false);
    assert.equal(backupsView().lastAttempt?.ok, true, "the snapshot itself succeeded");
    client.close();
  });

  it("mirrors nothing from an uploads directory that does not exist yet", async () => {
    const target = fs.mkdtempSync(path.join(root, "mirror-"));
    assert.equal(await mirrorUploads(path.join(root, "no-uploads-here"), target), 0);
  });

  it("does not leave a partial copy behind", async () => {
    const { client, dir } = await sourceDb();
    const { snapshot } = await takeSnapshot({ client, dir, keep: 10, copyDir: null });
    const copyDir = fs.mkdtempSync(path.join(root, "copy-"));
    const copy = await copyOffDisk(path.join(dir, snapshot.name), { copyDir, keep: 10, uploadsDir: uploads({ dd44: "x" }) });
    assert.equal(copy.ok, true);
    assert.deepEqual(fs.readdirSync(copyDir).sort(), [snapshot.name, "uploads"]);
    assert.deepEqual(fs.readdirSync(path.join(copyDir, "uploads", "dd")), ["dd44"]);
    client.close();
  });
});

describe("what is kept across a restart", () => {
  it("writes the last attempt and copy through once restored, and sends the alerts raised before then", async () => {
    await db.delete(schema.users);
    await db.insert(schema.users).values({ id: "admin", email: "root@example.com", handle: "root", name: "Root", role: "admin", status: "active" });
    // The failed copy above raised an alert before the app's database was declared ready.
    await restoreBackupState();
    for (let i = 0; i < 50 && (await db.select().from(schema.outboundEmails)).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const emails = await db.select().from(schema.outboundEmails);
    assert.deepEqual(
      emails.map((e) => e.subject),
      ["kardboard: A backup could not be copied off the disk"],
    );

    const { client, dir } = await sourceDb();
    await takeSnapshot({ client, dir, keep: 10, copyDir: null });
    const saved = await db.select().from(schema.settings);
    const attempt = JSON.parse(saved.find((r) => r.key === "backup:lastAttempt")!.value) as { ok: boolean };
    assert.equal(attempt.ok, true);
    assert.ok(saved.find((r) => r.key === "backup:lastCopy"), "the last copy is kept too");
    client.close();
  });
});
