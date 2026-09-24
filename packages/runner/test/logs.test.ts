import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { logPathFor, readLogSlice } from "../src/logs.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-logs-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
function withLog(contents: string): { dir: string; id: string } {
  const dir = fs.mkdtempSync(path.join(root, `case-${n++}-`));
  const id = `session${n}`;
  fs.writeFileSync(path.join(dir, `${id}.log`), contents);
  return { dir, id };
}

describe("log paths", () => {
  it("names the file after the session", () => {
    assert.equal(logPathFor("/data/logs", "abc123"), "/data/logs/abc123.log");
  });

  it("refuses anything that is not an id", () => {
    for (const bad of ["../secrets", "a/b", "", "with space", "x".repeat(65)]) {
      assert.equal(logPathFor("/data/logs", bad), null, bad);
    }
  });
});

describe("reading a slice", () => {
  it("reports a missing log rather than throwing", () => {
    const slice = readLogSlice(root, "nosuchsession", 0);
    assert.equal(slice.exists, false);
    assert.equal(slice.text, "");
  });

  it("returns the whole file from offset 0", () => {
    const { dir, id } = withLog("one\ntwo\n");
    const slice = readLogSlice(dir, id, 0);
    assert.equal(slice.exists, true);
    assert.equal(slice.text, "one\ntwo\n");
    assert.equal(slice.nextOffset, 8);
    assert.equal(slice.size, 8);
    assert.equal(slice.skipped, false);
  });

  it("returns only what was appended after the offset", () => {
    const { dir, id } = withLog("one\ntwo\n");
    const first = readLogSlice(dir, id, 0);
    fs.appendFileSync(path.join(dir, `${id}.log`), "three\n");
    const second = readLogSlice(dir, id, first.nextOffset);
    assert.equal(second.text, "three\n");
    assert.equal(second.nextOffset, 14);
  });

  it("holds back a line that is still being written", () => {
    const { dir, id } = withLog("one\ntwo");
    const slice = readLogSlice(dir, id, 0);
    assert.equal(slice.text, "one\n");
    assert.equal(slice.nextOffset, 4);
    // The rest arrives once its newline does.
    fs.appendFileSync(path.join(dir, `${id}.log`), "\n");
    assert.equal(readLogSlice(dir, id, slice.nextOffset).text, "two\n");
  });

  it("says nothing new when the offset is at the end", () => {
    const { dir, id } = withLog("one\n");
    const slice = readLogSlice(dir, id, 4);
    assert.equal(slice.exists, true);
    assert.equal(slice.text, "");
    assert.equal(slice.nextOffset, 4);
  });

  it("skips to the tail when the caller is far behind, on a line boundary", () => {
    // Twelve bytes back from the end lands inside "bbbb", so that partial line is dropped too.
    const { dir, id } = withLog("aaaa\nbbbb\ncccc\ndddd\n");
    const slice = readLogSlice(dir, id, 0, 12);
    assert.equal(slice.skipped, true);
    assert.equal(slice.text, "cccc\ndddd\n");
    assert.equal(slice.offset, 10);
    assert.equal(slice.nextOffset, 20);
  });

  it("starts over when the offset is past the end, as after a prune", () => {
    const { dir, id } = withLog("fresh\n");
    const slice = readLogSlice(dir, id, 9_000);
    assert.equal(slice.text, "fresh\n");
    assert.equal(slice.offset, 0);
    assert.equal(slice.skipped, false);
  });

  it("ignores a nonsense offset", () => {
    const { dir, id } = withLog("line\n");
    assert.equal(readLogSlice(dir, id, -5).text, "line\n");
    assert.equal(readLogSlice(dir, id, Number.NaN).text, "line\n");
  });
});
