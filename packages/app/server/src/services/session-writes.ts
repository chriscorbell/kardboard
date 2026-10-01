import { MAX_WALL_CLOCK_MINUTES } from "@kardboard/shared";

// A Session runs a coding agent on words any Member wrote, so it may have been talked into doing
// harm, and the writes it makes through MCP reach people: a Comment that Mentions someone can email
// them, and so can a move of their Card into Blocked, Review, or Done. These caps sit far above
// what a Session doing its work needs, which is one report Comment, a question or two, a handful
// of moves, and at most eight child Cards, and far below a flood. A sweep has the same caps; what
// it cannot finish one night, the next night's sweep does.
//
// Counted per Session, so one that reaches a cap leaves the other Sessions on its Board alone. An
// Access token is not counted: it is the Admin's own agent, run on the Admin's machine and at the
// Admin's word, so what it writes is the Admin's doing.
export const SESSION_WRITE_LIMITS = { comment: 25, card: 20, move: 50 } as const;

export type SessionWrite = keyof typeof SESSION_WRITE_LIMITS;

const DONE: Record<SessionWrite, (limit: number) => string> = {
  comment: (limit) => `posted ${limit} comments`,
  card: (limit) => `created ${limit} cards`,
  move: (limit) => `moved cards ${limit} times`,
};

// Kept in memory, since one process serves every Session (ADR 0004). Counting from the event log
// instead would survive a restart, but costs a scan of the Board's whole history on every write. A
// restart starts the counts again, so a Session running across a deploy may write up to twice the
// cap, which is still nowhere near the flood this stops.
const made = new Map<string, { since: number; counts: Record<SessionWrite, number> }>();

// No Session runs longer than the longest wall clock, so a count older than twice that belongs to
// one that has ended.
const FORGET_AFTER_MS = 2 * MAX_WALL_CLOCK_MINUTES * 60_000;

/**
 * Counts one write of this kind against the Session's cap, or throws, with what to do next, once
 * the Session has made as many as its cap allows. Called just before the write, after every other
 * check: calls made in parallel each take their own count, so they cannot all slip under the cap,
 * and a write that then fails, such as a move refused for an old revision, still uses one up.
 */
export function takeSessionWrite(sessionId: string, kind: SessionWrite, now = Date.now()): void {
  let entry = made.get(sessionId);
  if (!entry) {
    for (const [id, old] of made) if (now - old.since > FORGET_AFTER_MS) made.delete(id);
    entry = { since: now, counts: { comment: 0, card: 0, move: 0 } };
    made.set(sessionId, entry);
  }
  const limit = SESSION_WRITE_LIMITS[kind];
  if (entry.counts[kind] >= limit) {
    throw new Error(`this session has already ${DONE[kind](limit)}, the limit for one session. Finish with what you have: call finish, and say in its summary what is left undone.`);
  }
  entry.counts[kind]++;
}
