# Backups and restore

kardboard keeps its state in one SQLite database in WAL mode, see [ADR 0004](../adr/0004-sqlite-in-a-single-server-process.md). On minicore the data bind mount is `~/docker/data/kardboard/app`, mounted at `/data` in the `app` container:

| Path under `/data` | What it is |
| --- | --- |
| `kardboard.db`, `kardboard.db-wal`, `kardboard.db-shm` | The live database. Never copy these while the app runs |
| `backups/kardboard-<UTC stamp>.db` | Daily and on-demand snapshots. Each one is a complete, self-contained database |
| `backups/kardboard-pre-migrate-<UTC stamp>.db` | Snapshots taken at boot just before a new image migrated the schema |
| `uploads/<xx>/<sha256>` | Comment attachments, content-addressed and immutable |
| `logs/app-<UTC date>.log` | The app's own console output, one file a day, kept 14 days |

On minicore the app also mounts `/nas/backup/minicore/kardboard` at `/backup-copy`, where every snapshot and every attachment is copied; see [the copy off the disk](#the-copy-off-the-disk).

Copying `kardboard.db` alone is not a backup. Recent commits live in the write-ahead log until a checkpoint, so a bare copy is typically a nearly empty database: on a freshly seeded instance the main file was 4 KB against a 313 KB WAL, and the copy could not read a single table.

## What the app does on its own

The app writes a snapshot with SQLite's `VACUUM INTO`, which produces a consistent copy of the committed database without pausing writers. It then opens that file as its own database, runs `PRAGMA integrity_check`, and only publishes it under its final name if the check passes; a failed copy is deleted rather than kept. Snapshots are named from the UTC time they were taken, so they sort chronologically.

One snapshot is taken per day, at `KARDBOARD_BACKUP_HOUR` in the server's timezone. The schedule holds no state in memory: on every tick the app compares the newest daily snapshot on disk with the last time the scheduled hour passed, so a restart, a deploy, or hours of downtime still produce the missed snapshot as soon as the app is back. After a successful snapshot the oldest files beyond `KARDBOARD_BACKUP_KEEP` are removed, along with any `.partial` file left behind by an interrupted run. The snapshot just written is always kept. A run that has not finished after 15 minutes is abandoned and its partial file removed, so one stuck run cannot hold up every later snapshot; the scheduler tries again on its next tick.

**Before migrations.** At boot, before it migrates the database, the app compares the migrations its image carries with the ones the database has had. When some are still to apply, it first writes `kardboard-pre-migrate-<stamp>.db`: the database exactly as the previous image left it. These are copied off the disk like the others and pruned apart from the daily snapshots, to the same keep count, so a run of deploys cannot push the daily ones out; the daily schedule ignores them when deciding whether today's snapshot is due. A failed pre-migration snapshot does not stop the boot: the migrations run anyway, and the Admin is emailed once the app is up.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KARDBOARD_BACKUP_HOUR` | `4` | Local hour of the daily snapshot. Negative turns scheduled snapshots off |
| `KARDBOARD_BACKUP_KEEP` | `14` | How many snapshots of each kind to keep, here and in the copy directory. Zero or less is read as 1, and a value that is not a number as 14, with a warning in the log |
| `KARDBOARD_BACKUP_DIR` | `<data dir>/backups` | Where snapshots are written |
| `KARDBOARD_BACKUP_COPY_DIR` | unset | A second directory, off the data disk, that each snapshot and `uploads/` are copied to. Unset copies nothing |

**Admin → Backups** lists the snapshots with their size and age, marks the pre-migration ones, and takes one on demand with *Snapshot now*. Take one before any risky change. The same is available as `GET` and `POST /api/admin/backups`. Its `lastAttempt` says when the most recent daily or on-demand snapshot finished and, if it failed, why; `lastCopy` does the same for the copy off the disk. Both are kept in the database, so they survive a restart.

**Alerts.** A failed scheduled snapshot, a failed copy, and a failed pre-migration snapshot each email every active Admin. The scheduler retries a failed snapshot every minute, but the same alert is sent at most once in six hours. Each failure is also in the app's log as `[backup] …`, and `[alert] backup.failed` marks every occurrence, sent or not.

## The copy off the disk

Snapshots on the data disk survive a corrupted database or a bad deploy, not a lost disk. With `KARDBOARD_BACKUP_COPY_DIR` set, the app copies each verified snapshot there once it is written, through a `.partial` file that is renamed only once its size matches, then prunes the copies to the same keep count. It then copies every attachment in `uploads/` that the copy directory does not have yet. Attachments are named by the hash of their bytes and never change, so a file already there with the same size is the same file; nothing is ever deleted from the copy's `uploads/`.

Copies run one at a time in the background, after the snapshot they copy: *Snapshot now* answers as soon as the snapshot is on the data disk, and the Backups tab shows the copy's result when it lands. A pre-migration snapshot is copied only once the app is serving, so a slow or missing share never holds up a boot.

**The marker file.** The app copies only into a directory that holds a file named `.kardboard-backup-target`. A share that did not mount leaves an empty directory, or no directory, where it should be; without the marker the copy refuses rather than writing to the very disk it is meant to outlive and reporting success. The file's contents do not matter.

A copy that fails, refuses, or does not finish within 15 minutes is reported on the Backups tab and by email. It never removes or changes a snapshot on the data disk, and the next snapshot tries again.

On minicore the directory is `/nas/backup/minicore/kardboard`, on `nas`'s `backup` share, which `/etc/fstab` automounts beside Crafty's backups in `/nas/backup/minicore/crafty`. `nas` snapshots its pools daily and the `backup` machine replicates those snapshots nightly, so a copy there also outlives `nas` itself (see `~/Code/fleet/AGENTS.md`). The container runs as uid 1000, which must be able to write there.

The Compose file binds the share in the short form, so an unmounted share never stops Watchtower recreating the `app` container: Docker binds an empty local folder in its place, the marker is missing from it, and the app copies nothing and alerts the Admin instead.

To set it up, or to check it after a change to the mount:

```bash
ls -ld /nas/backup/minicore                    # the share answers
mkdir -p /nas/backup/minicore/kardboard
touch /nas/backup/minicore/kardboard/.kardboard-backup-target
sudo -u '#1000' touch /nas/backup/minicore/kardboard/.write-test && rm /nas/backup/minicore/kardboard/.write-test
cd ~/docker/stacks/kardboard && docker compose up -d app
```

Create the marker only on the share itself, never in a directory on the local disk. Then press *Snapshot now*: the Backups tab should report the copy with the number of attachments it brought over.

## Check a snapshot

Every snapshot was verified when it was written. To re-check one, or to check a file copied from elsewhere:

```bash
cd ~/docker/stacks/kardboard
docker compose exec app node --input-type=module -e "import {createClient} from '@libsql/client'; const c = createClient({ url: 'file:/data/backups/kardboard-20260914T040000Z.db' }); console.log((await c.execute('PRAGMA integrity_check')).rows[0], (await c.execute('SELECT count(*) AS cards FROM cards')).rows[0]); c.close();"
```

Expect `{ integrity_check: 'ok' }` and a plausible card count.

## Restore

Restoring replaces the live database, so it is done with the app stopped. Nothing in the app can do this for you.

```bash
cd ~/docker/stacks/kardboard
docker compose stop app                     # the runner and sessions keep running; stop them too if a session is mid-flight

cd ~/docker/data/kardboard/app
mv kardboard.db kardboard.db.broken          # keep the damaged files until the restore is confirmed
mv kardboard.db-wal kardboard.db-wal.broken 2>/dev/null
mv kardboard.db-shm kardboard.db-shm.broken 2>/dev/null

cp backups/kardboard-20260914T040000Z.db kardboard.db
chown --reference=kardboard.db.broken kardboard.db   # the container runs as uid 1000; prefix sudo if you are not the owner

cd ~/docker/stacks/kardboard
docker compose start app
docker compose logs -f app                   # migrations run on boot; watch for errors
```

A snapshot carries no `-wal` or `-shm` file, and must not be given one: SQLite recreates both on first use. The app runs its migrations at startup, so restoring a snapshot taken by an older image is safe as long as the image is at least as new as the snapshot.

**When the data disk is gone**, restore from the copy instead: take the newest `kardboard-*.db` from `/nas/backup/minicore/kardboard` as above, and copy its `uploads/` back into `~/docker/data/kardboard/app/uploads` with `cp -a` before starting the app.

**When a deploy's migration went wrong**, the `kardboard-pre-migrate-<stamp>.db` from that boot is the database as the previous image left it. Restore it as above, and before starting the app pin the previous image, `ghcr.io/chriscorbell/kardboard-app:sha-<short sha>`, in the stack's Compose file: the newer image would apply the same migrations to it again at boot. Unpin once the fix is on `main`.

Then check the board in a browser, and only afterwards remove the `.broken` files. Work that happened after the snapshot is gone: cards, comments, and sessions recorded since then are not recoverable from it, and any GitHub branch or pull request a session opened in the meantime still exists on GitHub while kardboard no longer knows about it. Re-run affected cards rather than editing the database.

## Restore drill

Every snapshot is verified when it is written, but only restoring one shows the procedure still works. On any machine with Node, without touching production:

```bash
mkdir -p /tmp/kardboard-drill && scp minicore:/nas/backup/minicore/kardboard/kardboard-<newest stamp>.db /tmp/kardboard-drill/kardboard.db
cd ~/Code/kardboard/packages/app
# Everything that could reach the outside is blanked, whatever packages/app/.env says.
KARDBOARD_DATA_DIR=/tmp/kardboard-drill KARDBOARD_AUTH=dev KARDBOARD_BACKUP_HOUR=-1 PORT=3999 \
  RESEND_API_KEY= KARDBOARD_RUNNER_URL= KARDBOARD_EGRESS_URL= KARDBOARD_BACKUP_COPY_DIR= pnpm dev:server
```

The server migrates the copy and serves it on port 3999 in dev authentication, signed in as the Admin: `curl http://127.0.0.1:3999/healthz` answers `{"ok":true,"db":"ok",…}` and `curl http://127.0.0.1:3999/api/boards` lists the Boards. With no runner, nothing starts. Stop it and delete `/tmp/kardboard-drill` afterwards.

## What this does not cover

- **Attachments are separate from snapshots.** A snapshot holds attachment metadata; the bytes live in `uploads/`. With the copy directory set, they are copied alongside the snapshots; without it, a plain `cp -a` of `uploads/` is safe at any time. A complete backup is the newest snapshot plus `uploads/`.
- **Without `KARDBOARD_BACKUP_COPY_DIR`, snapshots share the disk with the database.** They then survive a corrupted database or a bad deploy, not a lost disk. An `rsync` from another machine covers that by hand:

  ```bash
  rsync -a minicore:docker/data/kardboard/app/{backups,uploads} ~/backups/kardboard/
  ```

- **Nothing verifies a restore automatically.** The integrity check and the drill above are the only evidence that a snapshot is usable; run them after any change to the storage layout.
