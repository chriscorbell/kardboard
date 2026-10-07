import { z } from "zod";

// Columns are fixed in v1. Order matters: it is the board's left-to-right order. The first is shown as
// Backlog but keeps the key it had as Inbox, so stored Cards, events, and agents' column values still hold.
export const COLUMNS = ["inbox", "blocked", "ready", "in_progress", "review", "done"] as const;
export type Column = (typeof COLUMNS)[number];
export const columnSchema = z.enum(COLUMNS);

export const COLUMN_LABELS: Record<Column, string> = {
  inbox: "Backlog",
  blocked: "Blocked",
  ready: "Ready",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

export const PRIORITIES = ["none", "low", "medium", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const prioritySchema = z.enum(PRIORITIES);

export const USER_ROLES = ["admin", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["invited", "active", "revoked"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

// What a Card in Done turned out to be: `implemented` when the agent that merged its pull request
// said so as it closed the Card, `closed` for anything else, a duplicate or work that was not needed.
export const CARD_OUTCOMES = ["implemented", "closed"] as const;
export type CardOutcome = (typeof CARD_OUTCOMES)[number];

// What the app notifies a user about. Every kind is recorded in the app; whether it is also emailed
// depends on the User's EmailPreference. `session_failed` goes to a Card's creator and the Admin
// when a Session on it failed or ran out of time.
export const NOTIFICATION_KINDS = ["mention", "card_moved", "session_failed"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// How much a User wants by email. In-app notifications are recorded whatever they choose.
// "important" keeps what asks something of the reader: Mentions, a failed Session, and a Card of
// theirs moving to Blocked or Review.
export const EMAIL_PREFERENCES = ["all", "important", "off"] as const;
export type EmailPreference = (typeof EMAIL_PREFERENCES)[number];

export type ActorKind = "user" | "agent" | "system";

export interface User {
  id: string;
  email: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

/**
 * Enough of a User to say who did something: a name, a face, and the handle a Mention uses. A
 * Board lists everyone who ever appeared on it this way, so a Member who was removed or revoked
 * keeps their name on their Cards and Comments, without their email going with it.
 */
export type Person = Pick<User, "id" | "handle" | "name" | "avatarUrl">;

/**
 * A User on a Board's member list. Only the Admin is sent the email: a Board can be shared by people
 * from different clients, and a Member has no need of anyone else's address.
 */
export type BoardMember = Omit<User, "email"> & Partial<Pick<User, "email">>;

export interface Board {
  id: string;
  slug: string;
  name: string;
  repoUrl: string | null;
  createdAt: string;
}

export interface Card {
  id: string;
  boardId: string;
  title: string;
  description: string;
  priority: Priority;
  column: Column;
  position: number;
  creatorKind: ActorKind;
  creatorId: string | null;
  parentCardId: string | null;
  /** Set when the Card reaches Done, and cleared if it is reopened. */
  outcome: CardOutcome | null;
  revision: number;
  branch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  commentCount: number;
  /** In Blocked with the Agent's question as the last word on it, so a person owes it an answer. */
  awaitingReply: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  id: string;
  commentId: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
}

// The Attachment types shown as pictures, by the server inline and by the app as thumbnails and in
// the viewer. Every other type is a file to download. These are raster formats that no browser runs
// script in, which is why SVG is not among them: an SVG opened on its own is a document, and its
// script runs with whatever the origin it opened on can reach.
export const DISPLAYABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"] as const;

const MIME_ESSENCE = /^[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+$/;

/**
 * A type as the uploader's browser named it, cut to its lowercase `type/subtype`: "Image/SVG+XML;
 * charset=utf-8" is "image/svg+xml". Anything not shaped like a type is application/octet-stream, so
 * comparing the result against a list cannot be dodged with case, parameters, or whitespace.
 */
export function mimeEssence(mime: string): string {
  const essence = mime.split(";", 1)[0]!.trim().toLowerCase();
  return MIME_ESSENCE.test(essence) ? essence : "application/octet-stream";
}

/** Whether an Attachment of this type is shown as a picture rather than downloaded. */
export function isDisplayableImage(mime: string): boolean {
  return (DISPLAYABLE_IMAGE_TYPES as readonly string[]).includes(mimeEssence(mime));
}

export interface Comment {
  id: string;
  cardId: string;
  authorKind: ActorKind;
  authorId: string | null;
  body: string;
  editedAt: string | null;
  createdAt: string;
  attachments: Attachment[];
  mentions: string[];
}

export interface ActivityEntry {
  id: string;
  type: string;
  actorKind: ActorKind;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  actorName: string;
  actorAvatarUrl: string | null;
  boardSlug: string;
  cardId: string;
  cardTitle: string;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsView {
  unread: number;
  notifications: Notification[];
}

export interface AgentProfile {
  name: string;
  avatarUrl: string | null;
}

export interface BoardView {
  board: Board;
  cards: Card[];
  /** Who can open the Board now and is not revoked: the people a Mention can reach. */
  members: BoardMember[];
  /** Everyone who can open the Board or appears on it, former Members included. For names only. */
  people: Person[];
  agent: AgentProfile;
}

export interface CardDetail {
  card: Card;
  comments: Comment[];
  activity: ActivityEntry[];
  children: Card[];
}

export interface Me {
  user: User;
  agent: AgentProfile;
  authMode: "dev" | "clerk";
  emailPreference: EmailPreference;
  /** When this User dismissed the board explainer. Null shows it on the next Board they open. */
  onboardedAt: string | null;
}

// ---- request schemas ----

export const createCardSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(""),
  priority: prioritySchema.default("none"),
  column: columnSchema.default("inbox"),
});
export type CreateCardInput = z.infer<typeof createCardSchema>;

export const updateCardSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  priority: prioritySchema.optional(),
  revision: z.number().int().nonnegative(),
});
export type UpdateCardInput = z.infer<typeof updateCardSchema>;

export const moveCardSchema = z.object({
  column: columnSchema,
  position: z.number(),
  revision: z.number().int().nonnegative(),
});
export type MoveCardInput = z.infer<typeof moveCardSchema>;

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
});
export const updateCommentSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
});

// A User's own settings. `onboarded: true` records that the board explainer was dismissed.
export const updateMeSchema = z.object({
  emailPreference: z.enum(EMAIL_PREFERENCES).optional(),
  onboarded: z.boolean().optional(),
});
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const inviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120),
  role: z.enum(USER_ROLES).default("member"),
});

export const upsertBoardSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "lowercase letters, digits, and hyphens"),
  repoUrl: z.string().url().nullable().optional(),
});

export const boardMembersSchema = z.object({ userIds: z.array(z.string()) });

/** An Access token as the Admin sees it: never the token itself, which is shown once, at creation. */
export interface AccessToken {
  id: string;
  boardId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A token just made: the only time its secret leaves the server. */
export interface CreatedAccessToken {
  accessToken: AccessToken;
  secret: string;
}

export const createAccessTokenSchema = z.object({ name: z.string().trim().min(1).max(80) });

// Deleting a Board names it again, so a request meant for another Board, or sent by mistake, fails.
export const deleteBoardSchema = z.object({ slug: z.string() });

// What deleting a Board would take with it, shown before the Admin confirms.
export interface BoardDeletionImpact {
  cards: number;
  comments: number;
  attachments: number;
}

// No ids means "mark everything read".
export const markNotificationsReadSchema = z.object({ ids: z.array(z.string()).optional() });

export const settingsSchema = z.object({
  agentName: z.string().trim().min(1).max(40).optional(),
  agentAvatarUrl: z
    .string()
    .refine((v) => v.startsWith("/") || /^https?:\/\//.test(v), "an absolute URL or a path on this site")
    .nullable()
    .optional(),
});
export type Settings = {
  agentName: string;
  agentAvatarUrl: string | null;
};

// A SQLite snapshot on the data bind mount, written with VACUUM INTO and verified before it counts.
// `pre_migrate` ones are taken at boot before a new image changes the schema, and pruned apart
// from the daily ones so a run of deploys cannot push those out.
export interface BackupSnapshot {
  name: string;
  bytes: number;
  takenAt: string;
  kind: "regular" | "pre_migrate";
}

// The most recent snapshot attempt, scheduled or on demand, kept across restarts. A failure is
// retried on the next tick, so `error` stays set until one succeeds.
export interface BackupAttempt {
  at: string;
  ok: boolean;
  error: string | null;
}

// The most recent copy of a snapshot, and of new attachments, to the off-disk directory.
export interface BackupCopy {
  at: string;
  ok: boolean;
  error: string | null;
  snapshot: string | null;
  uploadsCopied: number;
}

export interface BackupsView {
  dir: string;
  hour: number; // local hour of the daily snapshot; negative means scheduled snapshots are off
  keep: number;
  databaseBytes: number;
  snapshots: BackupSnapshot[];
  lastAttempt: BackupAttempt | null;
  /** Where each snapshot and `uploads/` are copied off the disk, or null when that is not set up. */
  copyDir: string | null;
  lastCopy: BackupCopy | null;
}

// ---- realtime ----
export type BoardEvent =
  | { type: "card.upserted"; card: Card }
  | { type: "card.removed"; cardId: string }
  | { type: "comment.upserted"; comment: Comment }
  | { type: "comment.removed"; commentId: string; cardId: string }
  | { type: "board.updated"; board: Board }
  | { type: "board.deleted"; boardId: string };

// Mentions are @handle tokens. Handles are lowercase, from the user's email local part.
// A handle can contain dots and hyphens but not end with one, so "thanks @chris." mentions chris.
export const MENTION_RE = /(^|[^\w@])@([a-z0-9](?:[a-z0-9._-]{0,37}[a-z0-9])?)/gi;

// Fenced blocks and inline code, which keep an @ as typed: `@tanstack/react-query` names a package.
const CODE_SPANS = /(```[\s\S]*?```|`[^`\n]*`)/;

/**
 * The text as a person should read it: each @handle that `nameOf` knows becomes @ and the name.
 * Handles it does not know, and anything in code, are left as written. Comments are stored with
 * handles, which is what a Mention is and what the Agent writes; this is only for showing them.
 */
export function mentionsAsNames(text: string, nameOf: (handle: string) => string | undefined): string {
  return outsideCode(text, (part) =>
    part.replace(MENTION_RE, (all, before: string, handle: string) => {
      const name = nameOf(handle.toLowerCase());
      return name ? `${before}@${name}` : all;
    }),
  );
}

/** Applies `fn` to the text outside fenced blocks and inline code, and keeps the code as it is. */
export function outsideCode(text: string, fn: (part: string) => string): string {
  return text
    .split(CODE_SPANS)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

export function extractMentionHandles(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) out.add(m[2]!.toLowerCase());
  return [...out];
}
