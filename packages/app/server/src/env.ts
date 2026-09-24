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
  authMode: (str("KARDBOARD_AUTH", "dev") === "clerk" ? "clerk" : "dev") as "dev" | "clerk",
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
  // Snapshots live beside the database on the data bind mount. Set the hour to -1 to take none.
  backupDir: path.resolve(str("KARDBOARD_BACKUP_DIR", path.join(dataDir, "backups"))),
  backupHour: Number(str("KARDBOARD_BACKUP_HOUR", "4")),
  backupKeep: Number(str("KARDBOARD_BACKUP_KEEP", "14")),
  isProduction: process.env.NODE_ENV === "production",
};
