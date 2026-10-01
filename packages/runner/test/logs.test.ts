import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { after, describe, it } from "node:test";
import { cappedLineAppender, cappedLogStream, cutNotice, LogCap, logPathFor, readLogSlice } from "../src/logs.js";
import { resumeLogFrom } from "../src/reattach.js";

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

describe("the size ceiling", () => {
  const NOTICE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[runner\] this log reached its .+ limit and was cut here/;

  it("names the limit in a line stamped the way Docker stamps its own", () => {
    assert.equal(
      cutNotice(200 * 1024 * 1024, new Date("2026-09-30T12:00:00Z")),
      "2026-09-30T12:00:00.000Z [runner] this log reached its 200 MB limit and was cut here; nothing printed after this was kept\n",
    );
    assert.match(cutNotice(64), /its 64 bytes limit/);
  });

  it("lets output through up to the ceiling, then says so once and drops the rest", () => {
    const cap = new LogCap(0, 10);
    assert.equal(cap.take(Buffer.from("aaaa\n"))?.toString(), "aaaa\n");
    assert.equal(cap.take(Buffer.from("bbbb\n"))?.toString(), "bbbb\n");
    assert.match(cap.take(Buffer.from("c\n"))?.toString() ?? "", NOTICE);
    assert.equal(cap.take(Buffer.from("d\n")), null);
  });

  it("puts the notice on a line of its own when the output stopped mid-line", () => {
    const cap = new LogCap(0, 10);
    cap.take(Buffer.from("aaaa"));
    const notice = cap.take(Buffer.from("bbbbbbbbbb\n"))?.toString() ?? "";
    assert.ok(notice.startsWith("\n"));
    assert.match(notice.slice(1), NOTICE);
  });

  it("adds nothing to a log an earlier runner process already cut", () => {
    assert.equal(new LogCap(10, 10).take(Buffer.from("x\n")), null);
  });

  it("caps a Session's log stream, which the transcript reads and a re-attach resumes after", async () => {
    const { dir, id } = withLog("2026-09-30T11:00:00.000000000Z first\n");
    const file = path.join(dir, `${id}.log`);
    const out = cappedLogStream(file, 80);
    out.write(Buffer.from("2026-09-30T11:00:01.000000000Z second\n"));
    out.write(Buffer.from("2026-09-30T11:00:02.000000000Z this one does not fit\n"));
    out.write(Buffer.from("2026-09-30T11:00:03.000000000Z nor this\n"));
    out.end();
    await finished(out);

    const lines = readLogSlice(dir, id, 0).text.trimEnd().split("\n");
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.slice(0, 2), ["2026-09-30T11:00:00.000000000Z first", "2026-09-30T11:00:01.000000000Z second"]);
    assert.match(lines[2]!, NOTICE);
    // Docker's `since` for the notice's own time: a re-attach does not fetch the whole log again.
    assert.ok(resumeLogFrom(file));
  });

  it("caps a Preview build's log, written a line at a time", () => {
    const { dir, id } = withLog("[preview] accepted\n");
    const append = cappedLineAppender(path.join(dir, `${id}.log`), 40);
    append("[preview] cloning");
    append("Step 1/9 : FROM node:24-alpine");
    append("Step 2/9 : RUN yes");
    const lines = readLogSlice(dir, id, 0).text.trimEnd().split("\n");
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.slice(0, 2), ["[preview] accepted", "[preview] cloning"]);
    assert.match(lines[2]!, NOTICE);
  });
});
