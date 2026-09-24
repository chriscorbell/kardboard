import { sqliteTable, text, integer, real, primaryKey, index } from "drizzle-orm/sqlite-core";
import type { ChecksSummary } from "@kardboard/shared";

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
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const boards = sqliteTable("boards", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  repoUrl: text("repo_url"),
  provider: text("provider", { enum: ["claude", "codex"] }).notNull().default("claude"),
  model: text("model"),
  reasoning: text("reasoning", { enum: ["low", "medium", "high", "max"] }),
  previewMode: text("preview_mode", { enum: ["external", "runner"] }).notNull().default("external"),
  // Bumped whenever this Board's membership narrows. A Preview cookie carries the epoch it was
  // issued under, so losing membership invalidates every outstanding cookie for the Board at once.
  previewEpoch: integer("preview_epoch").notNull().default(1),
  agentImage: text("agent_image"),
  maxConcurrentSessions: integer("max_concurrent_sessions").notNull().default(3),
  promptAppend: text("prompt_append").notNull().default(""),
  // The Admin's pause switch. A paused Board starts no Session and skips the nightly sweep; its
  // Triggers stay pending and are dispatched when it is resumed.
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
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
    // How a Card in Done ended: `implemented` when kardboard merged its pull request, `closed`
    // otherwise. A parent reading its finished children needs to tell the two apart.
    outcome: text("outcome", { enum: ["implemented", "closed"] }),
    revision: integer("revision").notNull().default(0),
    branch: text("branch"),
    prUrl: text("pr_url"),
    prNumber: integer("pr_number"),
    // The pull request head a Member is shown and approves. Read from GitHub when a Session reports
    // the pull request or moves the Card to Review, never taken from the Session's word.
    prHeadSha: text("pr_head_sha"),
    // The branch the pull request merges into, so Approve can say where the change lands.
    prBaseRef: text("pr_base_ref"),
    // CI on the pull request, summed up from GitHub's check runs and commit statuses by the
    // reconciliation poll, on Approve, and when someone opens the Card in Review.
    checks: text("checks", { mode: "json" }).$type<ChecksSummary>(),
    previewUrl: text("preview_url"),
    pendingRerun: integer("pending_rerun", { mode: "boolean" }).notNull().default(false),
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
    sessionId: text("session_id"),
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

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  prNumber: integer("pr_number"),
  headSha: text("head_sha"),
  createdAt: text("created_at").notNull().$defaultFn(now),
  invalidatedAt: text("invalidated_at"),
  // Why GitHub last refused to merge on this Approval. Set only for a refusal the Approval
  // survives, so the Card can offer Retry merge; cleared once the merge lands or the Approval is
  // invalidated.
  mergeError: text("merge_error"),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
    cardId: text("card_id"),
    kind: text("kind", { enum: ["card", "sweep"] }).notNull().default("card"),
    provider: text("provider", { enum: ["claude", "codex"] }).notNull(),
    // The Provider this Session was moved off because it had no usage left. Also the stop on a
    // fallback loop: a Session that already fell back does not fall back again.
    fallbackFrom: text("fallback_from", { enum: ["claude", "codex"] }),
    status: text("status", {
      enum: ["queued", "starting", "running", "succeeded", "failed", "cancelled", "timed_out"],
    })
      .notNull()
      .default("queued"),
    intent: text("intent"),
    branch: text("branch"),
    containerId: text("container_id"),
    tokenHash: text("token_hash"),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    outcomeSummary: text("outcome_summary"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("sessions_board_status_idx").on(t.boardId, t.status)],
);

export const triggers = sqliteTable(
  "triggers",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id").notNull(),
    cardId: text("card_id").notNull(),
    kind: text("kind").notNull(),
    actorUserId: text("actor_user_id"),
    payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    status: text("status", { enum: ["pending", "consumed"] }).notNull().default("pending"),
    sessionId: text("session_id"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("triggers_card_status_idx").on(t.cardId, t.status)],
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
    readAt: text("read_at"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

// One runner-hosted Preview per Card: the branch's own Dockerfile, built and run by the runner and
// reached at its own hostname through the preview router.
export const previews = sqliteTable(
  "previews",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
    cardId: text("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }).unique(),
    host: text("host").notNull().unique(),
    status: text("status", { enum: ["building", "running", "failed"] }).notNull().default("building"),
    branch: text("branch").notNull(),
    port: integer("port").notNull().default(3000),
    containerId: text("container_id"),
    // Where the router proxies to, on the preview network: `http://kardboard-preview-<id>:<port>`.
    target: text("target"),
    error: text("error"),
    // The commit the runner last built, whether the build ran or failed. A rebuild keeps serving the
    // previous container until it finishes, so while one runs this is still the commit being served.
    sha: text("sha"),
    // Drives the seven-idle-day removal: touched whenever someone is let through to the Preview,
    // and whenever it is rebuilt.
    lastAccessAt: text("last_access_at").notNull().$defaultFn(now),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => [index("previews_board_idx").on(t.boardId)],
);

// Single-use authorization codes that carry a signed-in Member from the app to a Preview host.
// Short-lived, bound to one host and one User, and deleted as they are spent.
export const previewCodes = sqliteTable("preview_codes", {
  code: text("code").primaryKey(),
  previewId: text("preview_id").notNull().references(() => previews.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const outboundEmails = sqliteTable("outbound_emails", {
  id: text("id").primaryKey(),
  toUserId: text("to_user_id").notNull(),
  subject: text("subject").notNull(),
  html: text("html").notNull(),
  status: text("status", { enum: ["pending", "sent", "failed", "logged"] }).notNull().default("pending"),
  error: text("error"),
  createdAt: text("created_at").notNull().$defaultFn(now),
  sentAt: text("sent_at"),
});
