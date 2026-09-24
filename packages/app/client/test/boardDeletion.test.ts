import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canDelete, deletionContents } from "../src/routes/admin/boardDeletion.js";

const EMPTY = { cards: 0, comments: 0, attachments: 0, previews: 0, activeSessions: 0 };

describe("what deleting a board takes", () => {
  it("lists what is there, singular or plural, and leaves out what is not", () => {
    assert.equal(deletionContents({ ...EMPTY, cards: 3, comments: 12, attachments: 1, previews: 2 }), "3 cards, 12 comments, 1 attachment and 2 previews");
    assert.equal(deletionContents({ ...EMPTY, cards: 1, comments: 1 }), "1 card and 1 comment");
    assert.equal(deletionContents({ ...EMPTY, cards: 4 }), "4 cards");
  });

  it("is nothing for an empty board", () => {
    assert.equal(deletionContents(EMPTY), null);
  });
});

describe("the delete button", () => {
  it("waits for the slug typed exactly, ignoring stray spaces", () => {
    assert.equal(canDelete(EMPTY, "lumen", "lumen"), true);
    assert.equal(canDelete(EMPTY, " lumen ", "lumen"), true);
    assert.equal(canDelete(EMPTY, "Lumen", "lumen"), false);
    assert.equal(canDelete(EMPTY, "lume", "lumen"), false);
  });

  it("stays off until the impact is known, and while a session runs", () => {
    assert.equal(canDelete(undefined, "lumen", "lumen"), false);
    assert.equal(canDelete({ ...EMPTY, activeSessions: 1 }, "lumen", "lumen"), false);
  });
});
