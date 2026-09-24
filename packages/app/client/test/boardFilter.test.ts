import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Card } from "@kardboard/shared";
import { filterActive, foldDone, matchesFilter, matchesQuery, NO_FILTER, readFilter, waitsOn, writeFilter, type BoardFilter } from "../src/routes/board/boardFilter.js";

let n = 0;
function card(over: Partial<Card> = {}): Card {
  n += 1;
  return {
    id: `c${n}xk29fq0`,
    boardId: "b",
    title: `Card ${n}`,
    description: "",
    priority: "none",
    column: "inbox",
    position: n * 1000,
    creatorKind: "user",
    creatorId: "ada",
    parentCardId: null,
    outcome: null,
    revision: 0,
    branch: null,
    prUrl: null,
    prNumber: null,
    prHeadSha: null,
    prBaseRef: null,
    checks: null,
    previewUrl: null,
    preview: null,
    commentCount: 0,
    activeSession: null,
    lastSession: null,
    waiting: null,
    pendingRerun: false,
    awaitingReply: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

const ada = { id: "ada", isAdmin: false };
const grace = { id: "grace", isAdmin: false };
const root = { id: "root", isAdmin: true };
const filter = (over: Partial<BoardFilter>): BoardFilter => ({ ...NO_FILTER, ...over });

describe("the filter in the URL", () => {
  it("reads what it wrote, and drops what it does not know", () => {
    const f: BoardFilter = { q: "login page", mine: true, needsMe: true, priority: "high" };
    assert.deepEqual(readFilter(writeFilter(f, new URLSearchParams())), f);
    assert.deepEqual(readFilter(new URLSearchParams("priority=urgent&mine=yes")), NO_FILTER);
  });

  it("keeps other parameters and removes cleared filters", () => {
    const params = writeFilter(filter({ q: "x", mine: true }), new URLSearchParams("tab=2"));
    assert.equal(params.get("tab"), "2");
    const cleared = writeFilter(NO_FILTER, params);
    assert.equal(cleared.toString(), "tab=2");
  });

  it("is active only when something narrows the board", () => {
    assert.equal(filterActive(NO_FILTER), false);
    assert.equal(filterActive(filter({ q: "   " })), false);
    assert.equal(filterActive(filter({ q: "a" })), true);
    assert.equal(filterActive(filter({ priority: "none" })), true);
  });
});

describe("search", () => {
  it("matches every word against the title and details, ignoring case", () => {
    const c = card({ title: "Login page crashes", description: "On **Safari** only" });
    assert.equal(matchesQuery(c, "login SAFARI"), true);
    assert.equal(matchesQuery(c, "login chrome"), false);
    assert.equal(matchesQuery(c, ""), true);
  });

  it("finds a card by the start of its id, with or without #", () => {
    const c = card({ id: "k7f3q2abcdef" });
    assert.equal(matchesQuery(c, "k7f3q2"), true);
    assert.equal(matchesQuery(c, "#K7F3"), true);
    assert.equal(matchesQuery(c, "f3q2"), false);
  });
});

describe("waiting on the viewer", () => {
  it("counts a question on the viewer's own card, and every question for the Admin", () => {
    const question = card({ column: "blocked", awaitingReply: true, creatorId: "ada" });
    assert.equal(waitsOn(question, ada), true);
    assert.equal(waitsOn(question, grace), false);
    assert.equal(waitsOn(question, root), true);
  });

  it("does not count a Blocked card nobody has been asked about", () => {
    assert.equal(waitsOn(card({ column: "blocked", awaitingReply: false }), ada), false);
  });

  it("counts a card in Review for anyone, unless a Session is still at work on it", () => {
    assert.equal(waitsOn(card({ column: "review", creatorId: "someone" }), grace), true);
    const busy = card({ column: "review", activeSession: { id: "s", kind: "card", status: "running", provider: "claude", fallbackFrom: null, intent: null, branch: null, cardId: null, startedAt: null, endedAt: null, outcomeSummary: null, createdAt: "" } });
    assert.equal(waitsOn(busy, grace), false);
  });
});

describe("matchesFilter", () => {
  it("combines every filter", () => {
    const mineHigh = card({ title: "Fix checkout", priority: "high", creatorId: "ada" });
    const theirsHigh = card({ title: "Fix checkout", priority: "high", creatorId: "grace" });
    const mineLow = card({ title: "Fix checkout", priority: "low", creatorId: "ada" });
    const f = filter({ q: "checkout", mine: true, priority: "high" });
    assert.deepEqual([mineHigh, theirsHigh, mineLow].filter((c) => matchesFilter(c, f, ada)), [mineHigh]);
  });

  it("never counts a card the Agent created as mine", () => {
    assert.equal(matchesFilter(card({ creatorKind: "agent", creatorId: null }), filter({ mine: true }), ada), false);
  });
});

describe("foldDone", () => {
  it("shows the most recently finished cards in their board order", () => {
    const cards = Array.from({ length: 13 }, (_, i) => card({ column: "done", updatedAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }));
    const { shown, hidden } = foldDone(cards, 10);
    assert.equal(hidden, 3);
    assert.deepEqual(
      shown.map((c) => c.id),
      cards.slice(3).map((c) => c.id),
    );
  });

  it("leaves a short column alone", () => {
    const cards = [card(), card()];
    assert.deepEqual(foldDone(cards, 10), { shown: cards, hidden: 0 });
  });
});
