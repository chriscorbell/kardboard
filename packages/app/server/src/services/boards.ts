import { asc, eq, sql } from "drizzle-orm";
import type { Board, Person } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";
import { publish } from "./realtime.js";
import { repositoryKey } from "./repository.js";

export function toBoard(row: typeof schema.boards.$inferSelect): Board {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    repoUrl: row.repoUrl,
    createdAt: row.createdAt,
  };
}

export async function listAllBoards(): Promise<Board[]> {
  // By name as a person reads it: "kardboard" between "Homelab" and "Recipes", not after every capital.
  const rows = await db.select().from(schema.boards).orderBy(sql`${schema.boards.name} collate nocase`);
  return rows.map(toBoard);
}

export async function getBoardBySlug(slug: string): Promise<Board | null> {
  const row = await db.select().from(schema.boards).where(eq(schema.boards.slug, slug)).get();
  return row ? toBoard(row) : null;
}

/**
 * The Board an agent names: by slug, or by its repository's address in any form git writes one, such
 * as the output of `git remote get-url origin`. Null when none matches.
 */
export async function findBoard(ref: string): Promise<Board | null> {
  const bySlug = await getBoardBySlug(ref.trim().toLowerCase());
  if (bySlug) return bySlug;
  const key = repositoryKey(ref);
  if (!key) return null;
  return (await listAllBoards()).find((b) => repositoryKey(b.repoUrl) === key) ?? null;
}

export async function getBoardById(id: string): Promise<Board | null> {
  const row = await db.select().from(schema.boards).where(eq(schema.boards.id, id)).get();
  return row ? toBoard(row) : null;
}

// Everyone a Board can show as the author of something. That is the User; the Board has no one else
// since Members went, and a person who wrote on it before then has no row left to name them.
export async function listBoardPeople(): Promise<Person[]> {
  return db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).orderBy(asc(schema.users.name));
}

export type BoardInput = {
  name: string;
  slug: string;
  repoUrl?: string | null;
};

export async function createBoard(input: BoardInput): Promise<Board> {
  const id = newId();
  await db.insert(schema.boards).values({
    id,
    slug: input.slug,
    name: input.name,
    repoUrl: input.repoUrl ?? null,
  });
  return (await getBoardById(id))!;
}

export async function updateBoard(id: string, input: BoardInput): Promise<Board> {
  await db
    .update(schema.boards)
    .set({
      slug: input.slug,
      name: input.name,
      repoUrl: input.repoUrl ?? null,
    })
    .where(eq(schema.boards.id, id));
  const board = (await getBoardById(id))!;
  publish(id, { type: "board.updated", board });
  return board;
}
