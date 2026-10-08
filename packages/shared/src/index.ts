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

// What a Card in Done turned out to be: `implemented` when the agent that merged its pull request
// said so as it closed the Card, `closed` for anything else, a duplicate or work that was not needed.
export const CARD_OUTCOMES = ["implemented", "closed"] as const;
export type CardOutcome = (typeof CARD_OUTCOMES)[number];

export type ActorKind = "user" | "agent" | "system";

/** The one person who signs in. */
export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  createdAt: string;
}

/**
 * Enough of a User to say who did something: a name and a face. A Board names everyone who appears
 * on it this way, which is the User, and anyone from when kardboard had Members.
 */
export type Person = Pick<User, "id" | "name" | "avatarUrl">;

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
}

export interface ActivityEntry {
  id: string;
  type: string;
  actorKind: ActorKind;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentProfile {
  name: string;
  avatarUrl: string | null;
}

export interface BoardView {
  board: Board;
  cards: Card[];
  /** Everyone who appears on the Board, for names. */
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
  onboarded: z.boolean().optional(),
});
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

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

/** An Access token as the User sees it: never the token itself, which is shown once, at creation. */
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

// What deleting a Board would take with it, shown before the User confirms.
export interface BoardDeletionImpact {
  cards: number;
  comments: number;
  attachments: number;
}

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
