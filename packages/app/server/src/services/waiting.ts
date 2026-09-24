import type { CardWaiting, SessionStatus } from "@kardboard/shared";

// The rules for a Card that has Triggers waiting and no Session yet: when its batch closes, whether
// an automatic dispatch should leave it alone for now, and what the Card tells people meanwhile.
// Plain functions over plain values, so the orchestrator and the Card's hydration read them the
// same way and the tests can check them without a clock or a database.

/** A Card whose last Session could not start is not retried automatically more often than this. */
export const START_BACKOFF_MS = 10 * 60_000;

type SessionEnd = { status: SessionStatus; startedAt: string | null; endedAt: string | null };

/**
 * When a Card's batch of Triggers closes. Every Trigger restarts the window, so a person still
 * writing is not interrupted halfway; but the window never stays open longer than `capMs` after the
 * oldest Trigger still waiting, or steady activity would hold the Session off for good. A cap
 * shorter than the window itself would cut every batch short, so the window is the floor.
 */
export function batchClosesAt(input: { oldestMs: number; newestMs: number; windowMs: number; capMs: number }): number {
  return Math.min(input.newestMs + input.windowMs, input.oldestMs + Math.max(input.capMs, input.windowMs));
}

/** How long to wait before dispatching a Card that has just received a Trigger. */
export function coalesceDelay(input: { nowMs: number; oldestPendingAt: string | null; windowMs: number; capMs: number }): number {
  const oldestMs = input.oldestPendingAt ? Date.parse(input.oldestPendingAt) : input.nowMs;
  const closes = batchClosesAt({ oldestMs: Number.isFinite(oldestMs) ? oldestMs : input.nowMs, newestMs: input.nowMs, windowMs: input.windowMs, capMs: input.capMs });
  return Math.max(0, closes - input.nowMs);
}

/** A Session that failed before its container ever ran: the runner refused it, or never answered. */
export function couldNotStart(last: SessionEnd | null): boolean {
  return last !== null && last.status === "failed" && last.startedAt === null;
}

/**
 * Whether an automatic dispatch should leave this Card alone for now. Its last Session could not
 * start a moment ago, and the usual cause, a runner that is down, would fail the next one the same
 * way. A person's own Trigger still dispatches at once; only the pumps wait.
 */
export function inStartBackoff(last: SessionEnd | null, nowMs: number): boolean {
  if (!couldNotStart(last) || !last!.endedAt) return false;
  return nowMs - Date.parse(last!.endedAt) < START_BACKOFF_MS;
}

/**
 * What a Card with Triggers waiting is waiting for. Nothing while a Session holds it: the pending
 * re-run says that. A paused Board outranks everything else, since nothing starts until the Admin
 * resumes it; a full cap outranks the batching window, since the Card waits for a slot either way.
 */
export function waitingState(input: {
  oldestPendingAt: string | null;
  active: boolean;
  paused: boolean;
  slotsFull: boolean;
  /** A dispatch timer is set for the Card: its batching window, or a retry the orchestrator planned. */
  dispatchPlanned: boolean;
  lastSession: SessionEnd | null;
}): CardWaiting | null {
  if (!input.oldestPendingAt || input.active) return null;
  const since = input.oldestPendingAt;
  if (input.paused) return { reason: "paused", since };
  if (input.slotsFull) return { reason: "slot", since };
  if (!input.dispatchPlanned && couldNotStart(input.lastSession)) return { reason: "retrying", since };
  return { reason: "coalescing", since };
}
