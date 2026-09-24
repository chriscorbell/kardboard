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

// Private keys arrive base64-encoded so a PEM survives an env file.
function githubApp(prefix: string) {
  const b64 = str(`${prefix}_PRIVATE_KEY_B64`);
  return {
    id: str(`${prefix}_ID`),
    slug: str(`${prefix}_SLUG`, prefix === "GITHUB_SESSIONS_APP" ? "kardboard-sessions" : "kardboard-merge"),
    privateKey: b64 ? Buffer.from(b64, "base64").toString("utf8") : "",
  };
}

/**
 * Dev authentication signs every request in as the Admin and lets any caller pick a User with a
 * header, so a missing or mistyped setting must never produce it in production. There it runs only
 * in a Preview container, which the runner marks with KARDBOARD_PREVIEW_HOST: a Preview runs this
 * image with its own seeded database, behind the preview router's membership check. Anywhere else a
 * production process refuses to start.
 */
export function resolveAuthMode(input: { auth: string; production: boolean; preview: boolean }): "dev" | "clerk" {
  const auth = input.auth.trim().toLowerCase();
  if (auth === "clerk") return "clerk";
  if (auth !== "" && auth !== "dev") throw new Error(`KARDBOARD_AUTH must be "clerk" or "dev", not ${JSON.stringify(input.auth)}.`);
  if (input.production && !input.preview) {
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

// Preview hostnames hang off the app's own parent domain: `kardboard.cc` gives `kardboard.cc`.
function defaultPreviewDomain(): string {
  try {
    const labels = new URL(publicUrl).hostname.split(".");
    return labels.length > 2 ? labels.slice(1).join(".") : labels.join(".");
  } catch {
    return "";
  }
}

export const env = {
  port: Number(str("PORT", "3070")),
  dataDir,
  publicUrl,
  redirectHosts: str("KARDBOARD_REDIRECT_HOSTS").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
  authMode: resolveAuthMode({ auth: str("KARDBOARD_AUTH"), production: isProduction, preview: str("KARDBOARD_PREVIEW_HOST") !== "" }),
  clerkSecretKey: str("CLERK_SECRET_KEY"),
  clerkPublishableKey: str("CLERK_PUBLISHABLE_KEY") || str("VITE_CLERK_PUBLISHABLE_KEY"),
  resendApiKey: str("RESEND_API_KEY"),
  emailFrom: str("KARDBOARD_EMAIL_FROM", "Milo <milo@example.com>"),
  runnerUrl: str("KARDBOARD_RUNNER_URL"),
  runnerToken: str("KARDBOARD_RUNNER_TOKEN"),
  // Only for reading which Providers are out of usage. Session traffic never passes through the app.
  egressUrl: str("KARDBOARD_EGRESS_URL").replace(/\/$/, ""),
  // Signs Preview cookies. The preview router verifies with the same secret; nothing else holds it.
  previewSecret: str("KARDBOARD_PREVIEW_SECRET"),
  previewDomain: str("KARDBOARD_PREVIEW_DOMAIN", defaultPreviewDomain()),
  // `{card}` is the Card's short id, `{domain}` the parent domain. A first-level hostname
  // fits a standard wildcard certificate, alongside the app's explicit hostname.
  previewHostPattern: str("KARDBOARD_PREVIEW_HOST_PATTERN", "{card}.{domain}"),
  previewScheme: str("KARDBOARD_PREVIEW_SCHEME", "https"),
  previewCookieMinutes: Number(str("KARDBOARD_PREVIEW_COOKIE_MINUTES", "240")),
  previewIdleDays: Number(str("KARDBOARD_PREVIEW_IDLE_DAYS", "7")),
  githubSessionsApp: githubApp("GITHUB_SESSIONS_APP"),
  githubMergeApp: githubApp("GITHUB_MERGE_APP"),
  triggerCoalesceMs: Number(str("KARDBOARD_TRIGGER_COALESCE_MS", "60000")),
  // Each Trigger restarts the batching window, but it closes no later than this long after the
  // oldest Trigger still waiting, so steady commenting cannot hold a Session off indefinitely.
  triggerCoalesceMaxMs: Number(str("KARDBOARD_TRIGGER_COALESCE_MAX_MS", "180000")),
  // Snapshots live beside the database on the data bind mount. Set the hour to -1 to take none.
  backupDir: path.resolve(str("KARDBOARD_BACKUP_DIR", path.join(dataDir, "backups"))),
  backupHour: Number(str("KARDBOARD_BACKUP_HOUR", "4")),
  backupKeep: atLeastOne("KARDBOARD_BACKUP_KEEP", str("KARDBOARD_BACKUP_KEEP"), 14),
  isProduction,
};
