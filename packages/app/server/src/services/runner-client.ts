import { env } from "../env.js";

export interface StartSessionRequest {
  sessionId: string;
  // Names the Board's dependency cache volume, since the id never changes and the slug can. A sweep
  // installs nothing and leaves it out, so it gets no cache.
  boardId?: string;
  boardSlug: string;
  provider: "claude" | "codex";
  model: string | null;
  reasoning: string | null;
  image: string | null;
  repoUrl: string | null;
  branch: string | null;
  token: string;
  wallClockMinutes: number;
  prompt: string;
  githubToken: string | null;
  gitName: string;
  gitEmail: string;
}

export interface StartPreviewRequest {
  previewId: string;
  // Sent back with the build's report, so the app can tell this build's outcome from a replaced one's.
  buildId: string;
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

export interface RunnerInventoryItem {
  containerId: string;
  sessionId: string;
  state: string;
  status: string;
}

// A slice of a Session's container log, whole lines only. Mirrors the runner's `readLogSlice`.
export interface RunnerLogSlice {
  exists: boolean;
  size: number;
  offset: number;
  nextOffset: number;
  text: string;
  skipped: boolean;
}

export interface RunnerClient {
  readonly mode: "http" | "noop";
  start(req: StartSessionRequest): Promise<{ containerId: string }>;
  stop(containerId: string): Promise<void>;
  inventory(): Promise<RunnerInventoryItem[]>;
  logSlice(sessionId: string, offset: number): Promise<RunnerLogSlice>;
  // The runner accepts a Preview build and reports the outcome later on /api/internal/previews.
  startPreview(req: StartPreviewRequest): Promise<void>;
  stopPreview(previewId: string): Promise<void>;
  // The newest part of a Preview's build log, at most the runner's slice size.
  previewLog(previewId: string): Promise<RunnerLogSlice>;
}

const NO_LOG: RunnerLogSlice = { exists: false, size: 0, offset: 0, nextOffset: 0, text: "", skipped: false };

class HttpRunner implements RunnerClient {
  readonly mode = "http" as const;
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}
  private headers() {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
  }
  async start(req: StartSessionRequest): Promise<{ containerId: string }> {
    const res = await fetch(`${this.baseUrl}/sessions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`runner start failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as { containerId: string };
  }
  async stop(containerId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(containerId)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) throw new Error(`runner stop failed: ${res.status}`);
  }
  async inventory(): Promise<RunnerInventoryItem[]> {
    const res = await fetch(`${this.baseUrl}/sessions`, { headers: this.headers() });
    if (!res.ok) throw new Error(`runner inventory failed: ${res.status}`);
    return (await res.json()) as RunnerInventoryItem[];
  }
  async logSlice(sessionId: string, offset: number): Promise<RunnerLogSlice> {
    const url = `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/log?offset=${Math.max(0, Math.floor(offset))}`;
    const res = await fetch(url, { headers: this.headers() });
    if (res.status === 404) return NO_LOG;
    if (!res.ok) throw new Error(`runner log failed: ${res.status}`);
    return (await res.json()) as RunnerLogSlice;
  }
  async startPreview(req: StartPreviewRequest): Promise<void> {
    const res = await fetch(`${this.baseUrl}/previews`, { method: "POST", headers: this.headers(), body: JSON.stringify(req) });
    if (!res.ok) throw new Error(`runner preview failed: ${res.status} ${await res.text()}`);
  }
  async stopPreview(previewId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/previews/${encodeURIComponent(previewId)}`, { method: "DELETE", headers: this.headers() });
    if (!res.ok && res.status !== 404) throw new Error(`runner preview removal failed: ${res.status}`);
  }
  async previewLog(previewId: string): Promise<RunnerLogSlice> {
    // Offset 0 of a log larger than one slice returns its newest slice, which is the part wanted.
    const res = await fetch(`${this.baseUrl}/previews/${encodeURIComponent(previewId)}/log?offset=0`, { headers: this.headers() });
    if (res.status === 404) return NO_LOG;
    if (!res.ok) throw new Error(`runner preview log failed: ${res.status}`);
    return (await res.json()) as RunnerLogSlice;
  }
}

// Used when no runner is configured: the Session is recorded and shown, but nothing runs.
class NoopRunner implements RunnerClient {
  readonly mode = "noop" as const;
  async start(req: StartSessionRequest): Promise<{ containerId: string }> {
    return { containerId: `noop-${req.sessionId}` };
  }
  async stop(): Promise<void> {}
  async inventory(): Promise<RunnerInventoryItem[]> {
    return [];
  }
  async logSlice(): Promise<RunnerLogSlice> {
    return NO_LOG;
  }
  async startPreview(): Promise<void> {}
  async stopPreview(): Promise<void> {}
  async previewLog(): Promise<RunnerLogSlice> {
    return NO_LOG;
  }
}

export const runner: RunnerClient = env.runnerUrl
  ? new HttpRunner(env.runnerUrl.replace(/\/$/, ""), env.runnerToken)
  : new NoopRunner();
