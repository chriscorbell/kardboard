import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canDeleteCard } from "../src/routes/board/cardDeletion.js";

describe("who is offered Delete on a card", () => {
  const byAda = { creatorKind: "user" as const, creatorId: "ada" };
  const byAgent = { creatorKind: "agent" as const, creatorId: null };

  it("offers it to the card's creator and to the Admin", () => {
    assert.equal(canDeleteCard(byAda, { id: "ada", isAdmin: false }), true);
    assert.equal(canDeleteCard(byAda, { id: "root", isAdmin: true }), true);
  });

  it("keeps it from another member, and the Agent's cards from members", () => {
    assert.equal(canDeleteCard(byAda, { id: "bea", isAdmin: false }), false);
    assert.equal(canDeleteCard(byAgent, { id: "ada", isAdmin: false }), false);
    assert.equal(canDeleteCard(byAgent, { id: "root", isAdmin: true }), true);
  });
});
