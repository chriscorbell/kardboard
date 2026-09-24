import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../env.js";
import * as schema from "./schema.js";

fs.mkdirSync(env.dataDir, { recursive: true });

export const dbFile = path.join(env.dataDir, "kardboard.db");

export const client = createClient({ url: `file:${dbFile}` });
export const db = drizzle(client, { schema });
export type Db = typeof db;

export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // In dev this file lives at server/src/db, in prod at dist/server/db. The drizzle dir sits at the package root.
  const candidates = [path.resolve(here, "../../../drizzle"), path.resolve(here, "../../drizzle")];
  const folder = candidates.find((c) => fs.existsSync(c));
  if (!folder) throw new Error("drizzle migrations folder not found");
  return folder;
}

export async function runMigrations(): Promise<void> {
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  await migrate(db, { migrationsFolder: migrationsFolder() });
}

/**
 * How many migrations in the journal the database has not had yet, by the same rule drizzle's
 * migrator applies: every entry newer than the newest one recorded. A database with no record of any
 * is new, and there is nothing in it to protect, so it counts as none.
 */
export async function pendingMigrations(folder: string = migrationsFolder(), c: Client = client): Promise<number> {
  const table = await c.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'");
  if (table.rows.length === 0) return 0;
  const last = await c.execute("SELECT max(created_at) AS at FROM __drizzle_migrations");
  const appliedAt = Number(last.rows[0]?.at ?? 0);
  const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as { entries: { when: number }[] };
  return journal.entries.filter((entry) => entry.when > appliedAt).length;
}

export { schema };
