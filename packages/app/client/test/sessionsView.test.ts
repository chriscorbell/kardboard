import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminSessionSummary, ProviderStatus, SessionUsage } from "@kardboard/shared";
import {
  filterFromParams,
  formatCost,
  formatDuration,
  formatTokens,
  isFiltered,
  linkedOutsideList,
  NO_FILTER,
  paramsWithFilter,
  sessionDurationMs,
  usageBreakdown,
  usageSummary,
} from "../src/routes/admin/sessionsView.js";
import { formatWait, providerState } from "../src/routes/admin/providerState.js";

describe("the Sessions tab's filters", () => {
  it("reads known values from the address and ignores the rest", () => {
    assert.deepEqual(filterFromParams(new URLSearchParams("board=b1&status=failed&kind=sweep")), { board: "b1", status: "failed", kind: "sweep" });
    assert.deepEqual(filterFromParams(new URLSearchParams("status=active")), { board: "", status: "active", kind: "" });
    assert.deepEqual(filterFromParams(new URLSearchParams("status=exploded&kind=job")), NO_FILTER);
  });

  it("writes filters into the address without dropping the open Session", () => {
    const next = paramsWithFilter(new URLSearchParams("session=s1&status=failed"), { board: "b1", status: "", kind: "card" });
    assert.equal(next.get("session"), "s1");
    assert.equal(next.get("board"), "b1");
    assert.equal(next.has("status"), false);
    assert.equal(next.get("kind"), "card");
    assert.equal(isFiltered(filterFromParams(next)), true);
    assert.equal(isFiltered(NO_FILTER), false);
  });
});

describe("how long a run took", () => {
  const now = Date.parse("2026-09-24T12:10:00.000Z");

  it("counts from start to end, or to now while it runs, and is unknown before it starts", () => {
    assert.equal(sessionDurationMs({ startedAt: "2026-09-24T12:00:00.000Z", endedAt: "2026-09-24T12:03:05.000Z" }, now), 185_000);
    assert.equal(sessionDurationMs({ startedAt: "2026-09-24T12:00:00.000Z", endedAt: null }, now), 600_000);
    assert.equal(sessionDurationMs({ startedAt: null, endedAt: "2026-09-24T12:03:05.000Z" }, now), null);
  });

  it("reads in seconds, minutes, or hours", () => {
    assert.equal(formatDuration(42_000), "42s");
    assert.equal(formatDuration(185_000), "3m 05s");
    assert.equal(formatDuration(3_725_000), "1h 02m");
  });
});

describe("how usage reads", () => {
  const usage: SessionUsage = { inputTokens: 1_241, outputTokens: 9_884, cacheReadTokens: 1_204_775, cacheCreationTokens: 51_210, costUsd: 1.8432, numTurns: 23, durationMs: 184_233 };

  it("rounds token counts to what a glance needs", () => {
    assert.equal(formatTokens(980), "980");
    assert.equal(formatTokens(1_241), "1.2k");
    assert.equal(formatTokens(9_884), "9.9k");
    assert.equal(formatTokens(51_210), "51k");
    assert.equal(formatTokens(1_267_110), "1.3M");
    assert.equal(formatTokens(12_000_000), "12M");
  });

  it("shows cost to the cent, and a sliver as less than one", () => {
    assert.equal(formatCost(1.8432), "$1.84");
    assert.equal(formatCost(0.004), "<$0.01");
    assert.equal(formatCost(0), "$0");
  });

  it("sums a run into one line, with the breakdown for a tooltip", () => {
    assert.equal(usageSummary(usage), "23 turns · 1.3M tokens · $1.84");
    assert.equal(usageSummary({ ...usage, numTurns: null, costUsd: null }), "1.3M tokens");
    assert.equal(usageBreakdown(usage), "1.2k input, 9.9k output, 1.2M cache read, 51k cache write");
  });
});

describe("a Session linked by id", () => {
  const session = (id: string) => ({ id }) as AdminSessionSummary;

  it("is shown in its place when it is on a loaded page, and on its own otherwise", () => {
    const list = [session("a"), session("b")];
    assert.equal(linkedOutsideList(list, session("b")), null);
    assert.equal(linkedOutsideList(list, session("old"))?.id, "old");
    assert.equal(linkedOutsideList(list, undefined), null);
  });
});

describe("a Provider's status", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const base: ProviderStatus = { provider: "claude", credentialLoaded: true, limit: null, authFailure: null };

  it("is available with nothing against it, or with a usage window that has passed", () => {
    assert.equal(providerState(base, now).label, "Available");
    assert.equal(providerState({ ...base, limit: { at: "2026-09-24T10:00:00.000Z", until: "2026-09-24T11:00:00.000Z" } }, now).tone, "ok");
    assert.equal(providerState({ ...base, limit: { at: "2026-09-24T11:59:00.000Z", until: null } }, now).tone, "ok", "a refusal that named no window is not a closed window");
  });

  it("is out of usage until the window it named reopens", () => {
    const state = providerState({ ...base, limit: { at: "2026-09-24T11:30:00.000Z", until: "2026-09-24T13:05:00.000Z" } }, now);
    assert.deepEqual([state.tone, state.label, state.reopensAt, state.reopensIn], ["warn", "Out of usage", "2026-09-24T13:05:00.000Z", "in 1h 05m"]);
  });

  it("puts a rejected credential ahead of a usage window, and a missing one ahead of both", () => {
    const failing = { ...base, authFailure: { at: "2026-09-24T11:58:00.000Z", status: 401, reason: "POST /v1/messages answered 401" }, limit: { at: "2026-09-24T11:30:00.000Z", until: "2026-09-24T13:05:00.000Z" } };
    assert.deepEqual([providerState(failing, now).tone, providerState(failing, now).label], ["danger", "Credential rejected"]);
    assert.equal(providerState({ ...failing, credentialLoaded: false }, now).label, "No credential");
    assert.equal(providerState({ ...base, credentialLoaded: null }, now).label, "Available", "an older proxy that does not say is not a missing credential");
  });

  it("reads a wait to the minute", () => {
    assert.equal(formatWait(20_000), "in about a minute");
    assert.equal(formatWait(42 * 60_000), "in 42m");
    assert.equal(formatWait(125 * 60_000), "in 2h 05m");
  });
});
