import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";
import { recordEvent, SYSTEM_ACTOR } from "./events.js";
import { runner } from "./runner-client.js";
import { getSettings } from "./settings.js";
import { endSession } from "./orchestrator.js";
import { publish } from "./realtime.js";
import { providerForDispatch } from "./fallback.js";
import { readProviderLimits } from "./provider-limits.js";

const SWEEP_HOUR = Number(process.env.KARDBOARD_SWEEP_HOUR ?? "3");
const WAIT_LIMIT_MS = 60 * 60_000;
const ACTIVE = ["queued", "starting", "running"] as const;

// Nightly hygiene sweep: one sweep Session per Board at SWEEP_HOUR local time. It waits up to an
// hour for card Sessions on that Board to finish, then runs regardless. Counts against the global
// cap only. Nothing runs in noop mode.
export function startSweepScheduler(): void {
  if (runner.mode === "noop") return;
  setInterval(() => void tick().catch((err) => console.error("[sweep] tick failed", err)), 60_000);
}

const started = new Map<string, string>(); // boardId -> YYYY-MM-DD of the last sweep started

async function tick(): Promise<void> {
  const now = new Date();
  if (now.getHours() < SWEEP_HOUR || now.getHours() >= SWEEP_HOUR + 2) return;
  const today = now.toISOString().slice(0, 10);
  const boards = await db.select().from(schema.boards);
  for (const board of boards) {
    if (started.get(board.id) === today) continue;
    const busy = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.boardId, board.id), eq(schema.sessions.kind, "card"), inArray(schema.sessions.status, [...ACTIVE])))
      .get();
    const waitedMs = now.getTime() - new Date(`${today}T${String(SWEEP_HOUR).padStart(2, "0")}:00:00`).getTime();
    if (Number(busy?.n ?? 0) > 0 && waitedMs < WAIT_LIMIT_MS) continue;
    const settings = await getSettings();
    const globalActive = await db.select({ n: sql<number>`count(*)` }).from(schema.sessions).where(inArray(schema.sessions.status, [...ACTIVE])).get();
    if (Number(globalActive?.n ?? 0) >= settings.globalMaxConcurrentSessions) continue;
    started.set(board.id, today);
    await startSweep(board, settings.sessionWallClockMinutes, settings.providerFallback);
  }
}

async function startSweep(board: typeof schema.boards.$inferSelect, wallClockMinutes: number, providerFallback: boolean): Promise<void> {
  const sessionId = newId();
  const token = randomBytes(32).toString("base64url");
  // A sweep has no Card to pick up again, so it gets the half of the fallback that helps it: don't
  // start on a Provider that is known to be out of usage when the other one is not.
  const chosen = providerForDispatch({ enabled: providerFallback, preferred: board.provider, limits: await readProviderLimits(), nowMs: Date.now() });
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
  await recordEvent({ boardId: board.id, actor: SYSTEM_ACTOR, type: "session.queued", payload: { sessionId, kind: "sweep" } });
  const prompt = `You are running the nightly hygiene sweep for the "${board.name}" board in kardboard. Read the ledger and the board. For every card, check that its column matches its state: Blocked cards wait on a human, Ready cards are triaged and unclaimed, In Progress cards have an active session or an open branch, Review cards have a pull request and preview, Done cards are merged or closed. Move cards that drifted, explaining each move in a one-line comment. For cards that have sat in Blocked for 14 days with no human reply, post one reminder mentioning the card's author. Do not open pull requests or change code. Finish with a one-sentence summary.${board.promptAppend ? `\n\nBoard-specific instructions from the Admin:\n${board.promptAppend}` : ""}`;
  try {
    const { containerId } = await runner.start({ sessionId, boardSlug: board.slug, provider: chosen.provider, model: chosen.switched ? null : board.model, reasoning: board.reasoning, image: board.agentImage, repoUrl: null, branch: null, token, wallClockMinutes, prompt, githubToken: null, gitName: "kardboard", gitEmail: "kardboard@users.noreply.github.com" });
    await db.update(schema.sessions).set({ status: "running", containerId, startedAt: new Date().toISOString() }).where(eq(schema.sessions.id, sessionId));
    const row = (await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get())!;
    publish(board.id, { type: "session.updated", session: { id: row.id, kind: row.kind, status: row.status, provider: row.provider, fallbackFrom: row.fallbackFrom, intent: row.intent, branch: row.branch, cardId: row.cardId, startedAt: row.startedAt, endedAt: row.endedAt, outcomeSummary: row.outcomeSummary, createdAt: row.createdAt } });
    setTimeout(() => void endSession(sessionId, "timed_out", `Exceeded the ${wallClockMinutes}-minute wall clock.`), wallClockMinutes * 60_000);
  } catch (err) {
    await endSession(sessionId, "failed", `Could not start: ${(err as Error).message}`);
  }
}
