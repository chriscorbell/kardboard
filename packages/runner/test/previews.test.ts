import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import type Docker from "dockerode";
import { previewBridgeName } from "../src/networks.js";
import {
  buildAndRunPreview,
  cloneUrl,
  PreviewCancelled,
  PreviewError,
  previewBuildOptions,
  previewContainerName,
  previewContainerSpec,
  previewImageTag,
  redact,
  removePreview,
  type PreviewLimits,
  type PreviewRequest,
} from "../src/previews.js";

const req: PreviewRequest = {
  previewId: "pv1",
  boardSlug: "kardboard",
  cardId: "k6u39mjgb5j2w8",
  host: "k6u39mjg.preview.xode.cc",
  repoUrl: "https://github.com/chriscorbell/kardboard",
  branch: "kardboard/k6u39mjg-runner-hosted-previews",
  githubToken: "ghs_secret",
  dockerfile: "Dockerfile",
  port: 3000,
  env: { KARDBOARD_PREVIEW: "1" },
};

const limits: PreviewLimits = { routerNetwork: "kardboard_preview", memoryBytes: 1024, nanoCpus: 1000, pidsLimit: 16, buildMemoryBytes: 2048, buildTimeoutMs: 60_000 };

describe("cloning a branch for a Preview", () => {
  it("puts the installation token in the clone URL", () => {
    assert.equal(cloneUrl(req.repoUrl, "ghs_secret"), "https://x-access-token:ghs_secret@github.com/chriscorbell/kardboard");
  });

  it("leaves a public repository URL alone when there is no token", () => {
    assert.equal(cloneUrl(req.repoUrl, null), req.repoUrl);
  });

  it("keeps the token out of anything it reports", () => {
    assert.equal(redact("fatal: https://x-access-token:ghs_secret@github.com/x", "ghs_secret"), "fatal: https://x-access-token:***@github.com/x");
    assert.equal(redact("nothing to hide", null), "nothing to hide");
  });
});

describe("the Preview container", () => {
  const spec = previewContainerSpec(req, limits, "kardboard_preview_pv1");

  it("is named and tagged from the preview id", () => {
    assert.equal(previewContainerName("pv1"), "kardboard-preview-pv1");
    assert.equal(previewImageTag("pv1"), "kardboard-preview-pv1:latest");
    assert.equal(spec.name, "kardboard-preview-pv1");
    assert.equal(spec.Image, "kardboard-preview-pv1:latest");
  });

  it("joins its own network only, so branch code cannot reach the runner, the app, or another Preview", () => {
    assert.equal(spec.HostConfig?.NetworkMode, "kardboard_preview_pv1");
  });

  it("carries no host path and no credential", () => {
    assert.deepEqual(spec.HostConfig?.Binds, []);
    const envNames = (spec.Env ?? []).map((e) => e.split("=")[0]);
    assert.deepEqual(envNames.sort(), ["KARDBOARD_PREVIEW", "NODE_ENV", "PORT"]);
    assert.ok((spec.Env ?? []).includes("PORT=3000"));
  });

  it("is labelled for cleanup and opted out of Watchtower", () => {
    assert.equal(spec.Labels?.["kardboard.preview"], "pv1");
    assert.equal(spec.Labels?.["kardboard.preview.host"], req.host);
    assert.equal(spec.Labels?.["com.centurylinklabs.watchtower.enable"], "false");
  });

  it("runs under the same limits a Session does", () => {
    assert.equal(spec.HostConfig?.Memory, 1024);
    assert.equal(spec.HostConfig?.NanoCpus, 1000);
    assert.equal(spec.HostConfig?.PidsLimit, 16);
    assert.deepEqual(spec.HostConfig?.CapDrop, ["ALL"]);
    assert.deepEqual(spec.HostConfig?.SecurityOpt, ["no-new-privileges:true"]);
  });
});

describe("the Preview build", () => {
  const options = previewBuildOptions(req, { ...limits, nanoCpus: 1.5e9 }, "kardboard_preview_pv1");

  it("uses the classic builder, which honours a custom network where BuildKit does not", () => {
    assert.equal(options.version, "1");
  });

  it("runs its steps on the Preview's own network, which the host firewall covers", () => {
    assert.equal(options.networkmode, "kardboard_preview_pv1");
  });

  it("is held to the build memory ceiling and the Preview's CPU", () => {
    assert.equal(options.memory, 2048);
    assert.equal(options.cpuperiod, 100_000);
    assert.equal(options.cpuquota, 150_000, "one and a half CPUs");
  });
});

// Enough of Docker for a whole build: networks with their endpoints, images by tag, containers by
// name, and a build whose progress stream a test controls. Calls are recorded in order.
function fakeDocker(opts: { image?: string; container?: boolean; build?: (signal: AbortSignal) => Readable }) {
  const calls: string[] = [];
  const networks = new Map<string, string[]>([["kardboard_preview", ["router"]]]);
  const images = new Map<string, string>(opts.image ? [[previewImageTag("pv1"), opts.image]] : []);
  const containers = new Set<string>(opts.container ? [previewContainerName("pv1")] : []);
  let started!: () => void;
  const buildStarted = new Promise<void>((resolve) => (started = resolve));

  const docker = {
    calls,
    buildStarted,
    createNetwork: async (spec: Docker.NetworkCreateOptions) => {
      calls.push(`network create ${spec.Name} ${spec.Options?.["com.docker.network.bridge.name"]}`);
      networks.set(spec.Name!, []);
    },
    getNetwork: (name: string) => ({
      inspect: async () => {
        const endpoints = networks.get(name);
        if (!endpoints) throw new Error(`no such network ${name}`);
        return { Name: name, Containers: Object.fromEntries(endpoints.map((id) => [id, {}])) };
      },
      connect: async (o: { Container: string; EndpointConfig: { GwPriority?: number } }) => {
        calls.push(`network connect ${name} ${o.Container} gw=${o.EndpointConfig.GwPriority}`);
        networks.get(name)!.push(o.Container);
      },
      disconnect: async (o: { Container: string }) => {
        networks.set(name, networks.get(name)!.filter((id) => id !== o.Container));
      },
      remove: async () => {
        calls.push(`network remove ${name}`);
        networks.delete(name);
      },
    }),
    getContainer: (name: string) => ({
      inspect: async () => {
        if (name === "router") return { Id: "router", Name: "/kardboard-preview-router-1", Config: { Labels: { "com.docker.compose.service": "preview-router" } } };
        if (!containers.has(name)) throw new Error(`no such container ${name}`);
        return { Id: name, Name: `/${name}`, Config: { Labels: { "kardboard.preview": "pv1" } } };
      },
      stop: async () => {},
      remove: async () => {
        calls.push(`container remove ${name}`);
        containers.delete(name);
      },
    }),
    getImage: (name: string) => ({
      inspect: async () => {
        const id = images.get(name);
        if (!id) throw new Error(`no such image ${name}`);
        return { Id: id };
      },
      remove: async () => {
        calls.push(`image remove ${name}`);
      },
    }),
    buildImage: async (context: Readable, options: Docker.ImageBuildOptions) => {
      calls.push(`build version=${options.version} network=${options.networkmode} memory=${options.memory}`);
      context.resume();
      started();
      if (opts.build) return opts.build(options.abortSignal!);
      const stream = new PassThrough();
      stream.end(`${JSON.stringify({ stream: "Successfully built" })}\n`);
      images.set(previewImageTag("pv1"), "sha256:new");
      return stream;
    },
    createContainer: async (spec: Docker.ContainerCreateOptions) => {
      calls.push(`container create ${spec.name} on ${spec.HostConfig?.NetworkMode}`);
      containers.add(spec.name!);
      return { id: "c-new", start: async () => {} };
    },
    modem: {
      followProgress(stream: Readable, onFinished: (err: Error | null, out: unknown[]) => void, onProgress: (evt: unknown) => void) {
        const out: unknown[] = [];
        stream.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString().split("\n").filter(Boolean)) {
            const evt = JSON.parse(line);
            out.push(evt);
            onProgress(evt);
          }
        });
        stream.on("end", () => onFinished(null, out));
        stream.on("error", (err: Error) => onFinished(err, out));
      },
    },
  };
  return docker as unknown as Docker & { calls: string[]; buildStarted: Promise<void> };
}

// A build that never finishes on its own, the way a hung `RUN` step looks from outside.
const hang = (signal: AbortSignal) => {
  const stream = new PassThrough();
  signal.addEventListener("abort", () => stream.destroy());
  return stream;
};

describe("building and running a Preview", () => {
  let repo: string;
  let branchReq: PreviewRequest;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "preview-repo-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo });
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "Dockerfile"), "FROM scratch\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    branchReq = { ...req, repoUrl: `file://${repo}`, branch: "main", githubToken: null };
  });
  after(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("builds on the Preview's own network, swaps the container, and drops the image it replaced", async () => {
    const docker = fakeDocker({ image: "sha256:old", container: true });
    const result = await buildAndRunPreview(docker, branchReq, limits, () => {});
    assert.deepEqual(result, { containerId: "c-new", target: "http://kardboard-preview-pv1:3000" });
    assert.deepEqual(docker.calls, [
      `network create kardboard_preview_pv1 ${previewBridgeName("pv1")}`,
      "network connect kardboard_preview_pv1 router gw=-1",
      "build version=1 network=kardboard_preview_pv1 memory=2048",
      "container remove kardboard-preview-pv1",
      "container create kardboard-preview-pv1 on kardboard_preview_pv1",
      "image remove sha256:old",
    ]);
  });

  it("stops a build that runs past its limit and says why", async () => {
    const docker = fakeDocker({ build: hang });
    await assert.rejects(() => buildAndRunPreview(docker, branchReq, { ...limits, buildTimeoutMs: 100 }, () => {}), (err: Error) => {
      assert.ok(err instanceof PreviewError, String(err));
      assert.match(err.message, /took longer than/);
      return true;
    });
    assert.ok(!docker.calls.some((c) => c.startsWith("container create")));
    assert.ok(docker.calls.includes("network remove kardboard_preview_pv1"), "a first build leaves no network behind");
  });

  it("lets a newer build replace the one in flight rather than race it", async () => {
    const first = fakeDocker({ build: hang });
    const stale = assert.rejects(buildAndRunPreview(first, branchReq, limits, () => {}), PreviewCancelled);
    await first.buildStarted;
    const fresh = await buildAndRunPreview(fakeDocker({}), branchReq, limits, () => {});
    assert.equal(fresh.containerId, "c-new");
    await stale;
    assert.ok(!first.calls.some((c) => c.startsWith("container create")), "the stale build never starts a container");
    assert.ok(!first.calls.includes("network remove kardboard_preview_pv1"), "nor takes the network from the one that replaced it");
  });

  it("stops the build of a Preview that is removed while it builds", async () => {
    const docker = fakeDocker({ build: hang });
    const building = assert.rejects(buildAndRunPreview(docker, branchReq, limits, () => {}), PreviewCancelled);
    await docker.buildStarted;
    await removePreview(docker, "pv1");
    await building;
    assert.ok(!docker.calls.some((c) => c.startsWith("container create")));
  });

  it("keeps the network a previous container is still serving on when a rebuild fails", async () => {
    const failing = () => {
      const stream = new PassThrough();
      stream.end(`${JSON.stringify({ error: "RUN pnpm build: exit 1" })}\n`);
      return stream;
    };
    const docker = fakeDocker({ image: "sha256:old", container: true, build: failing });
    await assert.rejects(() => buildAndRunPreview(docker, branchReq, limits, () => {}), /build failed: RUN pnpm build: exit 1/);
    assert.ok(!docker.calls.includes("network remove kardboard_preview_pv1"));
    assert.ok(!docker.calls.includes("container remove kardboard-preview-pv1"), "the previous Preview keeps serving");
  });
});
