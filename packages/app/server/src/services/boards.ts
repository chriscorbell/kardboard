import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Board, Person, Reasoning, User } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";
import { toUser } from "./users.js";
import { publish } from "./realtime.js";

export function toBoard(row: typeof schema.boards.$inferSelect): Board {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    repoUrl: row.repoUrl,
    provider: row.provider,
    model: row.model,
    reasoning: row.reasoning,
    previewMode: row.previewMode,
    agentImage: row.agentImage,
    maxConcurrentSessions: row.maxConcurrentSessions,
    promptAppend: row.promptAppend,
    paused: row.paused,
    createdAt: row.createdAt,
  };
}

export async function listAllBoards(): Promise<Board[]> {
  const rows = await db.select().from(schema.boards).orderBy(schema.boards.name);
  return rows.map(toBoard);
}

export async function listBoardsForUser(user: User): Promise<Board[]> {
  if (user.role === "admin") return listAllBoards();
  const rows = await db
    .select({ board: schema.boards })
    .from(schema.boardMembers)
    .innerJoin(schema.boards, eq(schema.boardMembers.boardId, schema.boards.id))
    .where(eq(schema.boardMembers.userId, user.id))
    .orderBy(schema.boards.name);
  return rows.map((r) => toBoard(r.board));
}

export async function getBoardBySlug(slug: string): Promise<Board | null> {
  const row = await db.select().from(schema.boards).where(eq(schema.boards.slug, slug)).get();
  return row ? toBoard(row) : null;
}

export async function getBoardById(id: string): Promise<Board | null> {
  const row = await db.select().from(schema.boards).where(eq(schema.boards.id, id)).get();
  return row ? toBoard(row) : null;
}

export async function canAccessBoard(user: User, boardId: string): Promise<boolean> {
  if (user.role === "admin") return true;
  const row = await db
    .select({ boardId: schema.boardMembers.boardId })
    .from(schema.boardMembers)
    .where(and(eq(schema.boardMembers.boardId, boardId), eq(schema.boardMembers.userId, user.id)))
    .get();
  return Boolean(row);
}

export async function listMembers(boardId: string): Promise<User[]> {
  const rows = await db
    .select({ user: schema.users })
    .from(schema.boardMembers)
    .innerJoin(schema.users, eq(schema.boardMembers.userId, schema.users.id))
    .where(eq(schema.boardMembers.boardId, boardId));
  const members = rows.map((r) => toUser(r.user));
  const admins = await db.select().from(schema.users).where(eq(schema.users.role, "admin"));
  for (const a of admins) if (!members.some((m) => m.id === a.id)) members.push(toUser(a));
  return members.sort((a, b) => a.name.localeCompare(b.name));
}

// Who a Mention on this Board reaches, and so who the composer offers: the Admin and the Board's
// Members, less anyone revoked.
export async function listMentionable(boardId: string): Promise<User[]> {
  return (await listMembers(boardId)).filter((u) => u.status !== "revoked");
}

// Everyone a Board can show as the author of something: its Members and the Admin, and every User
// who created a Card, wrote or was mentioned in a Comment, gave an Approval, or acted in its
// activity, whether or not they can still open it. A removed Member keeps their name that way.
export async function listBoardPeople(boardId: string): Promise<Person[]> {
  const referenced = sql`(
    select user_id from board_members where board_id = ${boardId}
    union select creator_id from cards where board_id = ${boardId} and creator_kind = 'user'
    union select c.author_id from comments c join cards k on k.id = c.card_id where k.board_id = ${boardId} and c.author_kind = 'user'
    union select m.user_id from mentions m join comments c on c.id = m.comment_id join cards k on k.id = c.card_id where k.board_id = ${boardId}
    union select a.user_id from approvals a join cards k on k.id = a.card_id where k.board_id = ${boardId}
    union select actor_id from events where board_id = ${boardId} and actor_kind = 'user'
  )`;
  return db
    .select({ id: schema.users.id, handle: schema.users.handle, name: schema.users.name, avatarUrl: schema.users.avatarUrl })
    .from(schema.users)
    .where(or(eq(schema.users.role, "admin"), sql`${schema.users.id} in ${referenced}`))
    .orderBy(asc(schema.users.name));
}

export async function setMembers(boardId: string, userIds: string[]): Promise<void> {
  await db.delete(schema.boardMembers).where(eq(schema.boardMembers.boardId, boardId));
  if (userIds.length > 0) {
    const valid = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(inArray(schema.users.id, userIds));
    if (valid.length > 0) {
      await db.insert(schema.boardMembers).values(valid.map((v) => ({ boardId, userId: v.id })));
    }
  }
}

export type BoardInput = {
  name: string;
  slug: string;
  repoUrl?: string | null;
  provider: "claude" | "codex";
  model?: string | null;
  reasoning?: Reasoning | null;
  previewMode: "external" | "runner";
  agentImage?: string | null;
  maxConcurrentSessions: number;
  promptAppend: string;
  paused?: boolean;
};

export async function createBoard(input: BoardInput): Promise<Board> {
  const id = newId();
  await db.insert(schema.boards).values({
    id,
    slug: input.slug,
    name: input.name,
    repoUrl: input.repoUrl ?? null,
    provider: input.provider,
    model: input.model || null,
    reasoning: input.reasoning ?? null,
    previewMode: input.previewMode,
    agentImage: input.agentImage ?? null,
    maxConcurrentSessions: input.maxConcurrentSessions,
    promptAppend: input.promptAppend,
    paused: input.paused ?? false,
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
      provider: input.provider,
      model: input.model || null,
      reasoning: input.reasoning ?? null,
      previewMode: input.previewMode,
      agentImage: input.agentImage ?? null,
      maxConcurrentSessions: input.maxConcurrentSessions,
      promptAppend: input.promptAppend,
      // Left out, the switch stays where it was.
      ...(input.paused === undefined ? {} : { paused: input.paused }),
    })
    .where(eq(schema.boards.id, id));
  const board = (await getBoardById(id))!;
  publish(id, { type: "board.updated", board });
  return board;
}

/** The Admin's pause switch on its own, for the Board page. */
export async function setBoardPaused(id: string, paused: boolean): Promise<Board | null> {
  await db.update(schema.boards).set({ paused }).where(eq(schema.boards.id, id));
  const board = await getBoardById(id);
  if (board) publish(id, { type: "board.updated", board });
  return board;
}
