import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  COLUMN_LABELS,
  type Board,
  type Card,
  type Comment,
  type Notification,
  type NotificationKind,
  type NotificationsView,
  type User,
} from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { newId } from "../ids.js";
import type { Actor } from "./events.js";
import { getBoardById } from "./boards.js";
import { getUser } from "./users.js";
import { getAgentProfile } from "./settings.js";
import { queueEmail } from "./email.js";

// The panel shows a preview, not the whole comment; the email still carries the full body.
const PREVIEW_CHARS = 500;
const PAGE = 50;

async function actorProfile(actor: Actor): Promise<{ name: string; avatarUrl: string | null }> {
  if (actor.kind === "agent") return getAgentProfile();
  if (actor.kind === "user" && actor.id) {
    const user = await getUser(actor.id);
    if (user) return { name: user.name, avatarUrl: user.avatarUrl };
    return { name: "Someone", avatarUrl: null };
  }
  return { name: "kardboard", avatarUrl: null };
}

// One notification is one row plus one email, so the bell and the inbox never disagree.
async function notify(input: {
  userId: string;
  card: Card;
  board: Board;
  kind: NotificationKind;
  title: string;
  body: string;
  actor: { name: string; avatarUrl: string | null };
  emailSubject: string;
  emailHeading: string;
}): Promise<void> {
  await db.insert(schema.notifications).values({
    id: newId(),
    userId: input.userId,
    boardId: input.board.id,
    cardId: input.card.id,
    kind: input.kind,
    title: input.title,
    body: input.body.slice(0, PREVIEW_CHARS),
    actorName: input.actor.name,
    actorAvatarUrl: input.actor.avatarUrl,
  });
  await queueEmail({
    toUserId: input.userId,
    subject: input.emailSubject,
    heading: input.emailHeading,
    body: input.body,
    linkUrl: `${env.publicUrl}/b/${input.board.slug}/c/${input.card.id}`,
    linkLabel: "Open the card",
  });
}

// The Card's creator hears about column moves they did not make themselves.
export async function notifyCardMoved(card: Card, from: Card["column"], actor: Actor): Promise<void> {
  if (card.creatorKind !== "user" || !card.creatorId) return;
  if (actor.kind === "user" && actor.id === card.creatorId) return;
  const creator = await getUser(card.creatorId);
  if (!creator || creator.status === "revoked") return;
  const board = await getBoardById(card.boardId);
  if (!board) return;
  const who = await actorProfile(actor);
  const title = `${who.name} moved your card to ${COLUMN_LABELS[card.column]}`;
  await notify({
    userId: creator.id,
    card,
    board,
    kind: "card_moved",
    title,
    body: `${COLUMN_LABELS[from]} → ${COLUMN_LABELS[card.column]}`,
    actor: who,
    emailSubject: `"${card.title}" moved to ${COLUMN_LABELS[card.column]}`,
    emailHeading: title,
  });
}

// Everyone newly named by an @handle in a comment hears about it once.
export async function notifyMentions(card: Card, comment: Comment, userIds: string[], actor: Actor): Promise<void> {
  if (userIds.length === 0) return;
  const board = await getBoardById(card.boardId);
  if (!board) return;
  const who = await actorProfile(actor);
  for (const userId of userIds) {
    await notify({
      userId,
      card,
      board,
      kind: "mention",
      title: `${who.name} mentioned you`,
      body: comment.body,
      actor: who,
      emailSubject: `${who.name} mentioned you on "${card.title}"`,
      emailHeading: `${who.name} mentioned you on ${card.title}`,
    });
  }
  await db
    .update(schema.mentions)
    .set({ notifiedAt: new Date().toISOString() })
    .where(and(eq(schema.mentions.commentId, comment.id), inArray(schema.mentions.userId, userIds)));
}

// A user who has lost access to a board must stop seeing its cards, including in the bell.
async function visibleBoardIds(user: User): Promise<string[] | null> {
  if (user.role === "admin") return null;
  const rows = await db
    .select({ boardId: schema.boardMembers.boardId })
    .from(schema.boardMembers)
    .where(eq(schema.boardMembers.userId, user.id));
  return rows.map((r) => r.boardId);
}

function scope(user: User, boardIds: string[] | null) {
  const mine = eq(schema.notifications.userId, user.id);
  return boardIds === null ? mine : and(mine, inArray(schema.notifications.boardId, boardIds));
}

export async function listNotifications(user: User, limit = PAGE): Promise<NotificationsView> {
  const boardIds = await visibleBoardIds(user);
  if (boardIds !== null && boardIds.length === 0) return { unread: 0, notifications: [] };
  const where = scope(user, boardIds);
  const rows = await db
    .select({ n: schema.notifications, boardSlug: schema.boards.slug, cardTitle: schema.cards.title })
    .from(schema.notifications)
    .innerJoin(schema.boards, eq(schema.notifications.boardId, schema.boards.id))
    .innerJoin(schema.cards, eq(schema.notifications.cardId, schema.cards.id))
    .where(where)
    .orderBy(desc(schema.notifications.createdAt))
    .limit(limit);
  const unread =
    (await db
      .select({ value: count() })
      .from(schema.notifications)
      .where(and(where, isNull(schema.notifications.readAt)))
      .get())?.value ?? 0;
  const notifications: Notification[] = rows.map((r) => ({
    id: r.n.id,
    kind: r.n.kind,
    title: r.n.title,
    body: r.n.body,
    actorName: r.n.actorName,
    actorAvatarUrl: r.n.actorAvatarUrl,
    boardSlug: r.boardSlug,
    cardId: r.n.cardId,
    cardTitle: r.cardTitle,
    readAt: r.n.readAt,
    createdAt: r.n.createdAt,
  }));
  return { unread, notifications };
}

// No ids marks everything read. Only the owner's own rows are ever touched.
export async function markNotificationsRead(user: User, ids?: string[]): Promise<NotificationsView> {
  const boardIds = await visibleBoardIds(user);
  const nothingToScan = (boardIds !== null && boardIds.length === 0) || (ids !== undefined && ids.length === 0);
  if (!nothingToScan) {
    const target = ids ? and(scope(user, boardIds), inArray(schema.notifications.id, ids)) : scope(user, boardIds);
    await db
      .update(schema.notifications)
      .set({ readAt: new Date().toISOString() })
      .where(and(target, isNull(schema.notifications.readAt)));
  }
  return listNotifications(user);
}
