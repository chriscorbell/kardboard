import { z } from "zod";

// Columns are fixed in v1. Order matters: it is the board's left-to-right order.
export const COLUMNS = ["inbox", "blocked", "ready", "in_progress", "review", "done"] as const;
export type Column = (typeof COLUMNS)[number];
export const columnSchema = z.enum(COLUMNS);

export const COLUMN_LABELS: Record<Column, string> = {
  inbox: "Inbox",
  blocked: "Blocked",
  ready: "Ready",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

export const PRIORITIES = ["none", "low", "medium", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const prioritySchema = z.enum(PRIORITIES);

export const PROVIDERS = ["claude", "codex"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const providerSchema = z.enum(PROVIDERS);

export const REASONING_LEVELS = ["low", "medium", "high", "max"] as const;
export type Reasoning = (typeof REASONING_LEVELS)[number];
export const reasoningSchema = z.enum(REASONING_LEVELS);

export const PREVIEW_MODES = ["external", "runner"] as const;
export type PreviewMode = (typeof PREVIEW_MODES)[number];

export const USER_ROLES = ["admin", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["invited", "active", "revoked"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const SESSION_KINDS = ["card", "sweep"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const SESSION_STATUSES = [
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const ACTIVE_SESSION_STATUSES: readonly SessionStatus[] = ["queued", "starting", "running"];

export const TRIGGER_KINDS = [
  "card_created",
  "card_edited",
  "card_moved",
  "comment_posted",
  "comment_edited",
  "approval",
  // Not raised by a person: the orchestrator raises one when a Session ran out of Provider usage,
  // so the Card is picked up again on the other Provider with the same work in front of it.
  "provider_fallback",
  // Also not raised by a person. A Session that splits a request into child Cards leaves work
  // nobody would otherwise start, and a parent that nothing would otherwise wake.
  "child_card_created",
  "children_done",
  // A person pressed Try again on a Card whose last Session failed or timed out. It starts at once
  // rather than waiting out the batching window.
  "retry_requested",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

// What a Card in Done turned out to be. A child Card that was merged carries its parent's work
// forward; one closed as a duplicate, or as work that was not needed, does not.
export const CARD_OUTCOMES = ["implemented", "closed"] as const;
export type CardOutcome = (typeof CARD_OUTCOMES)[number];

// What the app notifies a user about. Every kind also sends that user an email. `session_failed`
// goes to a Card's creator and the Admin when a Session on it failed or ran out of time.
export const NOTIFICATION_KINDS = ["mention", "card_moved", "session_failed"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

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

export interface Board {
  id: string;
  slug: string;
  name: string;
  repoUrl: string | null;
  provider: Provider;
  model: string | null;
  reasoning: Reasoning | null;
  previewMode: PreviewMode;
  agentImage: string | null;
  maxConcurrentSessions: number;
  promptAppend: string;
  /** Set by the Admin: no new Session starts on this Board, and its Triggers wait until it is resumed. */
  paused: boolean;
  createdAt: string;
}

// Why a Card with Triggers waiting has no Session yet. `coalescing`: its batching window is still
// open. `slot`: the Board's or the global cap is full. `paused`: the Admin paused its Board.
// `retrying`: its last Session could not start, and kardboard tries again in a few minutes.
export const WAITING_REASONS = ["coalescing", "slot", "paused", "retrying"] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];
export interface CardWaiting {
  reason: WaitingReason;
  /** When the oldest Trigger still waiting was raised. */
  since: string;
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
  /** The pull request head a Member is shown and approves. Approve sends it back. */
  prHeadSha: string | null;
  /** The branch the pull request merges into, as GitHub last reported it. */
  prBaseRef: string | null;
  /** CI on the pull request, as kardboard last read it from GitHub. */
  checks: ChecksSummary | null;
  previewUrl: string | null;
  commentCount: number;
  activeSession: SessionSummary | null;
  /** The most recent card Session on this Card that has ended, whatever its outcome. */
  lastSession: SessionSummary | null;
  /** Set while the Card has Triggers waiting and no Session: what it is waiting for. */
  waiting: CardWaiting | null;
  pendingRerun: boolean;
  createdAt: string;
  updatedAt: string;
}

// A pull request's CI, summed up: `failing` when anything failed, `pending` while anything is still
// running, `none` when nothing ran, and `unknown` when GitHub would not say, for want of the Merge
// app's Checks or Commit statuses permission or because it did not answer.
export const CHECK_STATES = ["passing", "failing", "pending", "none", "unknown"] as const;
export type CheckState = (typeof CHECK_STATES)[number];

export interface ChecksSummary {
  state: CheckState;
  total: number;
  failed: number;
  pending: number;
  /** The head these checks ran on. Once the Card's `prHeadSha` moves on they describe old code. */
  sha: string;
  updatedAt: string;
}

/** "2 of 7 checks failed": a summary in words, the same on the Card and in what the server says. */
export function describeChecks(summary: Pick<ChecksSummary, "state" | "total" | "failed" | "pending">): string {
  const { total, failed, pending } = summary;
  switch (summary.state) {
    case "failing":
      return total === 1 ? "The check failed" : `${failed} of ${total} checks failed`;
    case "pending":
      return total === 1 ? "The check is still running" : `${pending} of ${total} checks ${pending === 1 ? "is" : "are"} still running`;
    case "passing":
      return total === 1 ? "The check passed" : `All ${total} checks passed`;
    case "none":
      return "No checks ran on this commit";
    case "unknown":
      return "GitHub did not say how the checks went";
  }
}

export interface SessionSummary {
  id: string;
  kind: SessionKind;
  status: SessionStatus;
  provider: Provider;
  /** Set when this Session runs on the other Provider because `provider` ran out of usage. */
  fallbackFrom: Provider | null;
  intent: string | null;
  branch: string | null;
  cardId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  outcomeSummary: string | null;
  createdAt: string;
}

// ---- session transcripts ----
// A Session's container log is the transcript. The runner keeps the bytes; the app parses them
// into entries so the admin panel can render a run as it happens instead of a wall of JSON.
export const TRANSCRIPT_ENTRY_KINDS = ["system", "thinking", "text", "tool", "tool_result", "result", "log"] as const;
export type TranscriptEntryKind = (typeof TRANSCRIPT_ENTRY_KINDS)[number];

export interface TranscriptEntry {
  at: string | null;
  kind: TranscriptEntryKind;
  label: string | null;
  body: string;
  truncated: boolean;
  isError: boolean;
}

export interface SessionTranscript {
  // false when the runner has no log for this session: it never ran, or the log has been pruned.
  available: boolean;
  entries: TranscriptEntry[];
  // Byte offset to ask for next. Pass it back to get only what has been written since.
  nextOffset: number;
  size: number;
  // The requested offset was too far behind the head, so entries start mid-run.
  skipped: boolean;
  note: string | null;
}

export interface Attachment {
  id: string;
  commentId: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
}

export interface Comment {
  id: string;
  cardId: string;
  authorKind: ActorKind;
  authorId: string | null;
  sessionId: string | null;
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

export interface Approval {
  id: string;
  cardId: string;
  userId: string;
  prNumber: number | null;
  headSha: string | null;
  createdAt: string;
  invalidatedAt: string | null;
  // Why GitHub last refused to merge on this Approval, for a refusal the Approval survives.
  mergeError: string | null;
}

/**
 * The Approval waiting on a merge that GitHub refused for a reason the Approval survives, so the
 * Card offers a retry rather than asking for a second sign-off. Newest first, as the server lists.
 */
export function approvalAwaitingRetry(approvals: Approval[]): Approval | null {
  return approvals.find((a) => !a.invalidatedAt && a.mergeError) ?? null;
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
  members: User[];
  sessions: SessionSummary[];
  agent: AgentProfile;
}

export interface CardDetail {
  card: Card;
  comments: Comment[];
  activity: ActivityEntry[];
  approvals: Approval[];
  children: Card[];
}

export interface Me {
  user: User;
  agent: AgentProfile;
  authMode: "dev" | "clerk";
}

// ---- request schemas ----

export const createCardSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(""),
  priority: prioritySchema.default("none"),
  column: columnSchema.default("inbox"),
  silent: z.boolean().optional(),
});
export type CreateCardInput = z.infer<typeof createCardSchema>;

export const updateCardSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  priority: prioritySchema.optional(),
  revision: z.number().int().nonnegative(),
  silent: z.boolean().optional(),
});
export type UpdateCardInput = z.infer<typeof updateCardSchema>;

export const moveCardSchema = z.object({
  column: columnSchema,
  position: z.number(),
  revision: z.number().int().nonnegative(),
  silent: z.boolean().optional(),
});
export type MoveCardInput = z.infer<typeof moveCardSchema>;

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  silent: z.boolean().optional(),
});
export const updateCommentSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
});

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
  provider: providerSchema.default("claude"),
  model: z.string().trim().max(80).nullable().optional(),
  reasoning: reasoningSchema.nullable().optional(),
  previewMode: z.enum(PREVIEW_MODES).default("external"),
  agentImage: z.string().trim().max(200).nullable().optional(),
  maxConcurrentSessions: z.number().int().min(1).max(10).default(3),
  promptAppend: z.string().max(10_000).default(""),
  // Left out, a new Board starts unpaused and an update leaves the switch where it was.
  paused: z.boolean().optional(),
});

export const boardMembersSchema = z.object({ userIds: z.array(z.string()) });

// No ids means "mark everything read".
export const markNotificationsReadSchema = z.object({ ids: z.array(z.string()).optional() });

export const settingsSchema = z.object({
  agentName: z.string().trim().min(1).max(40).optional(),
  agentAvatarUrl: z
    .string()
    .refine((v) => v.startsWith("/") || /^https?:\/\//.test(v), "an absolute URL or a path on this site")
    .nullable()
    .optional(),
  globalMaxConcurrentSessions: z.number().int().min(1).max(20).optional(),
  sessionWallClockMinutes: z.number().int().min(5).max(240).optional(),
  providerFallback: z.boolean().optional(),
});
export type Settings = {
  agentName: string;
  agentAvatarUrl: string | null;
  globalMaxConcurrentSessions: number;
  sessionWallClockMinutes: number;
  /** Move a Card to the other Provider when the one it was running on is out of usage. */
  providerFallback: boolean;
};

// A SQLite snapshot on the data bind mount, written with VACUUM INTO and verified before it counts.
export interface BackupSnapshot {
  name: string;
  bytes: number;
  takenAt: string;
}

// The most recent snapshot attempt since the app started, scheduled or on demand. A failure is
// retried on the next tick, so `error` stays set until one succeeds.
export interface BackupAttempt {
  at: string;
  ok: boolean;
  error: string | null;
}

export interface BackupsView {
  dir: string;
  hour: number; // local hour of the daily snapshot; negative means scheduled snapshots are off
  keep: number;
  databaseBytes: number;
  snapshots: BackupSnapshot[];
  lastAttempt: BackupAttempt | null;
}

// ---- realtime ----
export type BoardEvent =
  | { type: "card.upserted"; card: Card }
  | { type: "card.removed"; cardId: string }
  | { type: "comment.upserted"; comment: Comment }
  | { type: "session.updated"; session: SessionSummary }
  | { type: "board.updated"; board: Board };

// Mentions are @handle tokens. Handles are lowercase, from the user's email local part.
// A handle can contain dots and hyphens but not end with one, so "thanks @chris." mentions chris.
export const MENTION_RE = /(^|[^\w@])@([a-z0-9](?:[a-z0-9._-]{0,37}[a-z0-9])?)/gi;

export function extractMentionHandles(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) out.add(m[2]!.toLowerCase());
  return [...out];
}

export function slugifyBranch(cardId: string, title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `kardboard/${cardId.slice(0, 8)}-${base || "card"}`;
}
