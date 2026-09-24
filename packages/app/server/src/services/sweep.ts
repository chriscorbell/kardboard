import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";
import { recordEvent, SYSTEM_ACTOR } from "./events.js";
import { runner } from "./runner-client.js";
import { getSettings } from "./settings.js";
import { activeCount, startSession, underClaimLock } from "./orchestrator.js";
import { providerForDispatch } from "./fallback.js";
import { readProviderLimits } from "./provider-limits.js";

const SWEEP_HOUR = Number(process.env.KARDBOARD_SWEEP_HOUR ?? "3");
const WAIT_LIMIT_MS = 60 * 60_000;
const ACTIVE = ["queued", "starting", "running"] as const;

// Nightly hygiene sweep: one sweep Session per Board at SWEEP_HOUR local time. It waits up to an
// hour for card Sessions on that Board to finish, then runs regardless. Counts against the global
// cap only. Nothing runs in noop mode, or on a paused Board.
export function startSweepScheduler(): void {
  if (runner.mode === "noop") return;
  setInterval(() => void sweepTick().catch((err) => console.error("[sweep] tick failed", err)), 60_000);
}

// Whether the Board has had its sweep since tonight's window opened. The Session rows are the
// record, not memory, so an app restart inside the window does not sweep every Board a second time.
async function sweptSince(boardId: string, windowOpened: Date): Promise<boolean> {
  const row = await db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.boardId, boardId), eq(schema.sessions.kind, "sweep"), gte(schema.sessions.createdAt, windowOpened.toISOString())))
    .get();
  return Boolean(row);
}

export async function sweepTick(now = new Date()): Promise<void> {
  if (now.getHours() < SWEEP_HOUR || now.getHours() >= SWEEP_HOUR + 2) return;
  // The window opens at SWEEP_HOUR on the local clock, the same clock the check above reads.
  const opened = new Date(now);
  opened.setHours(SWEEP_HOUR, 0, 0, 0);
  const boards = await db.select().from(schema.boards);
  for (const board of boards) {
    // A paused Board starts no Session of any kind. Its sweep is skipped, not owed: resuming the
    // Board mid-window sweeps it that night, and otherwise the next night's window does.
    if (board.paused) continue;
    if (await sweptSince(board.id, opened)) continue;
    const busy = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.boardId, board.id), eq(schema.sessions.kind, "card"), inArray(schema.sessions.status, [...ACTIVE])))
      .get();
    if (Number(busy?.n ?? 0) > 0 && now.getTime() - opened.getTime() < WAIT_LIMIT_MS) continue;
    await startSweep(board, opened);
  }
}

async function startSweep(board: typeof schema.boards.$inferSelect, windowOpened: Date): Promise<void> {
  // Read before the claim lock: the egress proxy can take seconds to answer.
  const limits = await readProviderLimits();
  const token = randomBytes(32).toString("base64url");
  // The global cap is checked under the lock card dispatch takes, so a sweep and a Card cannot both
  // take the last slot. The Board's own cap is not consulted.
  const claimed = await underClaimLock(async () => {
    if (await sweptSince(board.id, windowOpened)) return null;
    const settings = await getSettings();
    if ((await activeCount()) >= settings.globalMaxConcurrentSessions) return null;
    // A sweep has no Card to pick up again, so it gets the half of the fallback that helps it: don't
    // start on a Provider that is known to be out of usage when the other one is not.
    const chosen = providerForDispatch({ enabled: settings.providerFallback, preferred: board.provider, limits, nowMs: Date.now() });
    const sessionId = newId();
    await db.insert(schema.sessions).values({
      id: sessionId,
      boardId: board.id,
      cardId: null,
      kind: "sweep",
      provider: chosen.provider,
      fallbackFrom: chosen.switched ? board.provider : null,
      status: "queued",
      intent: "Nightly hygiene sweep.",
      tokenHash: createHash("sha256").update(token).digest("hex"),
    });
    return { sessionId, chosen, wallClockMinutes: settings.sessionWallClockMinutes };
  });
  if (!claimed) return;
  const { sessionId, chosen, wallClockMinutes } = claimed;
  await recordEvent({ boardId: board.id, actor: SYSTEM_ACTOR, type: "session.queued", payload: { sessionId, kind: "sweep" } });
  const prompt = `You are running the nightly hygiene sweep for the "${board.name}" board in kardboard. Read the ledger and the board. For every card, check that its column matches its state: Blocked cards wait on a human, Ready cards are triaged and unclaimed, In Progress cards have an active session or an open branch, Review cards have a pull request and preview, Done cards are merged or closed. Move cards that drifted, explaining each move in a one-line comment. For cards that have sat in Blocked for 14 days with no human reply, post one reminder mentioning the card's author. Do not open pull requests or change code. Finish with a one-sentence summary.${board.promptAppend ? `\n\nBoard-specific instructions from the Admin:\n${board.promptAppend}` : ""}`;
  await startSession(sessionId, wallClockMinutes, async () => ({ sessionId, boardSlug: board.slug, provider: chosen.provider, model: chosen.switched ? null : board.model, reasoning: board.reasoning, image: board.agentImage, repoUrl: null, branch: null, token, wallClockMinutes, prompt, githubToken: null, gitName: "kardboard", gitEmail: "kardboard@users.noreply.github.com" }));
}
