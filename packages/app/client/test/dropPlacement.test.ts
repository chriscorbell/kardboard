import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dropPlacement } from "../src/routes/board/dropPlacement.js";

const column = [
  { id: "a", position: 1000 },
  { id: "b", position: 2000 },
  { id: "c", position: 3000 },
];

// The order the column shows once the card sits at its new position.
function orderAfter(target: typeof column, activeId: string, overId: string | null): string[] | null {
  const placed = dropPlacement(target, activeId, overId);
  if (!placed) return null;
  const moved = { id: activeId, position: placed.position };
  return [...target.filter((c) => c.id !== activeId), moved].sort((x, y) => x.position - y.position).map((c) => c.id);
}

describe("dropPlacement within a column", () => {
  it("moves a card down exactly one slot", () => {
    assert.deepEqual(orderAfter(column, "a", "b"), ["b", "a", "c"]);
  });

  it("moves a card up exactly one slot", () => {
    assert.deepEqual(orderAfter(column, "c", "b"), ["a", "c", "b"]);
  });

  it("moves a card to either end", () => {
    assert.deepEqual(orderAfter(column, "a", "c"), ["b", "c", "a"]);
    assert.deepEqual(orderAfter(column, "c", "a"), ["c", "a", "b"]);
  });

  it("moves a card to the end when dropped on the column", () => {
    assert.deepEqual(orderAfter(column, "a", null), ["b", "c", "a"]);
  });

  it("does nothing when dropped on itself, or on the column while already last", () => {
    assert.equal(dropPlacement(column, "b", "b"), null);
    assert.equal(dropPlacement(column, "c", null), null);
  });
});

describe("dropPlacement across columns", () => {
  it("puts the card before the one it was dropped on", () => {
    assert.deepEqual(orderAfter(column, "x", "b"), ["a", "x", "b", "c"]);
    assert.deepEqual(orderAfter(column, "x", "a"), ["x", "a", "b", "c"]);
  });

  it("appends when dropped on the column, and starts an empty one at 1000", () => {
    assert.deepEqual(dropPlacement(column, "x", null), { index: 3, position: 4000 });
    assert.deepEqual(dropPlacement([], "x", null), { index: 0, position: 1000 });
  });
});
