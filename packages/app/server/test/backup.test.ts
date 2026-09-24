import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createClient, type Client } from "@libsql/client";

// The service reads the data directory at import time, so point it at a scratch directory first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-backup-"));
process.env.KARDBOARD_DATA_DIR = path.join(root, "data");

const { lastScheduledTime, listSnapshots, pruneSnapshots, runDueBackup, snapshotFilename, takeSnapshot, verifySnapshot } = await import("../src/services/backup.js");

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
});
