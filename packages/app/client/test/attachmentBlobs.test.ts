import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DISPLAYABLE_IMAGE_TYPES, isDisplayableImage, mimeEssence } from "@kardboard/shared";
import { downloadBlob, imageBlob } from "../src/lib/attachmentBlobs.js";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>`;

describe("mimeEssence", () => {
  it("keeps the lowercase type and subtype, without parameters or surrounding space", () => {
    assert.equal(mimeEssence("image/png"), "image/png");
    assert.equal(mimeEssence("IMAGE/SVG+XML; charset=utf-8"), "image/svg+xml");
    assert.equal(mimeEssence("  text/html ;charset=UTF-8"), "text/html");
    assert.equal(mimeEssence("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("calls anything not shaped like a type application/octet-stream", () => {
    for (const mime of ["", "png", "image/", "/png", "image/png/x", "image / png", "image/p<ng"]) {
      assert.equal(mimeEssence(mime), "application/octet-stream", JSON.stringify(mime));
    }
  });
});

describe("isDisplayableImage", () => {
  it("is true for the raster types, however they are written", () => {
    for (const type of DISPLAYABLE_IMAGE_TYPES) assert.equal(isDisplayableImage(type), true, type);
    assert.equal(isDisplayableImage("Image/PNG; foo=bar"), true);
  });

  it("is false for an SVG, another image type, or a page", () => {
    for (const mime of ["image/svg+xml", "image/svg+xml; charset=utf-8", "IMAGE/SVG+XML", "image/heic", "image/x-icon", "text/html", "application/xhtml+xml", ""]) {
      assert.equal(isDisplayableImage(mime), false, mime);
    }
  });
});

describe("imageBlob", () => {
  it("gives a raster image its allowed type, whatever the response said", async () => {
    const blob = imageBlob(new Blob([SVG], { type: "image/svg+xml" }), "Image/PNG; x=1");
    assert.equal(blob.type, "image/png");
    assert.equal(await blob.text(), SVG);
  });

  it("gives anything else no type a browser renders", () => {
    assert.equal(imageBlob(new Blob([SVG], { type: "image/svg+xml" }), "image/svg+xml").type, "application/octet-stream");
    assert.equal(imageBlob(new Blob(["<p>"], { type: "text/html" }), "text/html").type, "application/octet-stream");
  });
});

describe("downloadBlob", () => {
  it("is bytes to save, whatever it holds", async () => {
    for (const type of ["image/svg+xml", "text/html", "image/png"]) {
      const blob = downloadBlob(new Blob([SVG], { type }));
      assert.equal(blob.type, "application/octet-stream", type);
      assert.equal(await blob.text(), SVG);
    }
  });
});
