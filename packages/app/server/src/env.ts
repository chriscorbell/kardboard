import fs from "node:fs";
import path from "node:path";

// Load packages/app/.env when present (dev). In production the compose file supplies the environment.
for (const candidate of [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../.env")]) {
  if (fs.existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/**
 * How a request is signed in. `tailscale`: by the identity Tailscale Serve puts on it, which is how
 * the app runs in production. `dev`: every request is the seeded User, with no sign-in at all, so a
 * missing or mistyped setting must never produce it in production: a production process refuses to
 * start, and refuses `tailscale` without the one login it lets in.
 */
export function resolveAuthMode(input: { auth: string; production: boolean; tailscaleLogin: string }): "dev" | "tailscale" {
  const auth = input.auth.trim().toLowerCase();
  if (auth === "tailscale") {
    if (!input.tailscaleLogin.trim()) throw new Error("KARDBOARD_AUTH is tailscale, but KARDBOARD_TAILSCALE_LOGIN does not say which Tailscale login to let in.");
    return "tailscale";
  }
  if (auth !== "" && auth !== "dev") throw new Error(`KARDBOARD_AUTH must be "tailscale" or "dev", not ${JSON.stringify(input.auth)}.`);
  if (input.production) {
    throw new Error("Refusing to start: NODE_ENV is production and authentication would run in dev mode, which signs every request in as the User. Set KARDBOARD_AUTH=tailscale with KARDBOARD_TAILSCALE_LOGIN.");
  }
  return "dev";
}

// A count that has to be at least one, such as how many snapshots to keep, where zero would prune
// the snapshot just written. Below one is raised to one, and a value that is not a number falls back
// to the default, with a warning either way.
export function atLeastOne(name: string, raw: string, fallback: number): number {
  if (raw.trim() === "") return fallback;
  const n = Math.floor(Number(raw));
  const value = Number.isFinite(n) ? Math.max(1, n) : fallback;
  if (String(value) !== raw.trim()) console.warn(`[env] ${name}=${JSON.stringify(raw)} is not a whole number of at least 1; using ${value}`);
  return value;
}

const isProduction = process.env.NODE_ENV === "production";
const dataDir = path.resolve(str("KARDBOARD_DATA_DIR", "./data"));
const publicUrl = str("KARDBOARD_PUBLIC_URL", "http://localhost:5173").replace(/\/$/, "");

export const env = {
  port: Number(str("PORT", "3070")),
  dataDir,
  publicUrl,
  authMode: resolveAuthMode({ auth: str("KARDBOARD_AUTH"), production: isProduction, tailscaleLogin: str("KARDBOARD_TAILSCALE_LOGIN") }),
  // The Tailscale login the app lets in, such as `chriscorbell@github`.
  tailscaleLogin: str("KARDBOARD_TAILSCALE_LOGIN").trim(),
  // Snapshots live beside the database on the data bind mount. Set the hour to -1 to take none.
  backupDir: path.resolve(str("KARDBOARD_BACKUP_DIR", path.join(dataDir, "backups"))),
  backupHour: Number(str("KARDBOARD_BACKUP_HOUR", "4")),
  backupKeep: atLeastOne("KARDBOARD_BACKUP_KEEP", str("KARDBOARD_BACKUP_KEEP"), 14),
  // Optional second home for snapshots and attachments, off the data disk: on minicore a directory
  // on the NAS mount. Each verified snapshot is copied there and pruned to the same count, and new
  // files in `uploads/` are copied beside them, as long as it holds `.kardboard-backup-target`.
  // Empty keeps everything on the one disk.
  backupCopyDir: str("KARDBOARD_BACKUP_COPY_DIR") ? path.resolve(str("KARDBOARD_BACKUP_COPY_DIR")) : null,
  // The app's own console output, one file a day, so a log outlives the container that wrote it.
  logDir: path.join(dataDir, "logs"),
  logKeepDays: 14,
  isProduction,
};
