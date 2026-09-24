import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type Docker from "dockerode";

// A Preview is the branch's own Dockerfile, built and run as a container. It holds no kardboard
// credential and joins the preview network only, so branch-controlled code can reach the internet
// and nothing else on the stack: not the runner's control network, not MCP, not the egress proxy.

export interface PreviewRequest {
  previewId: string;
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
  network: string;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
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

export function previewContainerSpec(req: PreviewRequest, limits: PreviewLimits): Docker.ContainerCreateOptions {
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
      NetworkMode: limits.network,
      SecurityOpt: ["no-new-privileges:true"],
      CapDrop: ["ALL"],
      RestartPolicy: { Name: "unless-stopped" },
    },
  };
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d.toString()));
    child.stderr.on("data", (d) => (output += d.toString()));
    child.on("error", (err) => resolve({ code: 127, output: `${output}${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

export class PreviewError extends Error {}

async function cloneBranch(req: PreviewRequest, dir: string): Promise<void> {
  const res = await run("git", ["clone", "--depth", "1", "--single-branch", "--branch", req.branch, cloneUrl(req.repoUrl, req.githubToken), dir]);
  if (res.code !== 0) throw new PreviewError(`clone failed: ${redact(res.output, req.githubToken).trim().slice(-500)}`);
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
}

// Tar is the build context format the Docker daemon wants. BusyBox tar ships in the image, which
// keeps the runner free of an archive dependency.
function contextTar(dir: string): Readable {
  const child = spawn("tar", ["-cf", "-", "-C", dir, "."], { stdio: ["ignore", "pipe", "ignore"] });
  return child.stdout;
}

export async function buildAndRunPreview(
  docker: Docker,
  req: PreviewRequest,
  limits: PreviewLimits,
  onLog: (line: string) => void,
): Promise<{ containerId: string; target: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `preview-${req.previewId}-`));
  try {
    onLog(`[preview] cloning ${req.repoUrl} at ${req.branch}`);
    await cloneBranch(req, dir);
    if (!fs.existsSync(path.join(dir, req.dockerfile))) {
      throw new PreviewError(`${req.dockerfile} is not in the branch, so there is nothing to build. Runner previews need a Dockerfile at the repository root.`);
    }

    onLog(`[preview] building ${previewImageTag(req.previewId)}`);
    const stream = await docker.buildImage(contextTar(dir) as never, { t: previewImageTag(req.previewId), dockerfile: req.dockerfile, forcerm: true });
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream as never,
        (err, out) => {
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

    // Replace any earlier container for this preview: a new push rebuilds in place.
    await removePreviewContainer(docker, req.previewId);
    const container = await docker.createContainer(previewContainerSpec(req, limits));
    await container.start();
    onLog(`[preview] started ${previewContainerName(req.previewId)} on :${req.port}`);
    return { containerId: container.id, target: `http://${previewContainerName(req.previewId)}:${req.port}` };
  } finally {
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

export async function removePreview(docker: Docker, previewId: string): Promise<boolean> {
  const removed = await removePreviewContainer(docker, previewId);
  await docker.getImage(previewImageTag(previewId)).remove({ force: true }).catch(() => {});
  return removed;
}
