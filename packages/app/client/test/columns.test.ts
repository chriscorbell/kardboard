import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COLUMNS } from "@kardboard/shared";
import { columnHint } from "../src/routes/board/columns.js";

describe("an empty column's hint", () => {
  it("promises nothing moves by itself", () => {
    for (const column of COLUMNS) {
      const hint = columnHint(column);
      assert.doesNotMatch(hint, /Milo|session|Approve|preview/i, `${column}: ${hint}`);
    }
  });
});
