import type Docker from "dockerode";
import { DEFAULT_MIN_AGE_HOURS, ReleaseCooldown, type PendingRelease } from "./cooldown.js";

// Claude Code and Codex publish new releases several times a day, and an image rebuilt for each one
// would churn for nothing. Instead the runner keeps a recent release of each in one named volume,
// which every Session mounts read-only and runs from; the version built into the agent image is only
// the fallback. Every few minutes the runner asks npm for each CLI's `latest`, and picks the newest
// version it first saw there long enough ago, a day by default (cooldown.ts). When that is a version
// it has not made current, or the agent image has changed since, it runs `kardboard-clis ensure` in a
// short-lived container of the agent image. That installs the release into the volume and makes it
// current only if it passes the image's own checks (images/agent/clis.sh), so a release that drops a
// flag the entrypoint passes stays out of every Session.
//
// The installer runs as root, since the volume is root's and Sessions only read it, and on a bridge
// of its own whose name the host firewall already keeps off the LAN, like a Session's. It holds no
// credential and reaches nothing but the internet.

export const CLIS_VOLUME = "kardboard-clis";
export const CLIS_TARGET = "/opt/kardboard-clis";
export const CLIS_NETWORK = "kardboard_clis";
// `cbn`, the prefix `deploy/network-isolation.sh` matches, so the firewall covers it with no change.
export const CLIS_BRIDGE = "cbnclis";
export const CLIS_LABEL = "kardboard.clis";

export const CLI_TOOLS = [
  { name: "claude-code", pkg: "@anthropic-ai/claude-code" },
  { name: "codex", pkg: "@openai/codex" },
] as const;
export type CliTool = (typeof CLI_TOOLS)[number]["name"];

const RELEASE = /^\d+\.\d+\.\d+$/;

// Read-only: a Session must not be able to change the CLI every other Board's Sessions run.
export function clisMount(): Docker.MountSettings {
  return {
    Type: "volume",
    Source: CLIS_VOLUME,
    Target: CLIS_TARGET,
    ReadOnly: true,
    // As in cache.ts, the dockerode types mark DriverConfig required though the Engine API does not.
    VolumeOptions: { NoCopy: true, Labels: { [CLIS_LABEL]: "true" } } as unknown as Docker.MountSettings["VolumeOptions"],
  };
}

/** The version npm's `latest` tag names for a package, refused unless it is a plain release. */
export async function latestVersion(pkg: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`npm answered ${res.status} for ${pkg}`);
  const { version } = (await res.json()) as { version?: unknown };
  if (typeof version !== "string" || !RELEASE.test(version)) throw new Error(`npm's latest ${pkg} is not a release version: ${JSON.stringify(version)}`);
  return version;
}

export interface CliState {
  /** The version this runner last made current, or null before the first success. */
  current: string | null;
  /** The last version that failed, with the image it failed under; not retried until either changes. */
  failed: string | null;
  /** The agent image the last attempt ran under. */
  image: string | null;
  checkedAt: string | null;
  error: string | null;
  /** A newer release npm names that is still waiting out its minimum age. */
  pending: PendingRelease | null;
}

export const NO_STATE: CliState = { current: null, failed: null, image: null, checkedAt: null, error: null, pending: null };

/**
 * Whether to run the installer: the version chosen to run is one this runner has not made current,
 * or the agent image changed, and its checks must pass again. A version that failed under this same
 * image is left until a newer release or a newer image, rather than reinstalled every few minutes.
 */
export function needsEnsure(state: CliState, version: string, image: string): boolean {
  if (state.failed === version && state.image === image) return false;
  return state.current !== version || state.image !== image;
}

export function ensureContainerSpec(image: string, tool: CliTool, version: string): Docker.ContainerCreateOptions {
  return {
    Image: image,
    Entrypoint: ["kardboard-clis"],
    Cmd: ["ensure", tool, version],
    User: "0:0",
    // Root's own home and working directory: npm runs install scripts as the owner of the working
    // directory, and the image's /work belongs to the agent user, who cannot write the volume.
    WorkingDir: "/root",
    Env: ["HOME=/root", "npm_config_cache=/root/.npm", `KARDBOARD_CLIS_DIR=${CLIS_TARGET}`],
    // Plain text logs, for the runner's own log when a version is refused.
    Tty: true,
    Labels: { "com.centurylinklabs.watchtower.enable": "false", [CLIS_LABEL]: tool },
    HostConfig: {
      Init: true,
      Memory: 2 * 1024 * 1024 * 1024,
      NanoCpus: 2e9,
      PidsLimit: 512,
      Mounts: [{ ...clisMount(), ReadOnly: false }],
      NetworkMode: CLIS_NETWORK,
      SecurityOpt: ["no-new-privileges:true"],
      CapDrop: ["ALL"],
    },
  };
}

export function clisNetworkSpec(): Docker.NetworkCreateOptions {
  return {
    Name: CLIS_NETWORK,
    Driver: "bridge",
    Internal: false,
    Attachable: false,
    Labels: { [CLIS_LABEL]: "true" },
    Options: { "com.docker.network.bridge.name": CLIS_BRIDGE },
  };
}

export interface CliUpdaterDeps {
  docker: Docker;
  image: string;
  /** Pulls the image when the registry has a newer one; the runner's own, shared with Session starts. */
  ensureImage: (image: string) => Promise<void>;
  latest?: (pkg: string) => Promise<string>;
  timeoutMs?: number;
  /** How long a version must have been npm's `latest` before it is taken; 0 takes it at once. */
  minAgeHours?: number;
  /** Where the first-seen times survive a restart; in memory only when absent. */
  firstSeenFile?: string;
  now?: () => Date;
}

export class CliUpdater {
  private states = new Map<CliTool, CliState>();
  private running: Promise<void> | null = null;
  private cooldown: ReleaseCooldown;

  constructor(private deps: CliUpdaterDeps) {
    this.cooldown = new ReleaseCooldown(deps.firstSeenFile ?? null, (deps.minAgeHours ?? DEFAULT_MIN_AGE_HOURS) * 3_600_000);
  }

  status(): Record<CliTool, CliState> {
    return Object.fromEntries(CLI_TOOLS.map((t) => [t.name, this.states.get(t.name) ?? NO_STATE])) as Record<CliTool, CliState>;
  }

  /** One pass over both CLIs. Overlapping calls share the pass already under way. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  start(intervalMs = 10 * 60_000): void {
    const run = () => void this.tick().catch((err: Error) => console.error("[clis] update pass failed", err.message));
    // Containers left by a runner that died mid-install go first; the pass after them reinstalls.
    void this.removeLeftovers()
      .catch((err: Error) => console.warn("[clis] could not remove leftover installers", err.message))
      .then(() => setTimeout(run, 20_000).unref?.());
    setInterval(run, intervalMs).unref?.();
  }

  private async pass(): Promise<void> {
    const { docker, image } = this.deps;
    await this.deps.ensureImage(image);
    const imageId = (await docker.getImage(image).inspect()).Id;
    for (const tool of CLI_TOOLS) {
      const state = this.states.get(tool.name) ?? NO_STATE;
      let latest: string;
      try {
        latest = await (this.deps.latest ?? latestVersion)(tool.pkg);
      } catch (err) {
        console.warn(`[clis] could not ask npm for ${tool.pkg}: ${(err as Error).message}`);
        continue;
      }
      const { version, pending } = this.cooldown.observe(tool.name, latest, (this.deps.now ?? (() => new Date()))());
      if (pending && pending.version !== state.pending?.version) {
        console.log(`[clis] ${tool.name} ${pending.version} waits until ${pending.eligibleAt}, ${this.cooldown.minAgeMs / 3_600_000} hours after it was first seen as npm's latest`);
      }
      // With nothing old enough yet, whatever the volume already holds stays current.
      if (!version || !needsEnsure(state, version, imageId)) {
        this.states.set(tool.name, { ...state, pending });
        continue;
      }
      const checkedAt = new Date().toISOString();
      const result = await this.ensure(tool.name, version);
      if (result.ok) {
        this.states.set(tool.name, { current: version, failed: null, image: imageId, checkedAt, error: null, pending });
        if (state.current !== version) console.log(`[clis] ${tool.name} ${version} is current`);
      } else {
        // A version that no longer passes is taken out of use by the installer, so it is not current.
        this.states.set(tool.name, { current: state.current === version ? null : state.current, failed: version, image: imageId, checkedAt, error: result.output, pending });
        console.error(`[clis] ${tool.name} ${version} was not made current:\n${result.output}`);
      }
    }
  }

  private async ensure(tool: CliTool, version: string): Promise<{ ok: boolean; output: string }> {
    const { docker } = this.deps;
    await this.ensureNetwork();
    const container = await docker.createContainer(ensureContainerSpec(this.deps.image, tool, version));
    try {
      await container.start();
      const timer = setTimeout(() => void container.kill().catch(() => {}), this.deps.timeoutMs ?? 10 * 60_000);
      let status: number;
      try {
        status = ((await container.wait()) as { StatusCode: number }).StatusCode;
      } finally {
        clearTimeout(timer);
      }
      const logs = await container.logs({ stdout: true, stderr: true, tail: 40 }).catch(() => Buffer.from(""));
      return { ok: status === 0, output: logs.toString("utf8").trim() };
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  }

  private async ensureNetwork(): Promise<void> {
    const { docker } = this.deps;
    if (await docker.getNetwork(CLIS_NETWORK).inspect().catch(() => null)) return;
    await docker.createNetwork(clisNetworkSpec()).catch((err: Error) => {
      if (!/already exists/i.test(err.message)) throw err;
    });
  }

  private async removeLeftovers(): Promise<void> {
    const list = await this.deps.docker.listContainers({ all: true, filters: { label: [CLIS_LABEL] } });
    for (const c of list) await this.deps.docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
  }
}
