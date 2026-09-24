import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

describe("an update pass", () => {
  it("installs each CLI's latest release once, then leaves it until something changes", async () => {
    const fake = fakeDocker(() => 0);
    const latest = { "@anthropic-ai/claude-code": "2.1.282", "@openai/codex": "0.156.1" } as Record<string, string>;
    const updater = new CliUpdater({ docker: fake.docker, image: "agent:latest", ensureImage: async () => {}, latest: async (pkg) => latest[pkg]! });

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
    const updater = new CliUpdater({ docker: fake.docker, image: "agent:latest", ensureImage: async () => {}, latest: async (pkg) => (pkg === "@openai/codex" ? codex : "2.1.282") });
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
    const updater = new CliUpdater({ docker: fake.docker, image: "agent:latest", ensureImage: async () => {}, latest: async (pkg) => (pkg === "@openai/codex" ? "0.156.1" : "2.1.282") });
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
    const updater = new CliUpdater({ docker: fake.docker, image: "agent:latest", ensureImage: async () => {}, latest: async () => "1.0.0" });
    await Promise.all([updater.tick(), updater.tick()]);
    assert.equal(fake.runs.length, 2);
  });
});
