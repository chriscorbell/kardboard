import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type Docker from "dockerode";
import { resumeLogFrom, runningSessions, sinceValue } from "../src/reattach.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-reattach-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
function logWith(contents: string): string {
  const file = path.join(root, `session${n++}.log`);
  fs.writeFileSync(file, contents);
  return file;
}

// 2026-09-24T01:02:03Z in seconds since the epoch.
const T = Date.parse("2026-09-24T01:02:03Z") / 1000;

describe("reading a log line's timestamp", () => {
  it("gives Docker's seconds.nanoseconds", () => {
    assert.equal(sinceValue("2026-09-24T01:02:03.123456789Z hello"), `${T}.123456789`);
  });

  it("moves on by a nanosecond, carrying into the next second", () => {
    assert.equal(sinceValue("2026-09-24T01:02:03.123456789Z hello", 1), `${T}.123456790`);
    assert.equal(sinceValue("2026-09-24T01:02:03.999999999Z hello", 1), `${T + 1}.000000000`);
  });

  it("reads a short fraction or none", () => {
    assert.equal(sinceValue("2026-09-24T01:02:03.5Z hello"), `${T}.500000000`);
    assert.equal(sinceValue("2026-09-24T01:02:03Z hello"), `${T}.000000000`);
  });

  it("has nothing to say about a line with no timestamp", () => {
    assert.equal(sinceValue("hello"), undefined);
    assert.equal(sinceValue("2026-09-24T01:0"), undefined);
  });
});

describe("resuming a session's log after a restart", () => {
  it("picks up just after the last whole line, so nothing is written twice", () => {
    const file = logWith("2026-09-24T01:02:02.000000000Z first\n2026-09-24T01:02:03.123456789Z second\n");
    assert.equal(resumeLogFrom(file), `${T}.123456790`);
  });

  it("cuts a line the runner stopped halfway through and fetches it again whole", () => {
    const whole = "2026-09-24T01:02:02.000000000Z first\n";
    const file = logWith(`${whole}2026-09-24T01:02:03.123456789Z sec`);
    assert.equal(resumeLogFrom(file), `${T}.123456789`, "Docker includes the line stamped at `since`");
    assert.equal(fs.readFileSync(file, "utf8"), whole);
  });

  it("falls back to the last whole line when the cut-off line lost its timestamp too", () => {
    const whole = "2026-09-24T01:02:03.123456789Z first\n";
    const file = logWith(`${whole}2026-09-2`);
    assert.equal(resumeLogFrom(file), `${T}.123456790`);
    assert.equal(fs.readFileSync(file, "utf8"), whole);
  });

  it("fetches the whole log when there is no file or nothing in it", () => {
    assert.equal(resumeLogFrom(path.join(root, "never-written.log")), undefined);
    assert.equal(resumeLogFrom(logWith("")), undefined);
  });
});

describe("finding the containers to re-attach to", () => {
  it("lists running session containers by session id", async () => {
    let asked: unknown;
    const docker = {
      listContainers: async (opts: unknown) => {
        asked = opts;
        return [
          { Id: "c1", Names: ["/kardboard-session-s1"], Labels: { "kardboard.session": "s1" } },
          { Id: "c2", Names: [], Labels: { "kardboard.session": "s2" } },
          { Id: "c3", Names: ["/unlabelled"], Labels: {} },
        ];
      },
    } as unknown as Docker;

    assert.deepEqual(await runningSessions(docker), [
      { sessionId: "s1", containerId: "c1", name: "/kardboard-session-s1" },
      { sessionId: "s2", containerId: "c2", name: "c2" },
    ]);
    assert.deepEqual(asked, { filters: { label: ["kardboard.session"], status: ["running"] } }, "exited ones are pruned and reported separately");
  });
});
