import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { DailyLogFile, expiredLogFiles, logFileName, redactTokens, stampLines, teeProcessOutput } from "../src/services/logfile.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-logfile-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const T = "2026-09-24T12:00:00.000Z";

describe("stamping lines", () => {
  it("stamps each line that starts in the piece, and carries a half line over to the next piece", () => {
    const first = stampLines("one\ntw", true, T);
    assert.deepEqual(first, { text: `${T} one\n${T} tw`, atLineStart: false });
    const second = stampLines("o\nthree\n", first.atLineStart, T);
    assert.deepEqual(second, { text: `o\n${T} three\n`, atLineStart: true });
    assert.deepEqual(stampLines("", true, T), { text: "", atLineStart: true });
  });
});

describe("what the request log keeps", () => {
  it("blanks a token in the query and keeps the rest", () => {
    assert.equal(redactTokens("<-- GET /api/boards/one/events?token=eyJhbGciOi.x.y"), "<-- GET /api/boards/one/events?token=[redacted]");
    assert.equal(redactTokens("--> GET /api/x?offset=3&token=abc&n=1 200 4ms"), "--> GET /api/x?offset=3&token=[redacted]&n=1 200 4ms");
    assert.equal(redactTokens("--> GET /api/admin/sessions?status=failed 200 4ms"), "--> GET /api/admin/sessions?status=failed 200 4ms");
  });
});

describe("which files are old", () => {
  it("keeps the last fourteen days, today included, and ignores anything it did not write", () => {
    const names = ["app-2026-09-10.log", "app-2026-09-11.log", "app-2026-09-24.log", "notes.txt", "app-latest.log"];
    assert.deepEqual(expiredLogFiles(names, "2026-09-24", 14), ["app-2026-09-10.log"]);
    assert.deepEqual(expiredLogFiles(names, "2026-09-24", 1), ["app-2026-09-10.log", "app-2026-09-11.log"]);
  });
});

describe("the daily file", () => {
  it("writes stamped lines to today's file, starts a new file at midnight UTC, and prunes on the way", async () => {
    const dir = path.join(root, "logs");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "app-2026-09-01.log"), "old\n");
    fs.writeFileSync(path.join(dir, "keep-me.txt"), "mine\n");
    let now = new Date("2026-09-23T23:59:59.000Z");
    const file = new DailyLogFile(dir, 14, () => now);

    file.write("before \u001b[32mmidnight\u001b[0m\n");
    file.write("a half");
    now = new Date("2026-09-24T00:00:01.000Z");
    file.write(" line\nafter midnight\n");
    await file.close();

    assert.deepEqual(fs.readdirSync(dir).sort(), [logFileName("2026-09-23"), logFileName("2026-09-24"), "keep-me.txt"]);
    assert.equal(fs.readFileSync(path.join(dir, "app-2026-09-23.log"), "utf8"), "2026-09-23T23:59:59.000Z before midnight\n2026-09-23T23:59:59.000Z a half");
    assert.equal(fs.readFileSync(path.join(dir, "app-2026-09-24.log"), "utf8"), "2026-09-24T00:00:01.000Z  line\n2026-09-24T00:00:01.000Z after midnight\n");
  });

  it("stops a day's file at its limit, counting what an earlier start wrote, and starts afresh the next day", async () => {
    const dir = path.join(root, "capped");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, logFileName("2026-09-24")), "x".repeat(60));
    let now = new Date(T);
    const file = new DailyLogFile(dir, 14, () => now, () => undefined, 100);

    file.write("kept\n");
    file.write("over the limit\n");
    file.write("not kept\n");
    now = new Date("2026-09-25T00:00:01.000Z");
    file.write("a new day\n");
    await file.close();

    const today = fs.readFileSync(path.join(dir, logFileName("2026-09-24")), "utf8");
    assert.match(today, /kept\n/);
    assert.match(today, /daily limit/);
    assert.doesNotMatch(today, /not kept/);
    assert.equal(fs.readFileSync(path.join(dir, logFileName("2026-09-25")), "utf8"), "2026-09-25T00:00:01.000Z a new day\n");
  });

  it("copies what is written to a stream, bytes included, and cannot loop on its own output", () => {
    const written: string[] = [];
    const copied: string[] = [];
    const stream = { write: (chunk: unknown) => (written.push(String(chunk)), true) } as unknown as NodeJS.WriteStream;
    // A file whose write writes to the same stream again, as a report of its own trouble would.
    const file = { write: (text: string) => (copied.push(text), stream.write("[logfile] trouble\n")) } as unknown as DailyLogFile;
    teeProcessOutput(file, [stream]);
    stream.write("text line\n");
    stream.write(Buffer.from("byte line\n"));
    assert.deepEqual(copied, ["text line\n", "byte line\n"]);
    assert.equal(written.filter((w) => w.startsWith("[logfile]")).length, 2, "the report reached the stream and was not copied back");
  });

  it("stops quietly, once, when it cannot write, and says so on the real stderr only", async () => {
    const blocked = path.join(root, "blocked");
    fs.writeFileSync(blocked, "a file where the directory should be");
    const reports: string[] = [];
    const file = new DailyLogFile(blocked, 14, () => new Date(T), (text) => reports.push(text));
    file.write("one\n");
    file.write("two\n");
    await file.close();
    assert.equal(reports.length, 1);
    assert.match(reports[0]!, /\[logfile\] stopped writing/);
  });
});
