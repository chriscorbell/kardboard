import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PROVIDERS, slugifyBranch, type Card, type Provider, type SessionStatus, type SessionSummary, type TriggerKind } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { newId } from "../ids.js";
import { publish } from "./realtime.js";
import { recordEvent, SYSTEM_ACTOR, type Actor } from "./events.js";
import { getSettings } from "./settings.js";
import { runner, type RunnerInventoryItem, type StartSessionRequest } from "./runner-client.js";
import { buildSessionPrompt } from "./prompt.js";
import { botIdentity, githubConfigured, mintInstallationToken, parseRepoUrl } from "./github.js";
import { providerAfterFailure, providerForDispatch } from "./fallback.js";
import { readProviderLimits, type LimitSnapshot } from "./provider-limits.js";
import { removePreviewForCard } from "./previews.js";
import { byDispatchOrder } from "./children.js";

const ACTIVE = ["queued", "starting", "running"] as const;

// The wait before each retry of something the runner could not do: starting a Session, or listing
// its containers at boot. Doubling from ten seconds outlasts a routine Watchtower restart of the
// runner. Tests shorten the base.
const BACKOFF_BASE_MS = Number(process.env.KARDBOARD_BACKOFF_BASE_MS ?? "10000");
const backoff = (retry: number) => BACKOFF_BASE_MS * 2 ** retry;
// The design's limit: a start that fails is tried twice more before its Session is failed.
const START_RETRIES = 2;
// About five minutes of asking before the boot reconciliation gives up on the runner.
const INVENTORY_ATTEMPTS = 6;

const coalesceTimers = new Map<string, NodeJS.Timeout>();
const wallClockTimers = new Map<string, NodeJS.Timeout>();

let claimQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` alone among everything that decides from what is active whether a Session may start or
 * end. The one-Session-per-Card rule and both caps are a read followed by a write, and two dispatches
 * that both read before either writes both pass. ADR 0004 makes this process the database's only
 * writer, so a queue in memory is enough to make that read and write one step. A libsql transaction
 * would not do it here: it holds the write lock across every await inside it, and every other write
 * in the process fails with SQLITE_BUSY until it commits. Nothing slow runs under this.
 */
export function underClaimLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = claimQueue.then(fn);
  claimQueue = run.catch(() => undefined);
  return run;
}

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

// A Board's cap counts its card Sessions only. A sweep counts against the global cap alone, so a
// long sweep never keeps a Board's Cards waiting.
export async function activeCount(boardId?: string): Promise<number> {
  const where = boardId
    ? and(eq(schema.sessions.boardId, boardId), eq(schema.sessions.kind, "card"), inArray(schema.sessions.status, [...ACTIVE]))
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
async function pumpWaiting(skipCardId: string | null = null): Promise<void> {
  const rows = await db
    .select({
      id: schema.cards.id,
      priority: schema.cards.priority,
      position: schema.cards.position,
      createdAt: schema.cards.createdAt,
      triggeredAt: schema.triggers.createdAt,
    })
    .from(schema.triggers)
    .innerJoin(schema.cards, eq(schema.triggers.cardId, schema.cards.id))
    .where(eq(schema.triggers.status, "pending"));
  // One entry per Card, carrying its newest pending Trigger.
  const newest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const seen = newest.get(r.id);
    if (!seen || r.triggeredAt > seen.triggeredAt) newest.set(r.id, r);
  }
  const windowStart = new Date(Date.now() - env.triggerCoalesceMs).toISOString();
  for (const card of [...newest.values()].sort(byDispatchOrder)) {
    if (card.id === skipCardId) continue;
    // Still collecting its batch: its own timer dispatches it when the window closes, and taking it
    // now would start a Session on half of what the person is still writing.
    if (card.triggeredAt > windowStart) continue;
    if (await activeSessionForCard(card.id)) continue;
    // `dispatch` re-checks the caps; one Card per freed slot, and the next end pumps again.
    scheduleDispatch(card.id, 250);
    return;
  }
}

async function dispatch(cardId: string): Promise<void> {
  // Read before the claim lock: the egress proxy can take seconds to answer, and nothing it says
  // decides whether this Card may start, only which Provider it starts on.
  const limits = await readProviderLimits();
  const claim = await underClaimLock(() => claimCard(cardId, limits));
  if (!claim) return;
  const { board, card, pending, settings, sessionId, token, branch, chosen } = claim;

  if (chosen.switched) {
    await recordEvent({
      boardId: board.id,
      cardId: card.id,
      actor: SYSTEM_ACTOR,
      type: "session.provider_fallback",
      payload: { sessionId, from: board.provider, to: chosen.provider },
    });
  }
  await recordEvent({ boardId: board.id, cardId: card.id, actor: SYSTEM_ACTOR, type: "session.queued", payload: { sessionId, triggers: pending.map((p) => p.kind) } });
  await publishSession(sessionId);
  await publishCard(cardId);

  await startSession(sessionId, settings.sessionWallClockMinutes, async () => {
    const prompt = await buildSessionPrompt({ board, card, sessionId, triggers: pending });
    const repo = parseRepoUrl(board.repoUrl);
    let githubToken: string | null = null;
    if (repo && githubConfigured("sessions")) {
      githubToken = (await mintInstallationToken("sessions", repo.owner, repo.repo)).token;
    } else if (repo) {
      console.warn(`[orchestrator] GitHub sessions app not configured; session ${sessionId} clones ${board.repoUrl} anonymously`);
    }
    const bot = botIdentity("sessions");
    return {
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
    };
  });
}

/**
 * Takes the Claim on a Card when it may start now: it has pending Triggers, no Session holds it, and
 * both caps have room. Runs under the claim lock. The Session row, the Triggers it consumes, and the
 * Card's cleared re-run flag are written in one batch, which libsql runs as a single transaction, so
 * a crash cannot leave a Claim that consumed nothing or Triggers consumed by no Session.
 */
async function claimCard(cardId: string, limits: LimitSnapshot) {
  const card = await db.select().from(schema.cards).where(eq(schema.cards.id, cardId)).get();
  if (!card) return null;
  const pending = await db
    .select()
    .from(schema.triggers)
    .where(and(eq(schema.triggers.cardId, cardId), eq(schema.triggers.status, "pending")));
  if (pending.length === 0) return null;
  if (await activeSessionForCard(cardId)) {
    await db.update(schema.cards).set({ pendingRerun: true }).where(eq(schema.cards.id, cardId));
    return null;
  }
  const board = (await db.select().from(schema.boards).where(eq(schema.boards.id, card.boardId)).get())!;
  const settings = await getSettings();
  if ((await activeCount(board.id)) >= board.maxConcurrentSessions || (await activeCount()) >= settings.globalMaxConcurrentSessions) {
    // The retry is the safety net; `pumpWaiting` is what usually picks this Card up, in order,
    // the moment a Session ends.
    scheduleDispatch(cardId, 30_000);
    return null;
  }

  // Which Provider this run uses. A fallback Trigger names one outright; otherwise the Board's
  // Provider, unless it is out of usage and the other is not.
  const requested = fallbackTarget(pending);
  const chosen = requested
    ? { provider: requested, switched: requested !== board.provider }
    : providerForDispatch({ enabled: settings.providerFallback, preferred: board.provider, limits, nowMs: Date.now() });

  const sessionId = newId();
  const token = randomBytes(32).toString("base64url");
  const branch = card.branch ?? slugifyBranch(card.id, card.title);
  await db.batch([
    db.insert(schema.sessions).values({
      id: sessionId,
      boardId: board.id,
      cardId: card.id,
      kind: "card",
      provider: chosen.provider,
      fallbackFrom: chosen.switched ? board.provider : null,
      status: "queued",
      branch,
      tokenHash: createHash("sha256").update(token).digest("hex"),
    }),
    db
      .update(schema.triggers)
      .set({ status: "consumed", sessionId })
      .where(inArray(schema.triggers.id, pending.map((p) => p.id))),
    db.update(schema.cards).set({ pendingRerun: false, branch }).where(eq(schema.cards.id, cardId)),
  ]);
  return { board, card, pending, settings, sessionId, token, branch, chosen };
}

/**
 * Asks the runner for a queued Session's container. A start that fails is tried twice more with a
 * growing wait, since the usual cause is a runner that Watchtower is restarting. The runner creates
 * containers idempotently by Session ID, so a retry after a lost response finds the first container
 * rather than making a second, and the request is rebuilt each time so it carries a fresh GitHub
 * token. After the last failure the Session is failed and its Triggers go back to pending: the
 * request is still owed, and the Card's next dispatch takes them up.
 */
export async function startSession(sessionId: string, wallClockMinutes: number, request: () => Promise<StartSessionRequest>): Promise<void> {
  let lastError = new Error("never attempted");
  for (let attempt = 0; attempt <= START_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoff(attempt - 1), undefined, { ref: false });
    // Cancelled, closed, or timed out while it waited: nothing is left to start.
    const current = await db
      .update(schema.sessions)
      .set({ status: "starting" })
      .where(and(eq(schema.sessions.id, sessionId), inArray(schema.sessions.status, ["queued", "starting"])))
      .returning({ id: schema.sessions.id })
      .get();
    if (!current) return;
    if (attempt === 0) await publishSession(sessionId);
    let containerId: string;
    try {
      ({ containerId } = await runner.start(await request()));
    } catch (err) {
      lastError = err as Error;
      console.warn(`[orchestrator] session ${sessionId} did not start (attempt ${attempt + 1} of ${START_RETRIES + 1}): ${lastError.message}`);
      continue;
    }
    await markRunning(sessionId, containerId, wallClockMinutes);
    return;
  }
  await endSession(sessionId, "failed", `Could not start: ${lastError.message}`, { requeue: true });
}

async function markRunning(sessionId: string, containerId: string, wallClockMinutes: number): Promise<void> {
  const row = await db
    .update(schema.sessions)
    .set({ status: "running", containerId, startedAt: new Date().toISOString(), ...(runner.mode === "noop" ? { intent: "No runner configured. Session recorded only." } : {}) })
    .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.status, "starting")))
    .returning()
    .get();
  if (!row) {
    // It ended while the runner was starting it, and nothing else knows this container exists.
    await runner.stop(containerId).catch((err) => console.error("[orchestrator] stop failed", err));
    return;
  }
  await recordEvent({ boardId: row.boardId, cardId: row.cardId, actor: SYSTEM_ACTOR, type: "session.started", payload: { sessionId } });
  await publishSession(sessionId);
  if (row.cardId) await publishCard(row.cardId);
  armWallClock(sessionId, wallClockMinutes);
  if (runner.mode === "noop") {
    setTimeout(() => void endSession(sessionId, "succeeded", "Runner not configured; nothing ran."), 20_000);
  }
}

function armWallClock(sessionId: string, minutes: number, delayMs = minutes * 60_000) {
  const existing = wallClockTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => void endSession(sessionId, "timed_out", `Exceeded the ${minutes}-minute wall clock.`), delayMs);
  // Like a dispatch timer, this need not hold the process open: `recoverOnBoot` arms it again.
  t.unref();
  wallClockTimers.set(sessionId, t);
}

async function publishSession(sessionId: string) {
  const row = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (row) publish(row.boardId, { type: "session.updated", session: summary(row) });
}

/**
 * Moves an active Session to a terminal state, releasing its Claim. `rerun` overrides whether the
 * Card starts again; `requeue` returns the Triggers the Session consumed to pending, for a Session
 * that never ran and so handled none of them.
 */
export async function endSession(
  sessionId: string,
  status: "succeeded" | "failed" | "cancelled" | "timed_out",
  outcomeSummary: string | null,
  opts: { rerun?: boolean; requeue?: boolean } = {},
): Promise<void> {
  // The end is claimed before anything slow. Stopping a container takes up to ten seconds, and the
  // runner reports the container's exit the moment it stops; whichever caller moves the row out of
  // an active state first ends the Session, and the other finds nothing to do. What that caller does
  // to the Card's Triggers happens under the same lock, so no dispatch can slip in between.
  const row = await underClaimLock(async () => {
    const ended = await db
      .update(schema.sessions)
      .set({ status, outcomeSummary, endedAt: new Date().toISOString() })
      .where(and(eq(schema.sessions.id, sessionId), inArray(schema.sessions.status, [...ACTIVE])))
      .returning()
      .get();
    if (!ended?.cardId) return ended;
    if (status === "cancelled" && opts.rerun === false) {
      // Cancelling without a re-run clears the pending re-run, and the pending re-run is these
      // Triggers: left pending, the next Session to end anywhere would start the Card again.
      const t = coalesceTimers.get(ended.cardId);
      if (t) clearTimeout(t);
      coalesceTimers.delete(ended.cardId);
      await db
        .update(schema.triggers)
        .set({ status: "consumed" })
        .where(and(eq(schema.triggers.cardId, ended.cardId), eq(schema.triggers.status, "pending")));
    }
    if (opts.requeue) {
      await db.update(schema.triggers).set({ status: "pending", sessionId: null }).where(eq(schema.triggers.sessionId, sessionId));
    }
    return ended;
  });
  if (!row) return;
  const wt = wallClockTimers.get(sessionId);
  if (wt) clearTimeout(wt);
  wallClockTimers.delete(sessionId);
  // The Session's MCP token stopped working with the status change above, so a container still
  // shutting down here can no longer act on the Board.
  if (row.containerId && (status === "cancelled" || status === "timed_out")) {
    await runner.stop(row.containerId).catch((err) => console.error("[orchestrator] stop failed", err));
  }
  await recordEvent({ boardId: row.boardId, cardId: row.cardId, actor: SYSTEM_ACTOR, type: `session.${status}`, payload: { sessionId, outcomeSummary } });
  await publishSession(sessionId);
  let rerunning = false;
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
    rerunning = opts.rerun ?? (fallbackTo !== null || (card?.pendingRerun === true && status !== "cancelled"));
    if (!rerunning && card?.pendingRerun) {
      await db.update(schema.cards).set({ pendingRerun: false }).where(eq(schema.cards.id, row.cardId));
    }
    await publishCard(row.cardId);
    if (rerunning) scheduleDispatch(row.cardId, 1_000);
  }
  // The slot this Session freed goes to its own Card's re-run when there is one. Otherwise the
  // longest-waiting Card takes it, but not the Card of a Session that could not start: it would only
  // fail the same way at once, and its Triggers wait for the next dispatch instead.
  if (!rerunning) await pumpWaiting(opts.requeue ? row.cardId : null).catch((err) => console.error("[orchestrator] pump failed", err));
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
  // Under the claim lock, so a dispatch that has already read these Triggers cannot start a Session
  // on the closed Card after they were dropped.
  const active = await underClaimLock(async () => {
    await db.update(schema.triggers).set({ status: "consumed" }).where(and(eq(schema.triggers.cardId, cardId), eq(schema.triggers.status, "pending")));
    await db.update(schema.cards).set({ pendingRerun: false }).where(eq(schema.cards.id, cardId));
    return activeSessionForCard(cardId);
  });
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
  const active = await db.select().from(schema.sessions).where(inArray(schema.sessions.status, [...ACTIVE]));
  if (active.length > 0) {
    // Every Session left active gets its wall clock back first, measured from when it started, or
    // from when it was queued if it never did. Whatever the runner says or fails to say below, no
    // Claim outlives it.
    const { sessionWallClockMinutes } = await getSettings();
    for (const s of active) {
      const elapsedMs = Date.now() - new Date(s.startedAt ?? s.createdAt).getTime();
      armWallClock(s.id, sessionWallClockMinutes, Math.max(0, sessionWallClockMinutes * 60_000 - elapsedMs));
    }
    // Not awaited: Watchtower often restarts the runner alongside the app, and the app should serve
    // while it waits for it.
    if (runner.mode !== "noop") {
      void reconcileWithRunner(active.map((s) => s.id)).catch((err) => console.error("[orchestrator] reconcile failed", err));
    }
  }
  const pending = await db
    .selectDistinct({ cardId: schema.triggers.cardId })
    .from(schema.triggers)
    .where(eq(schema.triggers.status, "pending"));
  for (const p of pending) scheduleDispatch(p.cardId, 5_000);
}

/**
 * Settles the Sessions that were active at boot against the runner's containers. Only those are
 * looked at, so a Session dispatched since boot and still starting is never taken for a lost one.
 * A running container keeps its Session's Claim. An exited one is left to the runner, which reports
 * its exit code like any other. A container that is gone took its outcome with it: a Session that
 * was running is failed, since its exit was never reported, and one that never got a container gives
 * its Triggers back and its Card is dispatched again.
 */
async function reconcileWithRunner(sessionIds: string[]): Promise<void> {
  const inventory = await inventoryWithRetries();
  if (!inventory) {
    console.error("[orchestrator] runner inventory unavailable; sessions from before the restart are left to their wall clocks and the runner's exit reports");
    return;
  }
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(and(inArray(schema.sessions.id, sessionIds), inArray(schema.sessions.status, [...ACTIVE])));
  for (const s of rows) {
    const item = inventory.find((i) => i.sessionId === s.id);
    if (item?.state === "running") {
      if (s.status !== "running") {
        // The runner started it, but the app went down before recording so. A cancel needs the
        // container id to stop it.
        await db
          .update(schema.sessions)
          .set({ status: "running", containerId: item.containerId, startedAt: s.startedAt ?? new Date().toISOString() })
          .where(and(eq(schema.sessions.id, s.id), inArray(schema.sessions.status, ["queued", "starting"])));
        await publishSession(s.id);
      }
      continue;
    }
    if (item?.state === "exited" || item?.state === "dead") continue;
    if (s.status === "running") {
      await endSession(s.id, "failed", "The app restarted and the session's container was gone; its exit was not reported.");
      continue;
    }
    if (item) await runner.stop(item.containerId).catch((err) => console.error("[orchestrator] stop failed", err));
    await endSession(s.id, "failed", "The app restarted before the session's container started.", { requeue: true });
    if (s.cardId) scheduleDispatch(s.cardId, 5_000);
  }
}

async function inventoryWithRetries(): Promise<RunnerInventoryItem[] | null> {
  for (let attempt = 0; attempt < INVENTORY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(backoff(attempt - 1), undefined, { ref: false });
    try {
      return await runner.inventory();
    } catch (err) {
      console.warn(`[orchestrator] runner inventory failed (attempt ${attempt + 1} of ${INVENTORY_ATTEMPTS}): ${(err as Error).message}`);
    }
  }
  return null;
}
