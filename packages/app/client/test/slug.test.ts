import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { slugDraft, slugify } from "../src/routes/admin/slug.js";

describe("slugDraft", () => {
  it("keeps a hyphen typed at the end, so the next word can follow it", () => {
    assert.equal(slugDraft("my-"), "my-");
    assert.equal(slugDraft("my-b"), "my-b");
  });

  it("drops a leading hyphen and folds runs of other characters", () => {
    assert.equal(slugDraft("  Acme  Web"), "acme-web");
    assert.equal(slugDraft("-x"), "x");
  });
});

describe("slugify", () => {
  it("builds the whole slug from a name, not just its first letter", () => {
    assert.equal(slugify("Acme Web App"), "acme-web-app");
  });

  it("strips hyphens at either end", () => {
    assert.equal(slugify("-acme-web-"), "acme-web");
  });

  it("caps the length at 48", () => {
    assert.equal(slugify("a".repeat(60)).length, 48);
  });
});
