import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type Docker from "dockerode";
import { CLIS_BRIDGE, CLIS_NETWORK, CLIS_TARGET, CLIS_VOLUME, CliUpdater, clisMount, ensureContainerSpec, latestVersion, needsEnsure, NO_STATE } from "../src/clis.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("npm's latest version", () => {
  it("is read from the registry for a scoped package", async () => {
    let asked = "";
    const version = await latestVersion("@openai/codex", async (url) => {
      asked = String(url);
      return json({ name: "@openai/codex", version: "0.156.1" });
    });
    assert.equal(version, "0.156.1");
    assert.equal(asked, "https://registry.npmjs.org/@openai%2fcodex/latest");
  });

  it("is refused unless it is a plain release, which is all the installer will take", async () => {
    await assert.rejects(latestVersion("@openai/codex", async () => json({ version: "0.157.0-alpha.1" })), /not a release version/);
    await assert.rejects(latestVersion("@openai/codex", async () => json({ version: "1.0.0; rm -rf /" })), /not a release version/);
    await assert.rejects(latestVersion("@openai/codex", async () => json({}, 503)), /npm answered 503/);
  });
});

describe("whether to run the installer", () => {
  it("runs for a version not yet current, and for a new agent image", () => {
    assert.equal(needsEnsure(NO_STATE, "1.0.0", "img-a"), true);
    assert.equal(needsEnsure({ ...NO_STATE, current: "1.0.0", image: "img-a" }, "1.0.1", "img-a"), true);
    assert.equal(needsEnsure({ ...NO_STATE, current: "1.0.0", image: "img-a" }, "1.0.0", "img-b"), true);
  });

  it("does nothing when the current version was checked by this image", () => {
    assert.equal(needsEnsure({ ...NO_STATE, current: "1.0.0", image: "img-a" }, "1.0.0", "img-a"), false);
  });

  it("leaves a refused version alone until a newer release or a newer image", () => {
    const refused = { ...NO_STATE, current: "1.0.0", failed: "1.0.1", image: "img-a" };
    assert.equal(needsEnsure(refused, "1.0.1", "img-a"), false);
    assert.equal(needsEnsure(refused, "1.0.2", "img-a"), true);
    assert.equal(needsEnsure(refused, "1.0.1", "img-b"), true);
  });
});

describe("the CLI volume", () => {
  it("is mounted read-only into a Session", () => {
    const mount = clisMount();
    assert.equal(mount.Source, CLIS_VOLUME);
    assert.equal(mount.Target, CLIS_TARGET);
    assert.equal(mount.ReadOnly, true);
  });

  it("is written only by the installer, as root, with no capabilities, on the firewalled bridge", () => {
    const spec = ensureContainerSpec("agent:latest", "codex", "0.156.1");
    assert.deepEqual(spec.Entrypoint, ["kardboard-clis"]);
    assert.deepEqual(spec.Cmd, ["ensure", "codex", "0.156.1"]);
    assert.equal(spec.User, "0:0");
    assert.equal(spec.WorkingDir, "/root");
    assert.equal(spec.HostConfig?.Mounts?.[0]?.ReadOnly, false);
    assert.equal(spec.HostConfig?.Mounts?.[0]?.Source, CLIS_VOLUME);
    assert.equal(spec.HostConfig?.NetworkMode, CLIS_NETWORK);
    assert.deepEqual(spec.HostConfig?.CapDrop, ["ALL"]);
    assert.ok(CLIS_BRIDGE.startsWith("cbn") && CLIS_BRIDGE.length <= 15, "the host firewall matches cbn+ and Linux caps names at 15");
  });
});

// A Docker that runs no containers: each installer "exits" with what `exitFor` says.
function fakeDocker(exitFor: (cmd: string[]) => number, imageId = () => "img-a") {
  const runs: string[][] = [];
  let networks = 0;
  const docker = {
    getImage: () => ({ inspect: async () => ({ Id: imageId() }) }),
    getNetwork: () => ({ inspect: async () => (networks ? {} : Promise.reject(new Error("no such network"))) }),
    createNetwork: async () => {
      networks++;
    },
    listContainers: async () => [],
    getContainer: () => ({ remove: async () => {} }),
    createContainer: async (spec: Docker.ContainerCreateOptions) => {
      const cmd = spec.Cmd as string[];
      runs.push(cmd);
      return {
        start: async () => {},
        wait: async () => ({ StatusCode: exitFor(cmd) }),
        kill: async () => {},
        logs: async () => Buffer.from(exitFor(cmd) === 0 ? "ok" : "codex: exec --help no longer lists --strict-config"),
        remove: async () => {},
      };
    },
  };
  return { docker: docker as unknown as Docker, runs, networks: () => networks };
}

// These passes take each release as soon as npm names it; the wait is tested below.
describe("an update pass", () => {
  it("installs each CLI's latest release once, then leaves it until something changes", async () => {
    const fake = fakeDocker(() => 0);
    const latest = { "@anthropic-ai/claude-code": "2.1.282", "@openai/codex": "0.156.1" } as Record<string, string>;
    const updater = new CliUpdater({ docker: fake.docker, image: "agent:latest", ensureImage: async () => {}, minAgeHours: 0, latest: async (pkg) => latest[pkg]! });

    await updater.tick();
    assert.deepEqual(fake.runs, [
      ["ensure", "claude-code", "2.1.282"],
      ["ensure", "codex", "0.156.1"],
    ]);
    assert.equal(fake.networks(), 1);
    assert.equal(updater.status()["claude-code"].current, "2.1.282");

    await updater.tick();
    assert.equal(fake.runs.length, 2, "nothing new, so no installer");

    latest["@openai/codex"] = "0.157.0";
    await updater.tick();
    assert.deepEqual(fake.runs.at(-1), ["ensure", "codex", "0.157.0"]);
    assert.equal(fake.runs.length, 3);
  });

  it("keeps the version already current when a release is refused, and does not retry it every pass", async () => {
    const fake = fakeDocker((cmd) => (cmd[2] === "0.157.0" ? 1 : 0));
    let codex = "0.156.1";
    const updater = new CliUpdater({ docker: fake.docker, image: "agent:latest", ensureImage: async () => {}, minAgeHours: 0, latest: async (pkg) => (pkg === "@openai/codex" ? codex : "2.1.282") });
    await updater.tick();
    codex = "0.157.0";
    await updater.tick();
    const state = updater.status().codex;
    assert.equal(state.current, "0.156.1");
    assert.equal(state.failed, "0.157.0");
    assert.match(state.error ?? "", /no longer lists --strict-config/);

    await updater.tick();
    assert.equal(fake.runs.filter((r) => r[2] === "0.157.0").length, 1);
  });

  it("checks the current versions again under a new agent image", async () => {
    let image = "img-a";
    const fake = fakeDocker(() => 0, () => image);
    const updater = new CliUpdater({ docker: fake.docker, image: "agent:latest", ensureImage: async () => {}, minAgeHours: 0, latest: async (pkg) => (pkg === "@openai/codex" ? "0.156.1" : "2.1.282") });
    await updater.tick();
    image = "img-b";
    await updater.tick();
    assert.equal(fake.runs.length, 4);
  });

  it("skips a CLI whose npm lookup fails, and still does the other", async () => {
    const fake = fakeDocker(() => 0);
    const updater = new CliUpdater({
      docker: fake.docker,
      image: "agent:latest",
      ensureImage: async () => {},
      minAgeHours: 0,
      latest: async (pkg) => {
        if (pkg === "@anthropic-ai/claude-code") throw new Error("registry down");
        return "0.156.1";
      },
    });
    await updater.tick();
    assert.deepEqual(fake.runs, [["ensure", "codex", "0.156.1"]]);
  });

  it("runs one pass at a time", async () => {
    const fake = fakeDocker(() => 0);
    const updater = new CliUpdater({ docker: fake.docker, image: "agent:latest", ensureImage: async () => {}, minAgeHours: 0, latest: async () => "1.0.0" });
    await Promise.all([updater.tick(), updater.tick()]);
    assert.equal(fake.runs.length, 2);
  });
});

describe("the wait before a release is taken", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-clis-seen-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let files = 0;
  const seenFile = () => path.join(dir, `seen-${files++}.json`);

  // A clock the test moves by hand, starting at midnight UTC.
  function clock() {
    let t = Date.parse("2026-09-30T00:00:00.000Z");
    return { now: () => new Date(t), hours: (h: number) => void (t += h * 3_600_000) };
  }

  // Claude Code stays on one release throughout; `npm.codex` is what npm names `latest` for Codex.
  function updaterFor(npm: { codex: string }, time: ReturnType<typeof clock>, firstSeenFile?: string) {
    const fake = fakeDocker(() => 0);
    const updater = new CliUpdater({
      docker: fake.docker,
      image: "agent:latest",
      ensureImage: async () => {},
      minAgeHours: 24,
      firstSeenFile,
      now: time.now,
      latest: async (pkg) => (pkg === "@openai/codex" ? npm.codex : "2.1.282"),
    });
    return { updater, codexRuns: () => fake.runs.filter((r) => r[1] === "codex").map((r) => r[2]) };
  }

  it("takes a release only once npm has named it latest for the minimum age", async () => {
    const time = clock();
    const { updater, codexRuns } = updaterFor({ codex: "0.156.1" }, time);
    await updater.tick();
    assert.deepEqual(codexRuns(), []);
    assert.deepEqual(updater.status().codex.pending, { version: "0.156.1", eligibleAt: "2026-10-01T00:00:00.000Z" });

    time.hours(23);
    await updater.tick();
    assert.deepEqual(codexRuns(), []);

    time.hours(1);
    await updater.tick();
    assert.deepEqual(codexRuns(), ["0.156.1"]);
    assert.equal(updater.status().codex.current, "0.156.1");
    assert.equal(updater.status().codex.pending, null);
  });

  it("keeps the current version while a newer one waits, and trails a run of releases by the wait", async () => {
    const time = clock();
    const npm = { codex: "0.156.1" };
    const { updater, codexRuns } = updaterFor(npm, time);
    await updater.tick();
    time.hours(24);
    await updater.tick();
    assert.deepEqual(codexRuns(), ["0.156.1"]);

    npm.codex = "0.157.0";
    await updater.tick();
    time.hours(10);
    npm.codex = "0.158.0";
    await updater.tick();
    assert.deepEqual(codexRuns(), ["0.156.1"], "neither newer release is a day old");
    assert.equal(updater.status().codex.current, "0.156.1");
    assert.deepEqual(updater.status().codex.pending, { version: "0.157.0", eligibleAt: "2026-10-02T00:00:00.000Z" });

    time.hours(14);
    await updater.tick();
    assert.deepEqual(codexRuns(), ["0.156.1", "0.157.0"]);
    assert.deepEqual(updater.status().codex.pending, { version: "0.158.0", eligibleAt: "2026-10-02T10:00:00.000Z" });

    time.hours(10);
    await updater.tick();
    assert.deepEqual(codexRuns(), ["0.156.1", "0.157.0", "0.158.0"]);
  });

  it("does not take a release npm has stepped back from, however long ago it was seen", async () => {
    const time = clock();
    const npm = { codex: "0.156.1" };
    const { updater, codexRuns } = updaterFor(npm, time);
    await updater.tick();
    time.hours(1);
    npm.codex = "0.157.0";
    await updater.tick();
    time.hours(1);
    npm.codex = "0.156.1";
    time.hours(30);
    await updater.tick();
    assert.deepEqual(codexRuns(), ["0.156.1"]);
    assert.equal(updater.status().codex.pending, null);
  });

  it("remembers when it first saw each release across a restart", async () => {
    const time = clock();
    const file = seenFile();
    await updaterFor({ codex: "0.156.1" }, time, file).updater.tick();
    time.hours(24);
    const restarted = updaterFor({ codex: "0.156.1" }, time, file);
    await restarted.updater.tick();
    assert.deepEqual(restarted.codexRuns(), ["0.156.1"]);
  });

  it("starts every clock from now, rather than failing, when the file is unreadable", async () => {
    const time = clock();
    const file = seenFile();
    fs.writeFileSync(file, "{ not json");
    const { updater, codexRuns } = updaterFor({ codex: "0.156.1" }, time, file);
    await updater.tick();
    assert.deepEqual(codexRuns(), []);
    assert.equal(updater.status().codex.pending?.version, "0.156.1");
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).sort(), ["claude-code", "codex"], "rewritten whole");
  });
});
