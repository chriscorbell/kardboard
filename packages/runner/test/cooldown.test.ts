import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { chooseRelease, compareReleases, DEFAULT_MIN_AGE_HOURS, minAgeHoursFrom, ReleaseCooldown } from "../src/cooldown.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-30T00:00:00.000Z");
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-cooldown-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the minimum age setting", () => {
  it("reads whole and fractional hours, and 0 to turn the wait off", () => {
    assert.equal(minAgeHoursFrom("48"), 48);
    assert.equal(minAgeHoursFrom("0.5"), 0.5);
    assert.equal(minAgeHoursFrom("0"), 0);
  });

  it("keeps the default when unset, empty, or unreadable, so a typo never turns the wait off", () => {
    for (const value of [undefined, "", " ", "-1", "a day", "24h"]) assert.equal(minAgeHoursFrom(value), DEFAULT_MIN_AGE_HOURS, String(value));
  });
});

describe("ordering releases", () => {
  it("compares each part as a number", () => {
    assert.ok(compareReleases("1.2.10", "1.2.9") > 0);
    assert.ok(compareReleases("0.157.0", "0.156.12") > 0);
    assert.ok(compareReleases("2.0.0", "10.0.0") < 0);
    assert.equal(compareReleases("1.0.0", "1.0.0"), 0);
  });
});

describe("choosing a release", () => {
  const seen = { "1.0.0": at(0), "1.0.1": at(10), "1.0.2": at(20) };

  it("takes the newest one first seen at least the minimum age ago", () => {
    assert.deepEqual(chooseRelease(seen, "1.0.2", T0 + 35 * HOUR, 24 * HOUR), { version: "1.0.1", pending: { version: "1.0.2", eligibleAt: at(44) } });
  });

  it("takes nothing while every release is too new", () => {
    assert.deepEqual(chooseRelease(seen, "1.0.2", T0 + 23 * HOUR, 24 * HOUR), { version: null, pending: { version: "1.0.0", eligibleAt: at(24) } });
  });

  it("takes nothing newer than npm's latest", () => {
    assert.deepEqual(chooseRelease(seen, "1.0.0", T0 + 100 * HOUR, 24 * HOUR), { version: "1.0.0", pending: null });
  });

  it("takes latest at once with no wait", () => {
    assert.deepEqual(chooseRelease(seen, "1.0.2", T0 + 20 * HOUR, 0), { version: "1.0.2", pending: null });
  });
});

describe("first-seen times", () => {
  it("are recorded once, not moved on each sighting", () => {
    const cooldown = new ReleaseCooldown(null, 24 * HOUR);
    cooldown.observe("codex", "1.0.0", new Date(T0));
    assert.equal(cooldown.observe("codex", "1.0.0", new Date(T0 + 12 * HOUR)).pending?.eligibleAt, at(24));
    assert.equal(cooldown.observe("codex", "1.0.0", new Date(T0 + 24 * HOUR)).version, "1.0.0");
  });

  it("are kept per CLI", () => {
    const cooldown = new ReleaseCooldown(null, 24 * HOUR);
    cooldown.observe("codex", "1.0.0", new Date(T0));
    assert.equal(cooldown.observe("claude-code", "1.0.0", new Date(T0 + 24 * HOUR)).version, null);
  });

  it("are forgotten two weeks after they became eligible, except the version in use and npm's latest", () => {
    const file = path.join(dir, "forget.json");
    const cooldown = new ReleaseCooldown(file, 24 * HOUR);
    cooldown.observe("codex", "1.0.0", new Date(T0));
    cooldown.observe("codex", "1.0.1", new Date(T0 + HOUR));
    cooldown.observe("codex", "1.0.2", new Date(T0 + 2 * HOUR));
    const later = T0 + (24 + 14 * 24) * HOUR + 2 * HOUR + 1;
    // 1.0.2 is in use, since 1.0.3 has only just appeared; the two before it are past use and past keeping.
    cooldown.observe("codex", "1.0.3", new Date(later));
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).codex), ["1.0.2", "1.0.3"]);
  });

  it("drop anything in the file that is not a release and a time", () => {
    const file = path.join(dir, "mixed.json");
    fs.writeFileSync(file, `{"codex": {"1.0.0": "${at(0)}", "1.0.1-beta.1": "${at(0)}", "1.0.2": "yesterday", "1.0.3": 7}, "broken": [1, 2], "__proto__": {"9.9.9": "${at(0)}"}}`);
    const cooldown = new ReleaseCooldown(file, 24 * HOUR);
    assert.deepEqual(cooldown.observe("codex", "1.0.3", new Date(T0 + 30 * HOUR)), { version: "1.0.0", pending: { version: "1.0.3", eligibleAt: at(54) } });
    assert.equal(({} as Record<string, unknown>)["9.9.9"], undefined);
  });

  it("survive in memory when the file cannot be written", () => {
    const cooldown = new ReleaseCooldown(path.join(dir, "no-such-dir", "seen.json"), 24 * HOUR);
    cooldown.observe("codex", "1.0.0", new Date(T0));
    assert.equal(cooldown.observe("codex", "1.0.0", new Date(T0 + 24 * HOUR)).version, "1.0.0");
  });
});
