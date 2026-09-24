import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractMentionHandles } from "@kardboard/shared";

describe("mention handles", () => {
  it("does not take the punctuation that ends a sentence", () => {
    assert.deepEqual(extractMentionHandles("Thanks @chris. And @ada-l, too."), ["chris", "ada-l"]);
  });

  it("keeps dots and hyphens inside a handle", () => {
    assert.deepEqual(extractMentionHandles("cc @j.doe and @mary-ann"), ["j.doe", "mary-ann"]);
  });

  it("reads a one-letter handle and ignores an email address", () => {
    assert.deepEqual(extractMentionHandles("@a see hi@example.com"), ["a"]);
  });
});
