import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { batchClosesAt, coalesceDelay, couldNotStart, inStartBackoff, START_BACKOFF_MS, waitingState } from "../src/services/waiting.js";
import { NO_REPORT, outcomeOfExit, stoppedNotice } from "../src/services/session-outcome.js";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60_000;

describe("when a Card's batch closes", () => {
  const timing = { windowMs: MINUTE, capMs: 3 * MINUTE };

  it("is a window after the newest Trigger while the person is still writing", () => {
    assert.equal(batchClosesAt({ oldestMs: NOW - 30_000, newestMs: NOW, ...timing }), NOW + MINUTE);
  });

  it("is never later than the cap after the oldest Trigger, however much keeps arriving", () => {
    assert.equal(batchClosesAt({ oldestMs: NOW - 150_000, newestMs: NOW, ...timing }), NOW + 30_000);
    assert.equal(coalesceDelay({ nowMs: NOW, oldestPendingAt: iso(-150_000), ...timing }), 30_000);
    assert.equal(coalesceDelay({ nowMs: NOW, oldestPendingAt: iso(-10 * MINUTE), ...timing }), 0, "long overdue: at once");
  });

  it("is the plain window for a Card with nothing else waiting", () => {
    assert.equal(coalesceDelay({ nowMs: NOW, oldestPendingAt: iso(0), ...timing }), MINUTE);
    assert.equal(coalesceDelay({ nowMs: NOW, oldestPendingAt: null, ...timing }), MINUTE);
  });

  it("keeps the whole window when the cap is set shorter than it", () => {
    assert.equal(coalesceDelay({ nowMs: NOW, oldestPendingAt: iso(-30_000), windowMs: 5 * MINUTE, capMs: MINUTE }), 5 * MINUTE - 30_000);
  });
});

describe("the backoff after a failed start", () => {
  const failedToStart = (endedAgoMs: number) => ({ status: "failed" as const, startedAt: null, endedAt: iso(-endedAgoMs) });

  it("holds a Card whose last Session could not start a moment ago", () => {
    assert.equal(inStartBackoff(failedToStart(MINUTE), NOW), true);
  });

  it("lets it go once the backoff has passed", () => {
    assert.equal(inStartBackoff(failedToStart(START_BACKOFF_MS + 1), NOW), false);
  });

  it("does not hold a Card whose last Session ran, however it ended", () => {
    assert.equal(inStartBackoff({ status: "failed", startedAt: iso(-2 * MINUTE), endedAt: iso(-MINUTE) }, NOW), false);
    assert.equal(inStartBackoff({ status: "cancelled", startedAt: null, endedAt: iso(-MINUTE) }, NOW), false);
    assert.equal(inStartBackoff(null, NOW), false);
  });
});

describe("what a Card is waiting for", () => {
  const base = { oldestPendingAt: iso(-10_000), active: false, paused: false, slotsFull: false, dispatchPlanned: true, lastSession: null };

  it("is nothing without a pending Trigger, or while a Session holds the Card", () => {
    assert.equal(waitingState({ ...base, oldestPendingAt: null }), null);
    assert.equal(waitingState({ ...base, active: true }), null);
  });

  it("is its batching window by default, dated from the oldest Trigger", () => {
    assert.deepEqual(waitingState(base), { reason: "coalescing", since: iso(-10_000) });
  });

  it("is a free slot when the caps are full", () => {
    assert.equal(waitingState({ ...base, slotsFull: true })?.reason, "slot");
  });

  it("is the Admin when the Board is paused, whatever else holds it", () => {
    assert.equal(waitingState({ ...base, paused: true, slotsFull: true })?.reason, "paused");
  });

  it("is a retry after a start that failed, until something plans a dispatch", () => {
    const lastSession = { status: "failed" as const, startedAt: null, endedAt: iso(-MINUTE) };
    assert.equal(waitingState({ ...base, dispatchPlanned: false, lastSession })?.reason, "retrying");
    assert.equal(waitingState({ ...base, dispatchPlanned: true, lastSession })?.reason, "coalescing", "a person's new change is dispatched as usual");
    assert.equal(couldNotStart({ status: "timed_out", startedAt: null, endedAt: null }), false);
  });
});

describe("reading a container's exit", () => {
  it("says a container that hit its memory limit ran out of memory", () => {
    assert.deepEqual(outcomeOfExit({ exitCode: 137, oomKilled: true }, true), { status: "failed", summary: "It ran out of memory." });
  });

  it("names the code of any other failure, which the Admin can look up", () => {
    assert.deepEqual(outcomeOfExit({ exitCode: 1 }, true), { status: "failed", summary: "It stopped unexpectedly (exit code 1)." });
    assert.deepEqual(outcomeOfExit({ exitCode: 137, oomKilled: false }, true), { status: "failed", summary: "It stopped unexpectedly (exit code 137)." });
  });

  it("counts the entrypoint's own wall clock as running out of time", () => {
    assert.equal(outcomeOfExit({ exitCode: 124 }, true).status, "timed_out");
  });

  it("fails a clean exit that told the Card nothing, and passes one that commented", () => {
    assert.deepEqual(outcomeOfExit({ exitCode: 0 }, false), { status: "failed", summary: NO_REPORT });
    assert.equal(outcomeOfExit({ exitCode: 0 }, true).status, "succeeded");
  });
});

describe("the notice on a stopped Card", () => {
  it("says what happened in a sentence and offers Try again", () => {
    const n = stoppedNotice({ agentName: "Milo", reason: "It ran out of memory.", next: "retry" });
    assert.equal(n.comment, "**Milo stopped before finishing this card.** It ran out of memory.\n\nPress Try again to start over, or add a comment and Milo will pick the card up again.");
    assert.equal(n.title, "Milo stopped before finishing");
  });

  it("does not offer Try again on a Card in Done, where it is refused", () => {
    assert.doesNotMatch(stoppedNotice({ agentName: "Milo", reason: "x", next: "comment" }).comment, /Try again/);
  });

  it("finishes the agent's own summary as a sentence, and fills in a missing one", () => {
    assert.equal(stoppedNotice({ agentName: "Milo", reason: "Could not find the settings page", next: "rerun" }).reason, "Could not find the settings page.");
    assert.equal(stoppedNotice({ agentName: "Milo", reason: null, next: "retry" }).reason, "It stopped unexpectedly.");
  });
});
