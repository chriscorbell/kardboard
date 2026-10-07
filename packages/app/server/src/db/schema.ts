import { sqliteTable, text, integer, real, primaryKey, index } from "drizzle-orm/sqlite-core";

const now = () => new Date().toISOString();

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  handle: text("handle").notNull().unique(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  status: text("status", { enum: ["invited", "active", "revoked"] }).notNull().default("invited"),
  clerkUserId: text("clerk_user_id").unique(),
  // How much this User wants by email: everything, only what asks something of them, or nothing.
  // The bell records every notification whichever they choose.
  emailPreference: text("email_preference", { enum: ["all", "important", "off"] }).notNull().default("all"),
  // When the User dismissed the board explainer. Kept here rather than in the browser, since
  // clients move between a laptop and a phone.
  onboardedAt: text("onboarded_at"),
  // Set when the Admin removed a revoked User. The row stays, with its name and handle, so what they
  // wrote is still signed; the email, sign-in, avatar, and everything addressed to them are gone.
  removedAt: text("removed_at"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const boards = sqliteTable("boards", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  repoUrl: text("repo_url"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const boardMembers = sqliteTable(
  "board_members",
  {
    boardId: text("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.userId] })],
);

export const cards = sqliteTable(
  "cards",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    priority: text("priority", { enum: ["none", "low", "medium", "high"] }).notNull().default("none"),
    column: text("column", { enum: ["inbox", "blocked", "ready", "in_progress", "review", "done"] })
      .notNull()
      .default("inbox"),
    position: real("position").notNull().default(0),
    creatorKind: text("creator_kind", { enum: ["user", "agent", "system"] }).notNull().default("user"),
    creatorId: text("creator_id"),
    parentCardId: text("parent_card_id"),
    // How a Card in Done ended: `implemented` when the agent that merged its pull request said so as
    // it closed the Card, `closed` otherwise.
    outcome: text("outcome", { enum: ["implemented", "closed"] }),
    revision: integer("revision").notNull().default(0),
    branch: text("branch"),
    prUrl: text("pr_url"),
    prNumber: integer("pr_number"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => [index("cards_board_column_idx").on(t.boardId, t.column)],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
    authorKind: text("author_kind", { enum: ["user", "agent", "system"] }).notNull(),
    authorId: text("author_id"),
    body: text("body").notNull(),
    editedAt: text("edited_at"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("comments_card_idx").on(t.cardId)],
);

export const commentRevisions = sqliteTable("comment_revisions", {
  id: text("id").primaryKey(),
  commentId: text("comment_id").notNull().references(() => comments.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  replacedAt: text("replaced_at").notNull().$defaultFn(now),
});

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  commentId: text("comment_id").notNull().references(() => comments.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const mentions = sqliteTable(
  "mentions",
  {
    commentId: text("comment_id").notNull().references(() => comments.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    notifiedAt: text("notified_at"),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.userId] })],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id").notNull(),
    cardId: text("card_id"),
    actorKind: text("actor_kind", { enum: ["user", "agent", "system"] }).notNull(),
    actorId: text("actor_id"),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("events_card_idx").on(t.cardId), index("events_board_idx").on(t.boardId)],
);

// One row per thing a user is notified of, kept so the bell can show it in the app. Whether an email
// goes with it is the user's email preference.
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    boardId: text("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
    cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["mention", "card_moved", "session_failed"] }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    actorName: text("actor_name").notNull(),
    actorAvatarUrl: text("actor_avatar_url"),
    // The Comment a Mention came from, so deleting the Comment takes its notifications with it.
    commentId: text("comment_id"),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

// The Admin's credentials for their own coding agent, each good for one Board, where whoever holds
// it acts as the Agent. Only the hash is kept; the token is shown once.
export const accessTokens = sqliteTable(
  "access_tokens",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("access_tokens_board_idx").on(t.boardId)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const outboundEmails = sqliteTable("outbound_emails", {
  id: text("id").primaryKey(),
  toUserId: text("to_user_id").notNull(),
  // The Comment whose words the email carries, so deleting the Comment can remove them here too.
  commentId: text("comment_id"),
  subject: text("subject").notNull(),
  html: text("html").notNull(),
  status: text("status", { enum: ["pending", "sent", "failed", "logged"] }).notNull().default("pending"),
  error: text("error"),
  createdAt: text("created_at").notNull().$defaultFn(now),
  sentAt: text("sent_at"),
});
