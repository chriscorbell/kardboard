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
 * Dev authentication signs every request in as the Admin and lets any caller pick a User with a
 * header, so a missing or mistyped setting must never produce it in production: a production process
 * refuses to start.
 */
export function resolveAuthMode(input: { auth: string; production: boolean }): "dev" | "clerk" {
  const auth = input.auth.trim().toLowerCase();
  if (auth === "clerk") return "clerk";
  if (auth !== "" && auth !== "dev") throw new Error(`KARDBOARD_AUTH must be "clerk" or "dev", not ${JSON.stringify(input.auth)}.`);
  if (input.production) {
    throw new Error("Refusing to start: NODE_ENV is production and authentication would run in dev mode, which signs every request in as the Admin. Set KARDBOARD_AUTH=clerk with the Clerk keys.");
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
  redirectHosts: str("KARDBOARD_REDIRECT_HOSTS").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
  authMode: resolveAuthMode({ auth: str("KARDBOARD_AUTH"), production: isProduction }),
  clerkSecretKey: str("CLERK_SECRET_KEY"),
  // The Clerk instance's PEM public key, which lets session tokens be verified without asking Clerk.
  // Optional. A PEM written on one line with `\n` escapes, as an env file often holds it, works too.
  clerkJwtKey: str("CLERK_JWT_KEY").replace(/\\n/g, "\n"),
  clerkPublishableKey: str("CLERK_PUBLISHABLE_KEY") || str("VITE_CLERK_PUBLISHABLE_KEY"),
  resendApiKey: str("RESEND_API_KEY"),
  emailFrom: str("KARDBOARD_EMAIL_FROM", "Milo <milo@example.com>"),
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
