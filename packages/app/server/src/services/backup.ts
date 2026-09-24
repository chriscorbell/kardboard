import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import type { BackupSnapshot, BackupsView } from "@kardboard/shared";
import { client as liveClient, dbFile } from "../db/index.js";
import { env } from "../env.js";

// A snapshot is one self-contained file written by `VACUUM INTO`, never a copy of the live database
// and its WAL: see docs/adr/0004-sqlite-in-a-single-server-process.md. Restoring is an operator
// procedure with the app stopped, documented in docs/runbooks/backups.md.
const SNAPSHOT_RE = /^kardboard-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-\d+)?\.db$/;
const PARTIAL_SUFFIX = ".partial";
const STALE_PARTIAL_MS = 60 * 60_000;
const TICK_MS = 60_000;

export interface SnapshotOptions {
  client?: Client;
  dir?: string;
  at?: Date;
  keep?: number;
}

export function snapshotFilename(at: Date, attempt = 0): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `kardboard-${stamp}${attempt > 0 ? `-${attempt}` : ""}.db`;
}

function takenAtOf(name: string): string | null {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
}

export function listSnapshots(dir: string = env.backupDir): BackupSnapshot[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackupSnapshot[] = [];
  for (const name of names) {
    const takenAt = takenAtOf(name);
    if (!takenAt) continue;
    const stat = fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    out.push({ name, bytes: stat.size, takenAt });
  }
  // Names carry a UTC stamp, so lexical order is chronological. Newest first.
  return out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

// Keeps the newest `keep` snapshots and removes the rest, along with abandoned partial files from
// an interrupted run. Returns what it removed.
export function pruneSnapshots(keep: number, dir: string = env.backupDir, now = new Date()): string[] {
  const removed: string[] = [];
  for (const snapshot of listSnapshots(dir).slice(Math.max(keep, 0))) {
    fs.rmSync(path.join(dir, snapshot.name), { force: true });
    removed.push(snapshot.name);
  }
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.endsWith(PARTIAL_SUFFIX)) continue;
    const file = path.join(dir, name);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && now.getTime() - stat.mtimeMs < STALE_PARTIAL_MS) continue;
    fs.rmSync(file, { force: true });
    removed.push(name);
  }
  return removed;
}

// Opens the finished file as its own database and checks it end to end. A snapshot that cannot be
// read here would be worthless in a recovery, so a failure removes it rather than publishing it.
export async function verifySnapshot(file: string): Promise<void> {
  const check = createClient({ url: `file:${file}` });
  try {
    const integrity = await check.execute("PRAGMA integrity_check");
    const result = integrity.rows[0]?.[0];
    if (result !== "ok") throw new Error(`integrity_check returned ${String(result)}`);
    const tables = await check.execute("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'");
    if (Number(tables.rows[0]?.n ?? 0) === 0) throw new Error("snapshot contains no tables");
  } finally {
    check.close();
  }
}

// Reading a snapshot can leave -wal/-shm beside it. A snapshot must be one self-contained file.
function removeSidecars(file: string): void {
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
}

// The scheduler and the admin button share one queue: two snapshots started in the same second would
// otherwise pick the same name and fight over the partial file.
let queue: Promise<unknown> = Promise.resolve();

export function takeSnapshot(options: SnapshotOptions = {}): Promise<{ snapshot: BackupSnapshot; pruned: string[] }> {
  const run = queue.then(
    () => writeSnapshot(options),
    () => writeSnapshot(options),
  );
  queue = run.catch(() => undefined);
  return run;
}

async function writeSnapshot(options: SnapshotOptions): Promise<{ snapshot: BackupSnapshot; pruned: string[] }> {
  const dir = options.dir ?? env.backupDir;
  const client = options.client ?? liveClient;
  const at = options.at ?? new Date();
  const keep = options.keep ?? env.backupKeep;

  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, snapshotFilename(at));
  for (let attempt = 1; fs.existsSync(file); attempt++) file = path.join(dir, snapshotFilename(at, attempt));
  const partial = `${file}${PARTIAL_SUFFIX}`;
  fs.rmSync(partial, { force: true });

  try {
    // VACUUM INTO refuses to overwrite, so the partial name is both a lock and a crash marker.
    await client.execute({ sql: "VACUUM INTO ?", args: [partial] });
    await verifySnapshot(partial);
    removeSidecars(partial);
    fs.renameSync(partial, file);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    removeSidecars(partial);
    throw err;
  }

  const name = path.basename(file);
  const snapshot: BackupSnapshot = { name, bytes: fs.statSync(file).size, takenAt: takenAtOf(name) ?? at.toISOString() };
  return { snapshot, pruned: pruneSnapshots(keep, dir, at) };
}

// The most recent time the configured hour passed, in local time.
export function lastScheduledTime(now: Date, hour: number): Date {
  const due = new Date(now);
  due.setHours(hour, 0, 0, 0);
  if (due.getTime() > now.getTime()) due.setDate(due.getDate() - 1);
  return due;
}

// Takes the daily snapshot when the newest one on disk predates the last scheduled time. Disk is the
// only state, so a restart, a missed hour, or downtime over the scheduled time still gets a snapshot.
export async function runDueBackup(now = new Date(), options: SnapshotOptions & { hour?: number } = {}): Promise<BackupSnapshot | null> {
  const hour = options.hour ?? env.backupHour;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const dir = options.dir ?? env.backupDir;
  const due = lastScheduledTime(now, hour);
  const latest = listSnapshots(dir)[0];
  if (latest && Date.parse(latest.takenAt) >= due.getTime()) return null;
  const { snapshot, pruned } = await takeSnapshot({ ...options, at: now, dir });
  console.log(`[backup] wrote ${snapshot.name} (${snapshot.bytes} bytes)${pruned.length ? `, removed ${pruned.join(", ")}` : ""}`);
  return snapshot;
}

export function startBackupScheduler(): void {
  if (env.backupHour < 0) {
    console.log("[backup] scheduled snapshots are off (KARDBOARD_BACKUP_HOUR is negative)");
    return;
  }
  const tick = () => void runDueBackup().catch((err) => console.error("[backup] snapshot failed", err));
  tick();
  setInterval(tick, TICK_MS);
}

function databaseBytes(): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) total += fs.statSync(`${dbFile}${suffix}`, { throwIfNoEntry: false })?.size ?? 0;
  return total;
}

export function backupsView(): BackupsView {
  return { dir: env.backupDir, hour: env.backupHour, keep: env.backupKeep, databaseBytes: databaseBytes(), snapshots: listSnapshots() };
}
