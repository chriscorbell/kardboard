import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  COLUMN_LABELS,
  type Board,
  type Card,
  type Column,
  type Comment,
  type EmailPreference,
  type Notification,
  type NotificationKind,
  type NotificationsView,
  type User,
} from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { newId } from "../ids.js";
import type { Actor } from "./events.js";
import { canAccessBoard, getBoardById } from "./boards.js";
import { getPreferences, getUser } from "./users.js";
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

// Only someone who could open the Card hears about it: an active User who is the Admin or a Member
// of its Board. A handle is global, so without this an @mention reaches anyone who has one.
export async function canBeNotified(user: User, boardId: string): Promise<boolean> {
  return user.status !== "revoked" && (await canAccessBoard(user, boardId));
}

// The moves that ask something of the Card's creator, or close the loop on it. The rest (a Card
// going to Ready, or a Session picking it up) are the Agent's bookkeeping, and three to five emails
// a Card taught people to ignore all of them.
const MOVES_WORTH_NOTICE: ReadonlySet<Column> = new Set(["blocked", "review", "done"]);

// Whether a notification also goes out by email. The bell records it either way. "important" keeps
// what asks something of the reader: a Mention, a failed Session, and a Card moving to Blocked (a
// question) or Review (a change to look at). A kind added later is routine until it is listed here.
export function emailWanted(preference: EmailPreference, n: { kind: string; column: Column }): boolean {
  if (preference === "off") return false;
  if (preference === "all") return true;
  if (n.kind === "mention" || n.kind === "session_failed") return true;
  return n.kind === "card_moved" && (n.column === "blocked" || n.column === "review");
}

// One notification is one row, plus an email when the User wants that kind by email.
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
  const user = await getUser(input.userId);
  if (!user || !(await canBeNotified(user, input.board.id))) return;
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
  const { emailPreference } = await getPreferences(input.userId);
  if (!emailWanted(emailPreference, { kind: input.kind, column: input.card.column })) return;
  await queueEmail({
    toUserId: input.userId,
    subject: input.emailSubject,
    heading: input.emailHeading,
    body: input.body,
    linkUrl: `${env.publicUrl}/b/${input.board.slug}/c/${input.card.id}`,
    linkLabel: "Open the card",
  });
}

// The Card's creator hears about column moves they did not make themselves, when the move is one
// that asks something of them or finishes the Card.
export async function notifyCardMoved(card: Card, from: Card["column"], actor: Actor): Promise<void> {
  if (!MOVES_WORTH_NOTICE.has(card.column)) return;
  if (card.creatorKind !== "user" || !card.creatorId) return;
  if (actor.kind === "user" && actor.id === card.creatorId) return;
  const board = await getBoardById(card.boardId);
  if (!board) return;
  const who = await actorProfile(actor);
  const title = `${who.name} moved your card to ${COLUMN_LABELS[card.column]}`;
  await notify({
    userId: card.creatorId,
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

// A Session on the Card failed or ran out of time. Its creator and the Admin hear about it, since
// otherwise the request would end with nobody knowing; the Card's own notice says the same. A person
// whose own action caused the end is not told of it.
export async function notifySessionFailed(card: Card, notice: { title: string; reason: string; next: string }, actor: Actor): Promise<void> {
  const board = await getBoardById(card.boardId);
  if (!board) return;
  const recipients = new Set<string>();
  if (card.creatorKind === "user" && card.creatorId) recipients.add(card.creatorId);
  const admins = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, "admin"));
  for (const a of admins) recipients.add(a.id);
  if (actor.kind === "user" && actor.id) recipients.delete(actor.id);
  const agent = await getAgentProfile();
  for (const userId of recipients) {
    await notify({
      userId,
      card,
      board,
      kind: "session_failed",
      title: notice.title,
      body: `${notice.reason}\n\n${notice.next}`,
      actor: agent,
      emailSubject: `${notice.title} "${card.title}"`,
      emailHeading: `${notice.title} ${card.title}`,
    });
  }
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

// A deleted Comment's words also sit in the notifications that quoted it. A notification does not
// record which Comment it came from, so it is matched by Card and by the preview it kept of any
// version of the Comment's body.
export async function forgetMentionNotifications(cardId: string, bodies: string[]): Promise<void> {
  const previews = [...new Set(bodies.map((b) => b.slice(0, PREVIEW_CHARS)))];
  if (previews.length === 0) return;
  await db
    .delete(schema.notifications)
    .where(and(eq(schema.notifications.cardId, cardId), eq(schema.notifications.kind, "mention"), inArray(schema.notifications.body, previews)));
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

// Opening a Card is reading what the bell had to say about it.
export async function markCardNotificationsRead(user: User, cardId: string): Promise<NotificationsView> {
  await db
    .update(schema.notifications)
    .set({ readAt: new Date().toISOString() })
    .where(and(eq(schema.notifications.userId, user.id), eq(schema.notifications.cardId, cardId), isNull(schema.notifications.readAt)));
  return listNotifications(user);
}
