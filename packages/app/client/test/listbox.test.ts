import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { moveHighlight, placeList, typeahead } from "../src/lib/listbox.js";

describe("moving a dropdown's highlight", () => {
  it("steps with the arrows and stops at the ends", () => {
    assert.equal(moveHighlight("ArrowDown", 1, 4), 2);
    assert.equal(moveHighlight("ArrowDown", 3, 4), 3);
    assert.equal(moveHighlight("ArrowUp", 0, 4), 0);
  });

  it("jumps with Home, End, and the page keys", () => {
    assert.equal(moveHighlight("Home", 3, 4), 0);
    assert.equal(moveHighlight("End", 0, 4), 3);
    assert.equal(moveHighlight("PageDown", 0, 4), 3);
    assert.equal(moveHighlight("PageUp", 3, 4), 0);
  });

  it("ignores other keys, and an empty list", () => {
    assert.equal(moveHighlight("a", 0, 4), null);
    assert.equal(moveHighlight("ArrowDown", 0, 0), null);
  });
});

describe("typing to pick an option", () => {
  const labels = ["Any type", "Task", "Bug", "Feature", "Idea", "Chore"];

  it("finds the next label with that initial, ignoring case", () => {
    assert.equal(typeahead(labels, "b", 0), 2);
    assert.equal(typeahead(labels, "I", 0), 4);
  });

  it("moves on through labels sharing an initial when the letter is typed again", () => {
    const priorities = ["High", "Medium", "Low", "No priority", "None yet"];
    assert.equal(typeahead(priorities, "n", 1), 3);
    assert.equal(typeahead(priorities, "nn", 3), 4);
    assert.equal(typeahead(priorities, "nnn", 4), 3);
  });

  it("narrows to a longer prefix from where it is", () => {
    assert.equal(typeahead(["No priority", "None yet"], "non", 0), 1);
  });

  it("finds nothing for text no label starts with", () => {
    assert.equal(typeahead(labels, "z", 0), -1);
    assert.equal(typeahead(labels, "", 0), -1);
  });
});

describe("placing a dropdown list", () => {
  const viewport = { width: 1280, height: 800 };

  it("opens below its button, at least as wide as it", () => {
    const p = placeList({ top: 100, bottom: 136, left: 40, width: 200 }, { height: 180, width: 120 }, viewport);
    assert.deepEqual(p, { left: 40, top: 140, maxHeight: 180, minWidth: 200, up: false });
  });

  it("opens above when it does not fit below and there is more room above", () => {
    const p = placeList({ top: 700, bottom: 736, left: 40, width: 200 }, { height: 180, width: 200 }, viewport);
    assert.equal(p.up, true);
    assert.equal(p.bottom, 104);
    assert.equal(p.maxHeight, 180);
  });

  it("scrolls when taller than the room on either side", () => {
    const p = placeList({ top: 300, bottom: 336, left: 40, width: 200 }, { height: 1000, width: 200 }, viewport);
    assert.equal(p.up, false);
    assert.equal(p.maxHeight, 800 - 336 - 4 - 8);
  });

  it("stays inside the viewport's right edge", () => {
    const p = placeList({ top: 100, bottom: 136, left: 1200, width: 60 }, { height: 100, width: 160 }, viewport);
    assert.equal(p.left, 1280 - 8 - 160);
  });
});
