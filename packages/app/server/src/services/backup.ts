import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { BackupAttempt, BackupCopy, BackupSnapshot, BackupsView } from "@kardboard/shared";
import { client as liveClient, dbFile, pendingMigrations } from "../db/index.js";
import { env } from "../env.js";
import { alertAdmin, type AdminAlert } from "./alerts.js";
import { getSettingValue, setSettingValue } from "./settings.js";

// A snapshot is one self-contained file written by `VACUUM INTO`, never a copy of the live database
// and its WAL: see docs/adr/0004-sqlite-in-a-single-server-process.md. Restoring is an operator
// procedure with the app stopped, documented in docs/runbooks/backups.md.
//
// Two kinds share the directory. The daily snapshot, also taken on demand, is `kardboard-<stamp>.db`.
// One taken at boot because a new image is about to migrate the schema is
// `kardboard-pre-migrate-<stamp>.db`. Each kind is pruned to the keep count on its own, so a run of
// deploys cannot push the daily snapshots out, and the daily schedule looks only at its own kind.
const SNAPSHOT_RE = /^kardboard-(pre-migrate-)?(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d+))?\.db$/;
const PARTIAL_SUFFIX = ".partial";
const STALE_PARTIAL_MS = 60 * 60_000;
const TICK_MS = 60_000;
// Far longer than a snapshot of this database takes. Past it the run is abandoned, so one that hangs
// cannot hold the queue, and with it every later snapshot.
const SNAPSHOT_TIMEOUT_MS = 15 * 60_000;
// The same for the copy, which usually goes to a network mount that can stall without failing.
const COPY_TIMEOUT_MS = 15 * 60_000;

type SnapshotKind = BackupSnapshot["kind"];

export interface SnapshotOptions {
  client?: Client;
  dir?: string;
  at?: Date;
  keep?: number;
  timeoutMs?: number;
  kind?: SnapshotKind;
  /** Where to copy the snapshot off the disk; null for nowhere. `KARDBOARD_BACKUP_COPY_DIR` when left out. */
  copyDir?: string | null;
  /** The attachments directory mirrored alongside the copy. `<data dir>/uploads` when left out. */
  uploadsDir?: string;
}

// Never fewer than one: the snapshot just written is always kept, whatever `keep` says.
const atLeastOne = (keep: number) => (Number.isFinite(keep) ? Math.max(1, Math.floor(keep)) : 1);

export function snapshotFilename(at: Date, attempt = 0, kind: SnapshotKind = "regular"): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `kardboard-${kind === "pre_migrate" ? "pre-migrate-" : ""}${stamp}${attempt > 0 ? `-${attempt}` : ""}.db`;
}

function parseName(name: string): { takenAt: string; kind: SnapshotKind; attempt: number } | null {
  const m = SNAPSHOT_RE.exec(name);
  if (!m) return null;
  const [, pre, y, mo, d, h, mi, s, attempt] = m;
  return { takenAt: `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`, kind: pre ? "pre_migrate" : "regular", attempt: Number(attempt ?? 0) };
}

function attemptOf(name: string): number {
  return parseName(name)?.attempt ?? 0;
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
    const parsed = parseName(name);
    if (!parsed) continue;
    const stat = fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    out.push({ name, bytes: stat.size, takenAt: parsed.takenAt, kind: parsed.kind });
  }
  // Newest first, by the UTC stamp and then by the suffix a second snapshot in the same second
  // carries. Plain name order would put `…Z-1.db` before `…Z.db` and prune the newer one.
  return out.sort((a, b) => (a.takenAt !== b.takenAt ? (a.takenAt < b.takenAt ? 1 : -1) : attemptOf(b.name) - attemptOf(a.name)));
}

// Keeps the newest `keep` snapshots of each kind and removes the rest, along with abandoned partial
// files from an interrupted run. Returns what it removed.
export function pruneSnapshots(keep: number, dir: string = env.backupDir, now = new Date()): string[] {
  const removed: string[] = [];
  const all = listSnapshots(dir);
  for (const kind of ["regular", "pre_migrate"] as const) {
    for (const snapshot of all.filter((s) => s.kind === kind).slice(atLeastOne(keep))) {
      fs.rmSync(path.join(dir, snapshot.name), { force: true });
      removed.push(snapshot.name);
    }
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

function withTimeout<T>(work: Promise<T>, ms: number, what = "the snapshot"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)} s and was abandoned`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---- state kept for the Admin panel ----

// The last attempt and the last copy survive a restart as rows, so a failure in the night is still
// on the Backups tab after the morning's deploy. Until `restoreBackupState` runs, which is after
// migrations, they live in memory only: the snapshot before migrations must not write to a schema
// that is about to change.
const ATTEMPT_KEY = "backup:lastAttempt";
const COPY_KEY = "backup:lastCopy";
const state: { lastAttempt: BackupAttempt | null; lastCopy: BackupCopy | null } = { lastAttempt: null, lastCopy: null };
let persistent = false;
// Alerts raised before the database was ready, sent once it is.
const deferred: AdminAlert[] = [];

function parseState<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function saveState(): Promise<void> {
  if (!persistent) return;
  try {
    if (state.lastAttempt) await setSettingValue(ATTEMPT_KEY, JSON.stringify(state.lastAttempt));
    if (state.lastCopy) await setSettingValue(COPY_KEY, JSON.stringify(state.lastCopy));
  } catch (err) {
    console.error("[backup] could not save the last result", err);
  }
}

/** Reads the last attempt and copy back after a restart, and from then on writes each one through. */
export async function restoreBackupState(): Promise<void> {
  state.lastAttempt ??= parseState<BackupAttempt>(await getSettingValue(ATTEMPT_KEY));
  state.lastCopy ??= parseState<BackupCopy>(await getSettingValue(COPY_KEY));
  persistent = true;
  await saveState();
  for (const alert of deferred.splice(0)) raise(alert);
}

function raise(alert: AdminAlert): void {
  if (!persistent) {
    deferred.push(alert);
    return;
  }
  void alertAdmin({ path: "/admin/backups", ...alert }).catch((err) => console.error("[backup] could not send an alert", err));
}

// ---- the copy off the disk ----

/**
 * Copies `from` to `to` through a partial file, so a copy cut short never looks finished, and checks
 * the size came out the same. The copy directory is usually a network mount.
 */
async function copyFileSafely(from: string, to: string): Promise<void> {
  const partial = `${to}${PARTIAL_SUFFIX}`;
  await fsp.copyFile(from, partial);
  const [source, copy] = await Promise.all([fsp.stat(from), fsp.stat(partial)]);
  if (source.size !== copy.size) {
    await fsp.rm(partial, { force: true });
    throw new Error(`the copy of ${path.basename(from)} came out ${copy.size} bytes instead of ${source.size}`);
  }
  await fsp.rename(partial, to);
}

/**
 * Copies every attachment the copy directory does not have yet. Attachments are named by the SHA-256
 * of their bytes and never change, so a file already there with the same size is the same file.
 * Nothing is ever removed from the copy. Returns how many were copied.
 */
export async function mirrorUploads(from: string, to: string): Promise<number> {
  let copied = 0;
  const walk = async (dir: string, target: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const source = path.join(dir, entry.name);
      const dest = path.join(target, entry.name);
      if (entry.isDirectory()) {
        await walk(source, dest);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith(PARTIAL_SUFFIX)) continue;
      const [have, want] = await Promise.all([fsp.stat(dest).catch(() => null), fsp.stat(source)]);
      if (have?.size === want.size) continue;
      await fsp.mkdir(target, { recursive: true });
      await copyFileSafely(source, dest);
      copied++;
    }
  };
  await walk(from, to);
  return copied;
}

/**
 * Copies a verified snapshot to the copy directory, prunes the copies to the same count, and brings
 * the attachments up to date there. Never touches the snapshots on the data disk, whatever happens.
 */
export async function copyOffDisk(file: string, options: { copyDir: string; keep: number; uploadsDir: string; now?: Date }): Promise<BackupCopy> {
  const now = options.now ?? new Date();
  const name = path.basename(file);
  let uploadsCopied = 0;
  try {
    await fsp.mkdir(options.copyDir, { recursive: true });
    await copyFileSafely(file, path.join(options.copyDir, name));
    pruneSnapshots(options.keep, options.copyDir, now);
    uploadsCopied = await mirrorUploads(options.uploadsDir, path.join(options.copyDir, "uploads"));
    return { at: now.toISOString(), ok: true, error: null, snapshot: name, uploadsCopied };
  } catch (err) {
    return { at: now.toISOString(), ok: false, error: message(err), snapshot: name, uploadsCopied };
  }
}

// ---- taking snapshots ----

// The scheduler and the admin button share one queue: two snapshots started in the same second would
// otherwise pick the same name and fight over the partial file.
let queue: Promise<unknown> = Promise.resolve();

export interface SnapshotResult {
  snapshot: BackupSnapshot;
  pruned: string[];
  /** The copy off the disk, or null when no copy directory is set. A failed copy does not fail the snapshot. */
  copy: BackupCopy | null;
}

export function takeSnapshot(options: SnapshotOptions = {}): Promise<SnapshotResult> {
  const run = queue.then(
    () => writeSnapshot(options),
    () => writeSnapshot(options),
  );
  queue = run.catch(() => undefined);
  // Only the daily kind counts as the last attempt: the Backups tab is about whether the schedule
  // is keeping up, and a pre-migration snapshot is a different promise.
  if ((options.kind ?? "regular") !== "regular") return run;
  return run.then(
    async (result) => {
      state.lastAttempt = { at: new Date().toISOString(), ok: true, error: null };
      await saveState();
      return result;
    },
    async (err: unknown) => {
      state.lastAttempt = { at: new Date().toISOString(), ok: false, error: message(err) };
      await saveState();
      throw err;
    },
  );
}

async function writeSnapshot(options: SnapshotOptions): Promise<SnapshotResult> {
  const dir = options.dir ?? env.backupDir;
  const client = options.client ?? liveClient;
  const at = options.at ?? new Date();
  const keep = options.keep ?? env.backupKeep;
  const kind = options.kind ?? "regular";

  fs.mkdirSync(dir, { recursive: true });
  // Another snapshot from the same second takes the suffix after every one already there, so it is
  // also the newest in listing order and the prune below keeps it.
  const stamp = snapshotFilename(at, 0, kind).replace(/\.db$/, "");
  const sameSecond = listSnapshots(dir)
    .filter((s) => s.name.startsWith(stamp) && s.kind === kind)
    .map((s) => attemptOf(s.name));
  let attempt = sameSecond.length > 0 ? Math.max(...sameSecond) + 1 : 0;
  let file = path.join(dir, snapshotFilename(at, attempt, kind));
  while (fs.existsSync(file)) file = path.join(dir, snapshotFilename(at, ++attempt, kind));
  const partial = `${file}${PARTIAL_SUFFIX}`;
  fs.rmSync(partial, { force: true });

  try {
    // VACUUM INTO refuses to overwrite, so the partial name is both a lock and a crash marker.
    await withTimeout(
      (async () => {
        await client.execute({ sql: "VACUUM INTO ?", args: [partial] });
        await verifySnapshot(partial);
      })(),
      options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS,
    );
    removeSidecars(partial);
    fs.renameSync(partial, file);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    removeSidecars(partial);
    throw err;
  }

  const name = path.basename(file);
  const snapshot: BackupSnapshot = { name, bytes: fs.statSync(file).size, takenAt: parseName(name)?.takenAt ?? at.toISOString(), kind };
  const pruned = pruneSnapshots(keep, dir, at);

  const copyDir = options.copyDir === undefined ? env.backupCopyDir : options.copyDir;
  let copy: BackupCopy | null = null;
  if (copyDir) {
    copy = await withTimeout(copyOffDisk(file, { copyDir, keep, uploadsDir: options.uploadsDir ?? path.join(env.dataDir, "uploads"), now: at }), COPY_TIMEOUT_MS, "the copy").catch(
      (err: unknown): BackupCopy => ({ at: at.toISOString(), ok: false, error: message(err), snapshot: name, uploadsCopied: 0 }),
    );
    state.lastCopy = copy;
    await saveState();
    if (copy.ok) {
      console.log(`[backup] copied ${name} to ${copyDir}${copy.uploadsCopied ? ` with ${copy.uploadsCopied} new attachment(s)` : ""}`);
    } else {
      console.error(`[backup] could not copy ${name} to ${copyDir}: ${copy.error}`);
      raise({
        key: "backup.copy_failed",
        subject: "A backup could not be copied off the disk",
        body: `The snapshot ${name} was written and verified on the data disk, but copying it to ${copyDir} failed: ${copy.error}\n\nThe snapshots on the data disk are untouched. Check that the copy directory is mounted and writable by the app, uid 1000.`,
      });
    }
  }
  return { snapshot, pruned, copy };
}

/**
 * Takes a snapshot at boot when the database has migrations still to apply, so the state from before
 * a new image changed the schema can be restored with the image before it. A failure is logged and
 * alerted once the app is up, and the migrations run anyway: refusing to start would take the whole
 * site down over a backup the daily ones already cover up to a day.
 */
export async function snapshotBeforeMigrations(options: SnapshotOptions & { folder?: string } = {}): Promise<BackupSnapshot | null> {
  let pending: number;
  try {
    pending = await pendingMigrations(options.folder, options.client ?? liveClient);
  } catch (err) {
    console.error("[backup] could not tell whether migrations are pending", err);
    return null;
  }
  if (pending === 0) return null;
  try {
    const { snapshot } = await takeSnapshot({ ...options, kind: "pre_migrate" });
    console.log(`[backup] wrote ${snapshot.name} before applying ${pending} migration(s)`);
    return snapshot;
  } catch (err) {
    console.error("[backup] the snapshot before migrating failed; migrating anyway", err);
    raise({
      key: "backup.pre_migrate_failed",
      subject: "No snapshot was taken before a migration",
      body: `A new image applied ${pending} database migration(s) at boot, and the snapshot that should have been taken first failed: ${message(err)}\n\nThe daily snapshots are unaffected. If the new version misbehaves, the newest daily snapshot is the one to restore.`,
    });
    return null;
  }
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
  const latest = listSnapshots(dir).find((s) => s.kind === "regular");
  if (latest && Date.parse(latest.takenAt) >= due.getTime()) return null;
  const { snapshot, pruned } = await takeSnapshot({ ...options, at: now, dir, kind: "regular" });
  console.log(`[backup] wrote ${snapshot.name} (${snapshot.bytes} bytes)${pruned.length ? `, removed ${pruned.join(", ")}` : ""}`);
  return snapshot;
}

export function startBackupScheduler(): void {
  void restoreBackupState()
    .catch((err) => console.error("[backup] could not read the last result back", err))
    .finally(() => {
      if (env.backupHour < 0) {
        console.log("[backup] scheduled snapshots are off (KARDBOARD_BACKUP_HOUR is negative)");
        return;
      }
      const tick = () =>
        void runDueBackup().catch((err) => {
          console.error("[backup] snapshot failed", err);
          // The next tick tries again a minute later; the alert goes out once in six hours.
          raise({
            key: "backup.failed",
            subject: "The daily backup failed",
            body: `The scheduled snapshot of the database failed: ${message(err)}\n\nThe app tries again every minute. Earlier snapshots are untouched; the Backups tab lists them.`,
          });
        });
      tick();
      setInterval(tick, TICK_MS);
    });
}

function databaseBytes(): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) total += fs.statSync(`${dbFile}${suffix}`, { throwIfNoEntry: false })?.size ?? 0;
  return total;
}

export function backupsView(): BackupsView {
  return {
    dir: env.backupDir,
    hour: env.backupHour,
    keep: env.backupKeep,
    databaseBytes: databaseBytes(),
    snapshots: listSnapshots(),
    lastAttempt: state.lastAttempt,
    copyDir: env.backupCopyDir,
    lastCopy: state.lastCopy,
  };
}
