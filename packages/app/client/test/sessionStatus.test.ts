import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionSummary } from "@kardboard/shared";
import { agentPill, sessionBanner, stoppedReason, tileWaiting, transcriptHref, waitingMessage } from "../src/routes/board/sessionStatus.js";

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s1",
    kind: "card",
    status: "running",
    provider: "claude",
    fallbackFrom: null,
    intent: null,
    branch: null,
    cardId: "c1",
    startedAt: "2026-09-24T10:00:00.000Z",
    endedAt: null,
    outcomeSummary: null,
    createdAt: "2026-09-24T10:00:00.000Z",
    ...over,
  };
}

const idle = { activeSession: null, waiting: null, lastSession: null, column: "ready" as const, pendingRerun: false, updatedAt: "2026-09-24T10:00:00.000Z" };
const failed = session({ status: "failed", endedAt: "2026-09-24T10:30:00.000Z", outcomeSummary: "It ran out of memory." });

describe("the card sheet's session banner", () => {
  it("shows the session at work above anything else", () => {
    const active = session();
    assert.deepEqual(sessionBanner({ ...idle, activeSession: active, lastSession: failed }), { kind: "active", session: active });
  });

  it("shows what the card is waiting for before an earlier failure", () => {
    const waiting = { reason: "slot" as const, since: "2026-09-24T10:31:00.000Z" };
    assert.deepEqual(sessionBanner({ ...idle, waiting, lastSession: failed }), { kind: "waiting", ...waiting });
  });

  it("offers Try again after a run that failed or ran out of time", () => {
    assert.deepEqual(sessionBanner({ ...idle, lastSession: failed }), { kind: "stopped", session: failed });
    const timedOut = session({ status: "timed_out" });
    assert.equal(sessionBanner({ ...idle, lastSession: timedOut })?.kind, "stopped");
  });

  it("says nothing after a run that finished or was cancelled, or on a card in done", () => {
    assert.equal(sessionBanner({ ...idle, lastSession: session({ status: "succeeded" }) }), null);
    assert.equal(sessionBanner({ ...idle, lastSession: session({ status: "cancelled" }) }), null);
    assert.equal(sessionBanner({ ...idle, column: "done", lastSession: failed }), null);
    assert.equal(sessionBanner(idle), null);
  });
});

describe("the words for a wait", () => {
  it("names the agent where it is the one waiting", () => {
    assert.equal(waitingMessage("coalescing", "Milo").title, "Milo will pick this up shortly");
    assert.equal(waitingMessage("paused", "Milo").title, "Paused by the Admin");
    assert.match(waitingMessage("slot", "Milo").detail ?? "", /Milo starts/);
  });

  it("puts the same words on a tile, and nothing while a session works", () => {
    const waiting = { reason: "retrying" as const, since: "2026-09-24T10:31:00.000Z" };
    assert.deepEqual(tileWaiting({ activeSession: null, waiting }, "Milo"), { reason: "retrying", label: "Milo could not start" });
    assert.equal(tileWaiting({ activeSession: session(), waiting }, "Milo"), null);
  });
});

describe("why a run stopped", () => {
  it("uses the recorded outcome", () => {
    assert.equal(stoppedReason(failed), "It ran out of memory.");
  });

  it("keeps the runner's error for a start that failed to the Admin", () => {
    assert.equal(stoppedReason(session({ status: "failed", startedAt: null, outcomeSummary: "Could not start: connect ECONNREFUSED" })), "It could not start.");
  });

  it("fills in a missing outcome", () => {
    assert.equal(stoppedReason(session({ status: "timed_out", outcomeSummary: null })), "It ran out of time.");
    assert.equal(stoppedReason(session({ status: "failed", outcomeSummary: " " })), "It stopped unexpectedly.");
  });

  it("links the admin to the transcript", () => {
    assert.equal(transcriptHref("abc123"), "/admin/sessions?session=abc123");
  });
});

describe("the agent pill", () => {
  it("says the agent is paused, even while sessions finish", () => {
    assert.deepEqual(agentPill({ agentName: "Milo", paused: true, working: 0 }), { tone: "paused", label: "Milo is paused on this board", short: "Milo is paused" });
    assert.equal(agentPill({ agentName: "Milo", paused: true, working: 2 }).label, "Milo is paused on this board, finishing 2 cards");
  });

  it("counts the cards at work, or says the agent is idle", () => {
    assert.deepEqual(agentPill({ agentName: "Milo", paused: false, working: 1 }), { tone: "working", label: "Milo is working on 1 card", short: "Working on 1 card" });
    assert.deepEqual(agentPill({ agentName: "Milo", paused: false, working: 0 }), { tone: "idle", label: "Milo is idle", short: "Milo is idle" });
  });
});
