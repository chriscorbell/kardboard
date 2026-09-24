import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { PROVIDERS, slugifyBranch, type Card, type Provider, type SessionStatus, type SessionSummary, type TriggerKind } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { newId } from "../ids.js";
import { publish } from "./realtime.js";
import { recordEvent, SYSTEM_ACTOR, type Actor } from "./events.js";
import { getSettings } from "./settings.js";
import { runner } from "./runner-client.js";
import { buildSessionPrompt } from "./prompt.js";
import { botIdentity, githubConfigured, mintInstallationToken, parseRepoUrl } from "./github.js";
import { providerAfterFailure, providerForDispatch } from "./fallback.js";
import { readProviderLimits } from "./provider-limits.js";
import { removePreviewForCard } from "./previews.js";
import { byDispatchOrder } from "./children.js";

const ACTIVE = ["queued", "starting", "running"] as const;

const coalesceTimers = new Map<string, NodeJS.Timeout>();
const wallClockTimers = new Map<string, NodeJS.Timeout>();

function summary(row: typeof schema.sessions.$inferSelect): SessionSummary {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    provider: row.provider,
    fallbackFrom: row.fallbackFrom,
    intent: row.intent,
    branch: row.branch,
    cardId: row.cardId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    outcomeSummary: row.outcomeSummary,
    createdAt: row.createdAt,
  };
}

async function activeSessionForCard(cardId: string) {
  return db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.cardId, cardId), inArray(schema.sessions.status, [...ACTIVE])))
    .get();
}

async function activeCount(boardId?: string): Promise<number> {
  const where = boardId
    ? and(eq(schema.sessions.boardId, boardId), inArray(schema.sessions.status, [...ACTIVE]))
    : inArray(schema.sessions.status, [...ACTIVE]);
  const row = await db.select({ n: sql<number>`count(*)` }).from(schema.sessions).where(where).get();
  return Number(row?.n ?? 0);
}

function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/** The Provider a `provider_fallback` Trigger in this batch asks for, if one is there. */
function fallbackTarget(pending: (typeof schema.triggers.$inferSelect)[]): Provider | null {
  const trigger = pending.find((t) => t.kind === "provider_fallback");
  const to = trigger?.payload.to;
  return isProvider(to) ? to : null;
}

async function publishCard(cardId: string) {
  // Lazy import to avoid a cycle with cards.ts.
  const { getCard } = await import("./cards.js");
  const card = await getCard(cardId);
  if (card) publish(card.boardId, { type: "card.upserted", card });
}

export async function enqueueTrigger(input: {
  card: Card;
  kind: TriggerKind;
  actorUserId: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  await db.insert(schema.triggers).values({
    id: newId(),
    boardId: input.card.boardId,
    cardId: input.card.id,
    kind: input.kind,
    actorUserId: input.actorUserId,
    payload: input.payload,
  });
  const active = await activeSessionForCard(input.card.id);
  if (active) {
    await db.update(schema.cards).set({ pendingRerun: true }).where(eq(schema.cards.id, input.card.id));
    await publishCard(input.card.id);
    return;
  }
  scheduleDispatch(input.card.id, env.triggerCoalesceMs);
}

export function scheduleDispatch(cardId: string, delayMs: number): void {
  const existing = coalesceTimers.get(cardId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    coalesceTimers.delete(cardId);
    void dispatch(cardId).catch((err) => console.error("[orchestrator] dispatch failed", err));
  }, delayMs);
  // A waiting dispatch is a Trigger row before it is a timer, so this one need not hold the process
  // open: whatever it would have started, `recoverOnBoot` starts after a restart.
  t.unref();
  coalesceTimers.set(cardId, t);
}

/**
 * A Session ended, so a slot may have opened. Cards waiting for one are taken in the Board's own
 * reading order rather than whichever retry timer happens to fire first: a split request creates
 * its children at once, and they should start in the order a person would have started them.
 */
async function pumpWaiting(): Promise<void> {
  const rows = await db
    .select({
      id: schema.cards.id,
      priority: schema.cards.priority,
      position: schema.cards.position,
      createdAt: schema.cards.createdAt,
    })
    .from(schema.triggers)
    .innerJoin(schema.cards, eq(schema.triggers.cardId, schema.cards.id))
    .where(eq(schema.triggers.status, "pending"));
  const waiting = [...new Map(rows.map((r) => [r.id, r])).values()].sort(byDispatchOrder);
  for (const card of waiting) {
    if (await activeSessionForCard(card.id)) continue;
    // `dispatch` re-checks the caps; one Card per freed slot, and the next end pumps again.
    scheduleDispatch(card.id, 250);
    return;
  }
}

async function dispatch(cardId: string): Promise<void> {
  const card = await db.select().from(schema.cards).where(eq(schema.cards.id, cardId)).get();
  if (!card) return;
  const pending = await db
    .select()
    .from(schema.triggers)
    .where(and(eq(schema.triggers.cardId, cardId), eq(schema.triggers.status, "pending")));
  if (pending.length === 0) return;
  if (await activeSessionForCard(cardId)) {
    await db.update(schema.cards).set({ pendingRerun: true }).where(eq(schema.cards.id, cardId));
    return;
  }
  const board = (await db.select().from(schema.boards).where(eq(schema.boards.id, card.boardId)).get())!;
  const settings = await getSettings();
  if ((await activeCount(board.id)) >= board.maxConcurrentSessions || (await activeCount()) >= settings.globalMaxConcurrentSessions) {
    // The retry is the safety net; `pumpWaiting` is what usually picks this Card up, in order,
    // the moment a Session ends.
    scheduleDispatch(cardId, 30_000);
    return;
  }

  // Which Provider this run uses. A fallback Trigger names one outright; otherwise the Board's
  // Provider, unless it is out of usage and the other is not.
  const limits = await readProviderLimits();
  const requested = fallbackTarget(pending);
  const chosen = requested
    ? { provider: requested, switched: requested !== board.provider }
    : providerForDispatch({ enabled: settings.providerFallback, preferred: board.provider, limits, nowMs: Date.now() });

  // Claim: the Session row is the Claim. One active Session per Card is enforced by activeSessionForCard above.
  const sessionId = newId();
  const token = randomBytes(32).toString("base64url");
  const branch = card.branch ?? slugifyBranch(card.id, card.title);
  await db.insert(schema.sessions).values({
    id: sessionId,
    boardId: board.id,
    cardId: card.id,
    kind: "card",
    provider: chosen.provider,
    fallbackFrom: chosen.switched ? board.provider : null,
    status: "queued",
    branch,
    tokenHash: createHash("sha256").update(token).digest("hex"),
  });
  if (chosen.switched) {
    await recordEvent({
      boardId: board.id,
      cardId: card.id,
      actor: SYSTEM_ACTOR,
      type: "session.provider_fallback",
      payload: { sessionId, from: board.provider, to: chosen.provider },
    });
  }
  await db
    .update(schema.triggers)
    .set({ status: "consumed", sessionId })
    .where(inArray(schema.triggers.id, pending.map((p) => p.id)));
  await db.update(schema.cards).set({ pendingRerun: false, branch }).where(eq(schema.cards.id, cardId));
  await recordEvent({ boardId: board.id, cardId: card.id, actor: SYSTEM_ACTOR, type: "session.queued", payload: { sessionId, triggers: pending.map((p) => p.kind) } });
  await publishSession(sessionId);
  await publishCard(cardId);

  try {
    const prompt = await buildSessionPrompt({ board, card, sessionId, triggers: pending });
    const repo = parseRepoUrl(board.repoUrl);
    let githubToken: string | null = null;
    if (repo && githubConfigured("sessions")) {
      githubToken = (await mintInstallationToken("sessions", repo.owner, repo.repo)).token;
    } else if (repo) {
      console.warn(`[orchestrator] GitHub sessions app not configured; session ${sessionId} clones ${board.repoUrl} anonymously`);
    }
    const bot = botIdentity("sessions");
    const { containerId } = await runner.start({
      sessionId,
      boardSlug: board.slug,
      provider: chosen.provider,
      // A Board's model names one Provider's model and means nothing to the other, so a run on the
      // other Provider takes its default. Reasoning levels are kardboard's own vocabulary and carry.
      model: chosen.switched ? null : board.model,
      reasoning: board.reasoning,
      image: board.agentImage,
      repoUrl: board.repoUrl,
      branch,
      token,
      wallClockMinutes: settings.sessionWallClockMinutes,
      prompt,
      githubToken,
      gitName: bot.name,
      gitEmail: bot.email,
    });
    await db
      .update(schema.sessions)
      .set({ status: "running", containerId, startedAt: new Date().toISOString(), intent: runner.mode === "noop" ? "No runner configured. Session recorded only." : null })
      .where(eq(schema.sessions.id, sessionId));
    await recordEvent({ boardId: board.id, cardId: card.id, actor: SYSTEM_ACTOR, type: "session.started", payload: { sessionId } });
    await publishSession(sessionId);
    await publishCard(cardId);
    armWallClock(sessionId, settings.sessionWallClockMinutes);
    if (runner.mode === "noop") {
      setTimeout(() => void endSession(sessionId, "succeeded", "Runner not configured; nothing ran."), 20_000);
    }
  } catch (err) {
    await endSession(sessionId, "failed", `Could not start: ${(err as Error).message}`);
  }
}

function armWallClock(sessionId: string, minutes: number) {
  const t = setTimeout(() => void endSession(sessionId, "timed_out", `Exceeded the ${minutes}-minute wall clock.`), minutes * 60_000);
  wallClockTimers.set(sessionId, t);
}

async function publishSession(sessionId: string) {
  const row = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (row) publish(row.boardId, { type: "session.updated", session: summary(row) });
}

export async function endSession(
  sessionId: string,
  status: "succeeded" | "failed" | "cancelled" | "timed_out",
  outcomeSummary: string | null,
  opts: { rerun?: boolean } = {},
): Promise<void> {
  const row = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!row || !(ACTIVE as readonly string[]).includes(row.status)) return;
  const wt = wallClockTimers.get(sessionId);
  if (wt) clearTimeout(wt);
  wallClockTimers.delete(sessionId);
  if (row.containerId && (status === "cancelled" || status === "timed_out")) {
    await runner.stop(row.containerId).catch((err) => console.error("[orchestrator] stop failed", err));
  }
  await db
    .update(schema.sessions)
    .set({ status, outcomeSummary, endedAt: new Date().toISOString() })
    .where(eq(schema.sessions.id, sessionId));
  await recordEvent({ boardId: row.boardId, cardId: row.cardId, actor: SYSTEM_ACTOR, type: `session.${status}`, payload: { sessionId, outcomeSummary } });
  await publishSession(sessionId);
  if (row.cardId) {
    // A Session the Provider refused for want of usage is picked up again on the other Provider.
    // The Trigger carries that decision, so it survives a restart between here and the dispatch,
    // and the next Session is told in its prompt why it was started.
    const fallbackTo = opts.rerun === undefined ? await planFallback(row, status) : null;
    if (fallbackTo) {
      await db.insert(schema.triggers).values({
        id: newId(),
        boardId: row.boardId,
        cardId: row.cardId,
        kind: "provider_fallback" satisfies TriggerKind,
        actorUserId: null,
        payload: { from: row.provider, to: fallbackTo, sessionId },
      });
      await recordEvent({
        boardId: row.boardId,
        cardId: row.cardId,
        actor: SYSTEM_ACTOR,
        type: "session.provider_fallback",
        payload: { sessionId, from: row.provider, to: fallbackTo },
      });
    }
    const card = await db.select().from(schema.cards).where(eq(schema.cards.id, row.cardId)).get();
    const shouldRerun = opts.rerun ?? (fallbackTo !== null || (card?.pendingRerun && status !== "cancelled"));
    if (!shouldRerun && card?.pendingRerun) {
      await db.update(schema.cards).set({ pendingRerun: false }).where(eq(schema.cards.id, row.cardId));
    }
    await publishCard(row.cardId);
    if (shouldRerun) scheduleDispatch(row.cardId, 1_000);
  }
  await pumpWaiting().catch((err) => console.error("[orchestrator] pump failed", err));
}

/** Whether this ended Session should be picked up again on the other Provider, and which that is. */
async function planFallback(row: typeof schema.sessions.$inferSelect, status: SessionStatus): Promise<Provider | null> {
  if (status !== "failed") return null;
  const settings = await getSettings();
  if (!settings.providerFallback) return null;
  return providerAfterFailure({
    enabled: true,
    status,
    provider: row.provider,
    fallbackFrom: row.fallbackFrom,
    // A Session that never started still made no provider call, but one refused in the seconds
    // before its row was stamped is the same outage; `createdAt` is the honest lower bound.
    since: row.startedAt ?? row.createdAt,
    limits: await readProviderLimits(),
    nowMs: Date.now(),
  });
}

// Human closure: cancel the Claim holder, drop queued Triggers, and clear the re-run flag. A
// runner-hosted Preview is torn down with the Card; nothing reviews a closed Card's deployment.
export async function closeCardWork(cardId: string, actor: Actor): Promise<void> {
  await removePreviewForCard(cardId).catch((err) => console.error("[preview] could not remove on close", err));
  const t = coalesceTimers.get(cardId);
  if (t) clearTimeout(t);
  coalesceTimers.delete(cardId);
  await db.update(schema.triggers).set({ status: "consumed" }).where(and(eq(schema.triggers.cardId, cardId), eq(schema.triggers.status, "pending")));
  await db.update(schema.cards).set({ pendingRerun: false }).where(eq(schema.cards.id, cardId));
  const active = await activeSessionForCard(cardId);
  if (active) {
    await endSession(active.id, "cancelled", actor.kind === "agent" ? "The card's pull request was merged." : "The card was moved to Done by a person.", { rerun: false });
    await recordEvent({ boardId: active.boardId, cardId, actor, type: "session.cancel_requested", payload: { sessionId: active.id, reason: "closed" } });
  }
}

export async function cancelSession(sessionId: string, actor: Actor, rerun: boolean): Promise<void> {
  await endSession(sessionId, "cancelled", rerun ? "Cancelled by the Admin; re-running." : "Cancelled by the Admin.", { rerun });
  const row = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (row) await recordEvent({ boardId: row.boardId, cardId: row.cardId, actor, type: "session.cancel_requested", payload: { sessionId, rerun } });
}

export async function findSessionByToken(token: string) {
  const hash = createHash("sha256").update(token).digest("hex");
  return db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.tokenHash, hash), inArray(schema.sessions.status, [...ACTIVE])))
    .get();
}

export async function listBoardSessions(boardId: string, limit = 50): Promise<SessionSummary[]> {
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.boardId, boardId))
    .orderBy(sql`${schema.sessions.createdAt} desc`)
    .limit(limit);
  return rows.map(summary);
}

export async function getSession(sessionId: string): Promise<SessionSummary | null> {
  const row = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  return row ? summary(row) : null;
}

export async function listAllSessions(limit = 100): Promise<(SessionSummary & { boardId: string })[]> {
  const rows = await db.select().from(schema.sessions).orderBy(sql`${schema.sessions.createdAt} desc`).limit(limit);
  return rows.map((r) => ({ ...summary(r), boardId: r.boardId }));
}

// Called once at boot: anything that was active when the process died is reconciled here.
export async function recoverOnBoot(): Promise<void> {
  // Reconcile recorded Sessions against the runner's container inventory. A Session whose
  // container is still running keeps its Claim and gets a fresh wall clock; one whose container
  // is gone ended while the app was down, and its exit was never reported.
  if (runner.mode !== "noop") {
    const active = await db.select().from(schema.sessions).where(inArray(schema.sessions.status, [...ACTIVE]));
    if (active.length > 0) {
      const settings = await getSettings();
      let inventory: Awaited<ReturnType<typeof runner.inventory>> | null = null;
      try {
        inventory = await runner.inventory();
      } catch (err) {
        console.error("[orchestrator] runner inventory unavailable at boot; leaving sessions as they are", err);
      }
      if (inventory) {
        for (const s of active) {
          const item = inventory.find((i) => i.sessionId === s.id);
          if (item && item.state === "running") {
            const elapsedMin = s.startedAt ? (Date.now() - new Date(s.startedAt).getTime()) / 60_000 : 0;
            armWallClock(s.id, Math.max(1, settings.sessionWallClockMinutes - elapsedMin));
          } else {
            await endSession(s.id, "failed", "The app restarted and the session's container was gone; its exit was not reported.");
          }
        }
      }
    }
  }
  const pending = await db
    .selectDistinct({ cardId: schema.triggers.cardId })
    .from(schema.triggers)
    .where(eq(schema.triggers.status, "pending"));
  for (const p of pending) scheduleDispatch(p.cardId, 5_000);
}
