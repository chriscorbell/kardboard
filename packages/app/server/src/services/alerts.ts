import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { queueEmail } from "./email.js";

// Things that go wrong where no one is looking: a nightly backup, a credential the provider stopped
// accepting, a runner that stopped answering. Each is emailed to every active Admin. The same key
// sends at most once in six hours, so a condition checked every minute cannot fill an inbox, and the
// time it was last sent is a row, so a restart in between does not send it again.
export const ALERT_DEDUPE_MS = 6 * 3_600_000;

const keyFor = (key: string) => `alert:${key}`;

export interface AdminAlert {
  /** What makes two alerts the same one. Stable across restarts: `backup.failed`, `runner.unreachable`. */
  key: string;
  subject: string;
  body: string;
  /** Where the email's button goes, as a path on this site. The admin panel when left out. */
  path?: string;
}

/**
 * Takes the right to send `key` now: true unless it was sent within the dedupe window. One statement,
 * so two callers racing on the same key cannot both win.
 */
async function claim(key: string, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const cutoff = new Date(now.getTime() - ALERT_DEDUPE_MS).toISOString();
  const row = await db
    .insert(schema.settings)
    .values({ key: keyFor(key), value: at })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: at }, setWhere: sql`${schema.settings.value} <= ${cutoff}` })
    .returning({ key: schema.settings.key })
    .get();
  return row !== undefined;
}

/** Emails every active Admin, unless the same key was sent in the last six hours. True if it sent. */
export async function alertAdmin(alert: AdminAlert, now = new Date()): Promise<boolean> {
  // Logged whether or not it is sent, so the kept app log has every occurrence.
  console.warn(`[alert] ${alert.key}: ${alert.subject}`);
  if (!(await claim(alert.key, now))) return false;
  try {
    const admins = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.role, "admin"), eq(schema.users.status, "active")));
    for (const admin of admins) {
      await queueEmail({
        toUserId: admin.id,
        subject: `kardboard: ${alert.subject}`,
        heading: alert.subject,
        body: alert.body,
        linkUrl: `${env.publicUrl}${alert.path ?? "/admin"}`,
        linkLabel: "Open the admin panel",
        footer: "You are receiving this because you are the kardboard Admin. The same alert is sent at most once every six hours while the problem lasts.",
      });
    }
  } catch (err) {
    // Nothing was queued, or not for everyone: give the slot back so the next occurrence tries
    // again, rather than staying quiet for six hours about an alert nobody received.
    await release(alert.key, now).catch(() => undefined);
    throw err;
  }
  return true;
}

async function release(key: string, now: Date): Promise<void> {
  await db.delete(schema.settings).where(and(eq(schema.settings.key, keyFor(key)), eq(schema.settings.value, now.toISOString())));
}
