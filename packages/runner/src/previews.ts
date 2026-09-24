import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type Docker from "dockerode";
import { createPreviewNetwork, removePreviewNetwork } from "./networks.js";

// A Preview is the branch's own Dockerfile, built and run as a container. It holds no kardboard
// credential and joins a network of its own, shared only with the preview router, so branch-controlled
// code can reach the internet and nothing else on the stack: not the runner's control network, not
// MCP, not the egress proxy, not another Board's Preview. Its build steps run on that network too.

export interface PreviewRequest {
  previewId: string;
  // The app's name for this build, returned with its report. Null from an app older than build ids.
  buildId: string | null;
  boardSlug: string;
  cardId: string;
  host: string;
  repoUrl: string;
  branch: string;
  githubToken: string | null;
  dockerfile: string;
  port: number;
  env: Record<string, string>;
}

export interface PreviewLimits {
  // Where the preview router lives. Each Preview's own network is created beside it and the router
  // is connected to that; see `networks.ts`.
  routerNetwork: string;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  // A build installs and compiles, which needs more memory than serving does. It gets the same CPU.
  buildMemoryBytes: number;
  buildTimeoutMs: number;
}

export const previewContainerName = (previewId: string) => `kardboard-preview-${previewId}`;
export const previewImageTag = (previewId: string) => `kardboard-preview-${previewId}:latest`;

// The clone URL carries a one-hour installation token. It is never logged and never written into
// the image: the build context is the working tree, and `.git` is excluded from the tar.
export function cloneUrl(repoUrl: string, token: string | null): string {
  if (!token) return repoUrl;
  const url = new URL(repoUrl);
  url.username = "x-access-token";
  url.password = token;
  return url.toString();
}

export function redact(text: string, token: string | null): string {
  return token ? text.split(token).join("***") : text;
}

export function previewContainerSpec(req: PreviewRequest, limits: PreviewLimits, network: string): Docker.ContainerCreateOptions {
  return {
    Image: previewImageTag(req.previewId),
    name: previewContainerName(req.previewId),
    Env: Object.entries({ NODE_ENV: "production", PORT: String(req.port), ...req.env }).map(([k, v]) => `${k}=${v}`),
    Labels: {
      "com.centurylinklabs.watchtower.enable": "false",
      "kardboard.preview": req.previewId,
      "kardboard.board": req.boardSlug,
      "kardboard.card": req.cardId,
      "kardboard.preview.host": req.host,
    },
    HostConfig: {
      Memory: limits.memoryBytes,
      NanoCpus: limits.nanoCpus,
      PidsLimit: limits.pidsLimit,
      // No binds at all: a Preview gets no host path, and no Docker socket.
      Binds: [],
      NetworkMode: network,
      SecurityOpt: ["no-new-privileges:true"],
      CapDrop: ["ALL"],
      RestartPolicy: { Name: "unless-stopped" },
    },
  };
}

const CPU_PERIOD_US = 100_000;

// The classic builder, named rather than left to the daemon's default: BuildKit ignores a custom
// network and would run RUN steps on docker0, which the host firewall's `cbn*` rule does not cover.
// The build API offers memory and CPU limits but no pids limit and no capability or privilege
// options, so RUN steps keep Docker's default capability set. `ADD <url>` is fetched by the daemon
// itself, from the host's network; see docs/runbooks/previews.md.
export function previewBuildOptions(req: PreviewRequest, limits: PreviewLimits, network: string, signal?: AbortSignal): Docker.ImageBuildOptions {
  return {
    t: previewImageTag(req.previewId),
    dockerfile: req.dockerfile,
    forcerm: true,
    version: "1",
    networkmode: network,
    memory: limits.buildMemoryBytes,
    cpuperiod: CPU_PERIOD_US,
    cpuquota: Math.round((limits.nanoCpus / 1e9) * CPU_PERIOD_US),
    abortSignal: signal,
  };
}

function run(cmd: string, args: string[], opts: { cwd?: string; signal?: AbortSignal } = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, signal: opts.signal, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d.toString()));
    child.stderr.on("data", (d) => (output += d.toString()));
    child.on("error", (err) => resolve({ code: 127, output: `${output}${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

export class PreviewError extends Error {}

// A build that stopped because a newer build of the same Preview replaced it, or because the Preview
// was removed. Nothing is reported for it: whatever replaced it reports instead.
export class PreviewCancelled extends Error {}

// Returns the commit it checked out: the branch head at the moment of the clone, which is what the
// app compares with the pull request head a Member is about to approve.
async function cloneBranch(req: PreviewRequest, dir: string, signal: AbortSignal): Promise<string> {
  const res = await run("git", ["clone", "--depth", "1", "--single-branch", "--branch", req.branch, cloneUrl(req.repoUrl, req.githubToken), dir], { signal });
  signal.throwIfAborted();
  if (res.code !== 0) throw new PreviewError(`clone failed: ${redact(res.output, req.githubToken).trim().slice(-500)}`);
  const head = await run("git", ["rev-parse", "HEAD"], { cwd: dir, signal });
  signal.throwIfAborted();
  if (head.code !== 0) throw new PreviewError(`could not read the cloned commit: ${head.output.trim().slice(-200)}`);
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  return head.output.trim();
}

// Tar is the build context format the Docker daemon wants. BusyBox tar ships in the image, which
// keeps the runner free of an archive dependency.
function contextTar(dir: string, signal: AbortSignal): Readable {
  const child = spawn("tar", ["-cf", "-", "-C", dir, "."], { signal, stdio: ["ignore", "pipe", "ignore"] });
  child.on("error", () => {});
  return child.stdout;
}

async function buildImage(docker: Docker, dir: string, options: Docker.ImageBuildOptions, req: PreviewRequest, signal: AbortSignal, onLog: (line: string) => void): Promise<void> {
  const stream = (await docker.buildImage(contextTar(dir, signal) as never, options)) as unknown as Readable;
  await new Promise<void>((resolve, reject) => {
    // Aborting the request is what stops the build on the daemon; the progress stream does not
    // always report it, so the signal settles the promise itself.
    const onAbort = () => {
      stream.destroy();
      reject(signal.reason);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    docker.modem.followProgress(
      stream as never,
      (err, out) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) return reject(signal.reason);
        const failure = (out ?? []).find((o: { error?: string }) => o.error)?.error;
        if (err || failure) reject(new PreviewError(`build failed: ${redact(String(failure ?? (err as Error).message), req.githubToken).slice(-500)}`));
        else resolve();
      },
      (evt: { stream?: string; error?: string }) => {
        const line = (evt.stream ?? evt.error ?? "").trimEnd();
        if (line) onLog(line);
      },
    );
  });
}

const imageId = (docker: Docker, name: string) =>
  docker
    .getImage(name)
    .inspect()
    .then((info) => info.Id)
    .catch(() => null);

// One build per Preview at a time. Two would race for the same image tag and container name, and
// whichever finished last would win regardless of which push was newer.
const building = new Map<string, AbortController>();

export function cancelPreviewBuild(previewId: string, reason: string): boolean {
  const controller = building.get(previewId);
  if (!controller) return false;
  building.delete(previewId);
  controller.abort(new PreviewCancelled(reason));
  return true;
}

// `onCloned` hears the commit as soon as it is known, so a build that fails after the clone can
// still say which commit it failed on.
export async function buildAndRunPreview(
  docker: Docker,
  req: PreviewRequest,
  limits: PreviewLimits,
  onLog: (line: string) => void,
  onCloned: (sha: string) => void = () => {},
): Promise<{ containerId: string; target: string; sha: string }> {
  if (cancelPreviewBuild(req.previewId, "a newer build of this preview replaced it")) onLog("[preview] stopped the build already in flight; this one replaces it");
  const controller = new AbortController();
  building.set(req.previewId, controller);
  const { signal } = controller;
  const minutes = Math.round(limits.buildTimeoutMs / 60_000);
  const timer = setTimeout(() => controller.abort(new PreviewError(`the build took longer than ${minutes} minutes and was stopped`)), limits.buildTimeoutMs);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `preview-${req.previewId}-`));
  try {
    onLog(`[preview] cloning ${req.repoUrl} at ${req.branch}`);
    const sha = await cloneBranch(req, dir, signal);
    onLog(`[preview] building commit ${sha}`);
    onCloned(sha);
    if (!fs.existsSync(path.join(dir, req.dockerfile))) {
      throw new PreviewError(`${req.dockerfile} is not in the branch, so there is nothing to build. Runner previews need a Dockerfile at the repository root.`);
    }

    const network = await createPreviewNetwork(docker, req.previewId, req.boardSlug, limits.routerNetwork);
    const previous = await imageId(docker, previewImageTag(req.previewId));
    onLog(`[preview] building ${previewImageTag(req.previewId)} on ${network}`);
    await buildImage(docker, dir, previewBuildOptions(req, limits, network, signal), req, signal, onLog);
    signal.throwIfAborted();

    // Replace any earlier container for this preview: a new push rebuilds in place.
    await removePreviewContainer(docker, req.previewId);
    signal.throwIfAborted();
    const container = await docker.createContainer(previewContainerSpec(req, limits, network));
    try {
      await container.start();
      // A newer build can replace this one while its container is created and started. Left up, this
      // container would serve a commit nobody is waiting on until the newer build swaps it out.
      signal.throwIfAborted();
    } catch (err) {
      await container.remove({ force: true }).catch(() => {});
      throw err;
    }
    onLog(`[preview] started ${previewContainerName(req.previewId)} on :${req.port}`);

    // The tag has moved to the new image, and the old image's container is gone, so nothing uses it.
    if (previous && previous !== (await imageId(docker, previewImageTag(req.previewId)))) {
      await docker.getImage(previous).remove().catch(() => {});
    }
    return { containerId: container.id, target: `http://${previewContainerName(req.previewId)}:${req.port}`, sha };
  } catch (err) {
    const failure = signal.aborted ? signal.reason : err;
    // A failed first build leaves a network holding only the router. A failed rebuild leaves the
    // previous container serving on it, so the network stays with it. A cancelled build leaves both
    // to whatever cancelled it.
    if (!(failure instanceof PreviewCancelled)) {
      const serving = await docker.getContainer(previewContainerName(req.previewId)).inspect().catch(() => null);
      if (!serving) await removePreviewNetwork(docker, req.previewId).catch(() => {});
    }
    throw failure;
  } finally {
    clearTimeout(timer);
    if (building.get(req.previewId) === controller) building.delete(req.previewId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function removePreviewContainer(docker: Docker, previewId: string): Promise<boolean> {
  const container = docker.getContainer(previewContainerName(previewId));
  const info = await container.inspect().catch(() => null);
  if (!info) return false;
  await container.stop({ t: 5 }).catch(() => {});
  await container.remove({ force: true }).catch(() => {});
  return true;
}

// A build still running for a removed Preview would otherwise start a container nobody routes to.
export async function removePreview(docker: Docker, previewId: string): Promise<boolean> {
  cancelPreviewBuild(previewId, "the preview was removed");
  const removed = await removePreviewContainer(docker, previewId);
  await docker.getImage(previewImageTag(previewId)).remove({ force: true }).catch(() => {});
  await removePreviewNetwork(docker, previewId).catch(() => {});
  return removed;
}
