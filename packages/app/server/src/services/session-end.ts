import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { SYSTEM_ACTOR } from "./events.js";
import { endSession } from "./orchestrator.js";
import { getAgentProfile } from "./settings.js";
import { getCard } from "./cards.js";
import { createComment } from "./comments.js";
import { notifySessionFailed } from "./notifications.js";
import { outcomeOfExit, stoppedNotice, type ExitReport } from "./session-outcome.js";

/** Ends a Session whose container exited, as the runner reported it. */
export async function endSessionOnExit(sessionId: string, report: ExitReport): Promise<void> {
  const session = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!session) return;
  // `finish` ends the Session itself half a second after answering, and the container often exits
  // inside that half second. Its report is on record before it answers, so whichever end lands
  // first, the Session ends the way the agent said it did, and the other finds nothing to end.
  const reported = await reportedOutcome(session);
  if (reported) return endSession(sessionId, reported.outcome, reported.summary);
  const commented = session.kind === "sweep" || Boolean(await db.select({ id: schema.comments.id }).from(schema.comments).where(eq(schema.comments.sessionId, sessionId)).get());
  const { status, summary } = outcomeOfExit(report, commented);
  await endSession(sessionId, status, summary);
}

async function reportedOutcome(session: typeof schema.sessions.$inferSelect): Promise<{ outcome: "succeeded" | "failed"; summary: string } | null> {
  const row = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    // By Card when there is one, which the events table indexes; a sweep reports on its Board.
    .where(and(session.cardId ? eq(schema.events.cardId, session.cardId) : eq(schema.events.boardId, session.boardId), eq(schema.events.type, "session.reported"), sql`json_extract(${schema.events.payload}, '$.sessionId') = ${session.id}`))
    .orderBy(desc(schema.events.createdAt))
    .get();
  if (!row) return null;
  // A report recorded before `finish` carried its outcome was a success.
  return { outcome: row.payload.outcome === "failed" ? "failed" : "succeeded", summary: typeof row.payload.summary === "string" ? row.payload.summary : "" };
}

/**
 * Tells a Card's people that its Session failed or ran out of time: one Comment on the Card, and a
 * notification to its creator and the Admin. The Comment is posted as kardboard, which is never a
 * Trigger, so it cannot start the next Session by itself.
 */
export async function tellPeopleSessionStopped(input: { cardId: string; status: "failed" | "timed_out"; outcomeSummary: string | null; rerunning: boolean }): Promise<void> {
  const card = await getCard(input.cardId);
  if (!card) return;
  const agent = await getAgentProfile();
  const notice = stoppedNotice({ agentName: agent.name, reason: input.outcomeSummary, next: input.rerunning ? "rerun" : card.column === "done" ? "comment" : "retry" });
  await createComment({ cardId: card.id, body: notice.comment, actor: SYSTEM_ACTOR });
  await notifySessionFailed(card, notice, SYSTEM_ACTOR);
}
