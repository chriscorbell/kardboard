import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COLUMNS } from "@kardboard/shared";
import { columnHint } from "../src/routes/board/columns.js";

describe("an empty column's hint", () => {
  it("names the Agent as the Admin named it on a Board with sessions", () => {
    assert.equal(columnHint("inbox", "Milo", true), "New requests. Milo picks these up within a minute.");
  });

  it("promises nothing moves by itself on a Board without them", () => {
    for (const column of COLUMNS) {
      const hint = columnHint(column, "Milo", false);
      assert.doesNotMatch(hint, /Milo|session|Approve/i, `${column}: ${hint}`);
    }
  });
});
