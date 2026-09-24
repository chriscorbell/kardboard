import { createClient } from "@libsql/client";
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

export async function runMigrations(): Promise<void> {
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
  const here = path.dirname(fileURLToPath(import.meta.url));
  // In dev this file lives at server/src/db, in prod at dist/server/db. The drizzle dir sits at the package root.
  const candidates = [path.resolve(here, "../../../drizzle"), path.resolve(here, "../../drizzle")];
  const migrationsFolder = candidates.find((c) => fs.existsSync(c));
  if (!migrationsFolder) throw new Error("drizzle migrations folder not found");
  await migrate(db, { migrationsFolder });
}

export { schema };
