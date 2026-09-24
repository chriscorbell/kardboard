import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUsageLimit, resetAt, UsageLimits } from "../src/limits.js";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");

describe("recognising a usage refusal", () => {
  it("is 429 and nothing else", () => {
    assert.equal(isUsageLimit(429), true);
    assert.equal(isUsageLimit(200), false);
    assert.equal(isUsageLimit(401), false);
    assert.equal(isUsageLimit(529), false, "overloaded is not out of usage");
    assert.equal(isUsageLimit(undefined), false);
  });
});

describe("when the provider says the window reopens", () => {
  it("reads Anthropic's unified reset as unix seconds", () => {
    const at = resetAt({ "anthropic-ratelimit-unified-reset": String((NOW + 3_600_000) / 1000) }, NOW);
    assert.equal(at, "2026-09-15T13:00:00.000Z");
  });

  it("reads retry-after as delta-seconds", () => {
    assert.equal(resetAt({ "retry-after": "1800" }, NOW), "2026-09-15T12:30:00.000Z");
  });

  it("reads retry-after as an HTTP date", () => {
    assert.equal(resetAt({ "retry-after": "Tue, 15 Sep 2026 12:45:00 GMT" }, NOW), "2026-09-15T12:45:00.000Z");
  });

  it("prefers the unified reset and falls back to retry-after when it is unusable", () => {
    assert.equal(resetAt({ "anthropic-ratelimit-unified-reset": "later", "retry-after": "60" }, NOW), "2026-09-15T12:01:00.000Z");
  });

  it("says nothing when no header does", () => {
    assert.equal(resetAt({}, NOW), null);
    assert.equal(resetAt({ "retry-after": "soon" }, NOW), null);
  });

  it("refuses a window in the past or further out than a day, so a bad header cannot park a provider", () => {
    assert.equal(resetAt({ "retry-after": "0" }, NOW), null);
    assert.equal(resetAt({ "anthropic-ratelimit-unified-reset": "1" }, NOW), null);
    assert.equal(resetAt({ "retry-after": String(48 * 3600) }, NOW), null);
  });

  it("takes the first value when a header arrives more than once", () => {
    const repeated = [String((NOW + 600_000) / 1000), String((NOW + 900_000) / 1000)];
    assert.equal(resetAt({ "anthropic-ratelimit-unified-reset": repeated }, NOW), "2026-09-15T12:10:00.000Z");
  });
});

describe("what the proxy remembers", () => {
  it("starts with nothing seen for either provider", () => {
    assert.deepEqual(new UsageLimits().snapshot(), { claude: null, codex: null });
  });

  it("records one provider's refusal without touching the other", () => {
    const limits = new UsageLimits();
    limits.note("claude", { "retry-after": "60" }, NOW);
    assert.deepEqual(limits.snapshot(), {
      claude: { at: "2026-09-15T12:00:00.000Z", until: "2026-09-15T12:01:00.000Z" },
      codex: null,
    });
  });

  it("keeps the latest refusal, so a reopened window is not read off a stale one", () => {
    const limits = new UsageLimits();
    limits.note("codex", { "retry-after": "60" }, NOW);
    limits.note("codex", { "retry-after": "120" }, NOW + 60_000);
    assert.deepEqual(limits.snapshot().codex, { at: "2026-09-15T12:01:00.000Z", until: "2026-09-15T12:03:00.000Z" });
  });

  it("records a refusal that named no window, which still says the provider refused", () => {
    const limits = new UsageLimits();
    limits.note("claude", {}, NOW);
    assert.deepEqual(limits.snapshot().claude, { at: "2026-09-15T12:00:00.000Z", until: null });
  });
});

describe("what the proxy reports beyond usage", () => {
  it("keeps the latest rejected credential per provider until a turn is accepted again", () => {
    const limits = new UsageLimits();
    assert.deepEqual(limits.report(), { claude: null, codex: null, authFailures: { claude: null, codex: null }, refusals: { count: 0, last: null } });
    limits.noteAuthFailure("claude", 401, "POST /v1/messages answered 401", NOW);
    assert.deepEqual(limits.report().authFailures, { claude: { at: "2026-09-15T12:00:00.000Z", status: 401, reason: "POST /v1/messages answered 401" }, codex: null });
    limits.noteAccepted("codex");
    assert.equal(limits.report().authFailures.claude?.status, 401, "a turn on the other provider says nothing about this one");
    limits.noteAccepted("claude");
    assert.equal(limits.report().authFailures.claude, null);
  });

  it("counts refused calls and keeps the last, with its path clipped", () => {
    const limits = new UsageLimits();
    limits.noteRefused("codex", "GET", "/wham/usage", NOW);
    limits.noteRefused("claude", "POST", `/v1/${"x".repeat(400)}`, NOW + 1_000);
    const { refusals } = limits.report();
    assert.equal(refusals.count, 2);
    assert.equal(refusals.last?.provider, "claude");
    assert.equal(refusals.last?.path.length, 200);
    assert.equal(refusals.last?.at, "2026-09-15T12:00:01.000Z");
  });
});
