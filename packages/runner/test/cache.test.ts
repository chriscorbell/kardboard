import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CACHE_TARGET, cacheMounts, cacheVolumeName } from "../src/cache.js";

describe("a Board's dependency cache", () => {
  it("is one named volume per Board, mounted read-write at /cache", () => {
    const [mount, ...rest] = cacheMounts("k6u39mjgb5j2w8", "kardboard");
    assert.equal(rest.length, 0);
    assert.equal(mount?.Type, "volume");
    assert.equal(mount?.Source, "kardboard-cache-k6u39mjgb5j2w8");
    assert.equal(mount?.Target, CACHE_TARGET);
    assert.equal(mount?.ReadOnly, false);
  });

  it("is named by the Board's id, which a rename of its slug does not change", () => {
    assert.equal(cacheMounts("board1", "old-slug")[0]?.Source, cacheMounts("board1", "new-slug")[0]?.Source);
    assert.notEqual(cacheVolumeName("board1"), cacheVolumeName("board2"));
  });

  it("is seeded from the image, so a fresh volume belongs to the agent user, and is labelled for an Admin", () => {
    const options = cacheMounts("board1", "kardboard")[0]?.VolumeOptions;
    assert.equal(options?.NoCopy, false);
    assert.deepEqual(options?.Labels, { "kardboard.cache": "board1", "kardboard.board": "kardboard" });
  });

  it("is left out when the start request names no Board, as a sweep's does", () => {
    assert.deepEqual(cacheMounts(null, "kardboard"), []);
  });
});
