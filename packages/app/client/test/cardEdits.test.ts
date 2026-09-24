import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Card } from "@kardboard/shared";
import { resolveRefusedSave } from "../src/routes/board/cardEdits.js";

const loaded = { title: "Fix login", description: "It fails.", revision: 3, column: "ready" } as Card;

describe("resolveRefusedSave", () => {
  it("saves again on top when only another field changed, such as a move", () => {
    const latest = { ...loaded, column: "in_progress", revision: 4 } as Card;
    assert.deepEqual(resolveRefusedSave("description", { revision: 3, value: "It fails." }, latest), { retryAt: 4 });
  });

  it("reports a conflict when someone else changed the same field", () => {
    const latest = { ...loaded, description: "It fails on Safari.", revision: 4 } as Card;
    assert.deepEqual(resolveRefusedSave("description", { revision: 3, value: "It fails." }, latest), { conflict: latest });
  });

  it("compares the field being saved, not the whole card", () => {
    const latest = { ...loaded, title: "Fix sign-in", revision: 5 } as Card;
    assert.deepEqual(resolveRefusedSave("description", { revision: 3, value: "It fails." }, latest), { retryAt: 5 });
    assert.deepEqual(resolveRefusedSave("title", { revision: 3, value: "Fix login" }, latest), { conflict: latest });
  });

  it("gives up without the latest card to compare against", () => {
    assert.equal(resolveRefusedSave("title", { revision: 3, value: "Fix login" }, undefined), null);
  });
});
