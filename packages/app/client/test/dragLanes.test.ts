import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dropSpot, laneOf, moveAcross, placeBefore, settleWithin, type Lanes } from "../src/routes/board/dragLanes.js";

const lanes = (over: Partial<Lanes> = {}): Lanes => ({ inbox: [], blocked: [], ready: ["a", "b", "c"], in_progress: ["x", "y"], review: [], done: [], ...over });

describe("a card dragged across columns", () => {
  it("opens a gap before the card the pointer is over", () => {
    const moved = moveAcross(lanes(), "a", "y", false)!;
    assert.deepEqual(moved.ready, ["b", "c"]);
    assert.deepEqual(moved.in_progress, ["x", "a", "y"]);
  });

  it("opens it after that card once the pointer is past its middle", () => {
    assert.deepEqual(moveAcross(lanes(), "a", "y", true)!.in_progress, ["x", "y", "a"]);
  });

  it("goes last when over the column itself, empty or not", () => {
    assert.deepEqual(moveAcross(lanes(), "a", "col:review", false)!.review, ["a"]);
    assert.deepEqual(moveAcross(lanes(), "a", "col:in_progress", false)!.in_progress, ["x", "y", "a"]);
  });

  it("leaves a move within its own column to sorting", () => {
    assert.equal(moveAcross(lanes(), "a", "c", false), null);
    assert.equal(moveAcross(lanes(), "a", "col:ready", false), null);
  });
});

describe("the drop", () => {
  it("within a column takes the index of the card it is over", () => {
    assert.deepEqual(settleWithin(lanes(), "a", "c").ready, ["b", "c", "a"]);
    assert.deepEqual(settleWithin(lanes(), "c", "a").ready, ["c", "a", "b"]);
  });

  it("names the column and the card the dragged one now precedes", () => {
    assert.deepEqual(dropSpot(moveAcross(lanes(), "a", "y", false)!, "a"), { column: "in_progress", beforeId: "y" });
    assert.deepEqual(dropSpot(lanes(), "c"), { column: "ready", beforeId: null });
    assert.equal(laneOf(lanes(), "col:done"), "done");
  });
});

describe("placeBefore", () => {
  const column = [
    { id: "a", position: 1000 },
    { id: "b", position: 2000 },
    { id: "c", position: 3000 },
  ];
  const order = (activeId: string, beforeId: string | null) => {
    const moved = { id: activeId, position: placeBefore(column, activeId, beforeId) };
    return [...column.filter((c) => c.id !== activeId), moved].sort((x, y) => x.position - y.position).map((c) => c.id);
  };

  it("puts the card just before the named one, whichever way it moves", () => {
    assert.deepEqual(order("a", "c"), ["b", "a", "c"]);
    assert.deepEqual(order("c", "a"), ["c", "a", "b"]);
  });

  it("puts it last when nothing follows it", () => {
    assert.deepEqual(order("a", null), ["b", "c", "a"]);
  });

  it("counts cards the view hides, so the position cannot land on one of theirs", () => {
    // `h` is hidden between b and c; a card dropped before c goes after h, not onto it.
    const withHidden = [...column.slice(0, 2), { id: "h", position: 2500 }, column[2]!];
    const position = placeBefore(withHidden, "new", "c");
    assert.ok(position > 2500 && position < 3000);
  });

  it("starts an empty column", () => {
    assert.equal(placeBefore([], "a", null), 1000);
  });
});
