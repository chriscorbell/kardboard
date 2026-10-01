import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bearerMatches } from "../src/auth.js";

describe("the runner token", () => {
  it("lets in the exact bearer header", () => {
    assert.equal(bearerMatches("Bearer s3cret-token", "s3cret-token"), true);
  });

  it("refuses anything else, whatever its length", () => {
    for (const header of [undefined, "", "Bearer ", "Bearer s3cret", "Bearer s3cret-token ", "Bearer s3cret-tokens", "bearer s3cret-token", "Basic s3cret-token", "s3cret-token"]) {
      assert.equal(bearerMatches(header, "s3cret-token"), false, String(header));
    }
  });

  it("refuses everything when there is no token to compare with", () => {
    assert.equal(bearerMatches("Bearer ", ""), false);
    assert.equal(bearerMatches(undefined, ""), false);
  });
});
