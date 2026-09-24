# Backups and restore

kardboard keeps its state in one SQLite database in WAL mode, see [ADR 0004](../adr/0004-sqlite-in-a-single-server-process.md). On minicore the data bind mount is `~/docker/data/kardboard/app`, mounted at `/data` in the `app` container:

| Path under `/data` | What it is |
| --- | --- |
| `kardboard.db`, `kardboard.db-wal`, `kardboard.db-shm` | The live database. Never copy these while the app runs |
| `backups/kardboard-<UTC stamp>.db` | Snapshots. Each one is a complete, self-contained database |
| `uploads/<xx>/<sha256>` | Comment attachments, content-addressed and immutable |

Copying `kardboard.db` alone is not a backup. Recent commits live in the write-ahead log until a checkpoint, so a bare copy is typically a nearly empty database: on a freshly seeded instance the main file was 4 KB against a 313 KB WAL, and the copy could not read a single table.

## What the app does on its own

The app writes a snapshot with SQLite's `VACUUM INTO`, which produces a consistent copy of the committed database without pausing writers. It then opens that file as its own database, runs `PRAGMA integrity_check`, and only publishes it under its final name if the check passes; a failed copy is deleted rather than kept. Snapshots are named from the UTC time they were taken, so they sort chronologically.

One snapshot is taken per day, at `KARDBOARD_BACKUP_HOUR` in the server's timezone. The schedule holds no state in memory: on every tick the app compares the newest snapshot on disk with the last time the scheduled hour passed, so a restart, a deploy, or hours of downtime still produce the missed snapshot as soon as the app is back. After a successful snapshot the oldest files beyond `KARDBOARD_BACKUP_KEEP` are removed, along with any `.partial` file left behind by an interrupted run.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KARDBOARD_BACKUP_HOUR` | `4` | Local hour of the daily snapshot. Negative turns scheduled snapshots off |
| `KARDBOARD_BACKUP_KEEP` | `14` | How many snapshots to keep |
| `KARDBOARD_BACKUP_DIR` | `<data dir>/backups` | Where snapshots are written |

**Admin → Backups** lists the snapshots with their size and age, and takes one on demand with *Snapshot now*. Take one before any risky change. The same is available as `GET` and `POST /api/admin/backups`.

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

Then check the board in a browser, and only afterwards remove the `.broken` files. Work that happened after the snapshot is gone: cards, comments, and sessions recorded since then are not recoverable from it, and any GitHub branch or pull request a session opened in the meantime still exists on GitHub while kardboard no longer knows about it. Re-run affected cards rather than editing the database.

## What this does not cover

- **Attachments are separate.** A snapshot holds attachment metadata; the bytes live in `uploads/`. That directory is content-addressed and immutable, so a plain `cp -a` is safe at any time. A complete backup is the newest snapshot plus `uploads/`.
- **Snapshots share the disk with the database.** They survive a corrupted database or a bad deploy, not a lost disk. Copying them off the host is a manual step and remains out of scope for v1, see [the design](../design.md#out-of-scope-for-v1). An `scp` or `rsync` of `~/docker/data/kardboard/app/backups` and `uploads` from another machine is enough:

  ```bash
  rsync -a minicore:docker/data/kardboard/app/{backups,uploads} ~/backups/kardboard/
  ```

- **Nothing verifies a restore automatically.** The check above is the only evidence that a snapshot is usable; run it after any change to the storage layout.
