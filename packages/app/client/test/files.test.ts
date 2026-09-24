import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_ATTACHMENT_BYTES, partitionBySize, pastedFileName, pasteIsFiles, tooLargeMessage } from "../src/lib/files.js";

describe("partitionBySize", () => {
  it("keeps files up to the limit and sets aside the rest, in order", () => {
    const files = [{ name: "a", size: 10 }, { name: "big", size: MAX_ATTACHMENT_BYTES + 1 }, { name: "edge", size: MAX_ATTACHMENT_BYTES }];
    const { accepted, tooLarge } = partitionBySize(files);
    assert.deepEqual(accepted.map((f) => f.name), ["a", "edge"]);
    assert.deepEqual(tooLarge.map((f) => f.name), ["big"]);
  });
});

describe("tooLargeMessage", () => {
  it("says nothing when nothing was left out", () => {
    assert.equal(tooLargeMessage([]), null);
  });

  it("names the file, or counts and lists several", () => {
    assert.equal(tooLargeMessage(["demo.mov"]), "demo.mov is over the 25 MB limit, so it was not added.");
    assert.equal(tooLargeMessage(["a.mov", "b.zip"]), "2 files are over the 25 MB limit, so they were not added: a.mov, b.zip.");
  });
});

describe("pastedFileName", () => {
  const at = new Date(2026, 8, 24, 14, 3, 7);

  it("names a pasted screenshot for when it was pasted", () => {
    assert.equal(pastedFileName({ name: "image.png", type: "image/png" }, at), "Pasted 2026-09-24 14.03.07.png");
    assert.equal(pastedFileName({ name: "", type: "image/jpeg" }, at), "Pasted 2026-09-24 14.03.07.jpg");
  });

  it("numbers several pasted at once", () => {
    assert.equal(pastedFileName({ name: "image.png", type: "image/png" }, at, 1), "Pasted 2026-09-24 14.03.07 (2).png");
  });

  it("keeps a file's own name", () => {
    assert.equal(pastedFileName({ name: "invoice.pdf", type: "application/pdf" }, at), "invoice.pdf");
  });
});

describe("pasteIsFiles", () => {
  it("treats a paste as files only when it carries no text", () => {
    assert.equal(pasteIsFiles({ fileCount: 1, text: "" }), true);
    assert.equal(pasteIsFiles({ fileCount: 1, text: "a table copied with its picture" }), false);
    assert.equal(pasteIsFiles({ fileCount: 0, text: "" }), false);
  });
});
