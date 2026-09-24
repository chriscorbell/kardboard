import { generateKeyPairSync } from "node:crypto";

// A fake GitHub, just enough of the REST API for what kardboard does with pull requests: the
// installation lookup, the token mint, pull request reads, the merge, the branch delete, and the
// check runs and commit statuses on a commit. Every other host goes to the real `fetch`.
//
// `githubAppEnv` must run before the app's modules are imported, since the Apps are read from the
// environment at import time. The App's key is real because the app signs its JWT with it.

export function githubAppEnv(apps: ("MERGE" | "SESSIONS")[] = ["MERGE"]): void {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  for (const app of apps) {
    process.env[`GITHUB_${app}_APP_ID`] = "1";
    process.env[`GITHUB_${app}_APP_PRIVATE_KEY_B64`] = Buffer.from(privateKey).toString("base64");
  }
}

export interface FakePull {
  ref: string;
  repo: string | null;
  sha: string;
  state: "open" | "closed";
  merged?: boolean;
  closedAt?: string | null;
  base?: string;
  /** What GitHub says of mergeability: null while it is still computing. Defaults to true. */
  mergeable?: boolean | null;
  mergeableState?: string;
}

export interface FakeCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface FakeStatus {
  context: string;
  state: string;
}

export interface FakeGitHub {
  pulls: Map<number, FakePull>;
  merges: { number: number; sha: string }[];
  /** Every merge is refused this way while set, as GitHub does for a reason of its own. */
  refusal: { status: number; message: string } | null;
  /** The next merges are answered these ways, one each, before merging normally again. */
  mergeReplies: { status: number; message: string; then?: (p: FakePull) => void }[];
  /** Check runs and commit statuses by commit; a number is the status GitHub answers instead. */
  checkRuns: Map<string, FakeCheckRun[] | number>;
  statuses: Map<string, FakeStatus[] | number>;
  requests: string[];
  reset(): void;
  restore(): void;
}

export function installFakeGitHub(repo: string): FakeGitHub {
  const owner = repo.split("/")[0]!;
  const github: FakeGitHub = {
    pulls: new Map(),
    merges: [],
    refusal: null,
    mergeReplies: [],
    checkRuns: new Map(),
    statuses: new Map(),
    requests: [],
    reset() {
      this.pulls.clear();
      this.merges.length = 0;
      this.refusal = null;
      this.mergeReplies.length = 0;
      this.checkRuns.clear();
      this.statuses.clear();
      this.requests.length = 0;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };

  const pullJson = (number: number, p: FakePull) => ({
    number,
    html_url: `https://github.com/${repo}/pull/${number}`,
    title: "The change",
    body: "What it does.",
    head: { sha: p.sha, ref: p.ref, repo: p.repo ? { full_name: p.repo } : null },
    base: { ref: p.base ?? "main" },
    state: p.state,
    merged: p.merged ?? false,
    closed_at: p.closedAt ?? null,
    merge_commit_sha: p.merged ? "c".repeat(40) : null,
    mergeable: p.mergeable === undefined ? true : p.mergeable,
    mergeable_state: p.mergeableState ?? "clean",
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.github.com") return realFetch(input, init);
    const method = init?.method ?? "GET";
    github.requests.push(`${method} ${url.pathname}`);
    const reply = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status });
    if (url.pathname === `/repos/${repo}/installation`) return reply(200, { id: 42 });
    if (url.pathname === "/app/installations/42/access_tokens") return reply(201, { token: "ghs_test", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (url.pathname === `/repos/${repo}/pulls` && method === "GET") {
      const head = url.searchParams.get("head");
      const open = [...github.pulls].filter(([, p]) => p.state === "open" && p.repo === repo && `${owner}:${p.ref}` === head);
      return reply(200, open.map(([n, p]) => pullJson(n, p)));
    }
    let m = new RegExp(`^/repos/${repo}/pulls/(\\d+)$`).exec(url.pathname);
    if (m && method === "GET") {
      const p = github.pulls.get(Number(m[1]));
      return p ? reply(200, pullJson(Number(m[1]), p)) : reply(404, { message: "Not Found" });
    }
    m = new RegExp(`^/repos/${repo}/pulls/(\\d+)/merge$`).exec(url.pathname);
    if (m && method === "PUT") {
      const number = Number(m[1]);
      const p = github.pulls.get(number)!;
      const { sha } = JSON.parse(String(init?.body)) as { sha: string };
      if (github.refusal) return reply(github.refusal.status, { message: github.refusal.message });
      const next = github.mergeReplies.shift();
      if (next) {
        next.then?.(p);
        return reply(next.status, { message: next.message });
      }
      if (sha !== p.sha) return reply(409, { message: "Head branch was modified. Review and try the merge again." });
      github.merges.push({ number, sha });
      p.state = "closed";
      p.merged = true;
      p.closedAt = new Date().toISOString();
      return reply(200, { merged: true, sha: "c".repeat(40) });
    }
    if (url.pathname.startsWith(`/repos/${repo}/git/refs/heads/`) && method === "DELETE") return reply(204, null);
    m = new RegExp(`^/repos/${repo}/commits/([0-9a-f]+)/check-runs$`).exec(url.pathname);
    if (m && method === "GET") {
      const runs = github.checkRuns.get(m[1]!) ?? [];
      if (typeof runs === "number") return reply(runs, { message: "Resource not accessible by integration" });
      return reply(200, { total_count: runs.length, check_runs: runs.map((r, i) => ({ id: i + 1, ...r, html_url: `https://github.com/${repo}/runs/${i + 1}` })) });
    }
    m = new RegExp(`^/repos/${repo}/commits/([0-9a-f]+)/status$`).exec(url.pathname);
    if (m && method === "GET") {
      const statuses = github.statuses.get(m[1]!) ?? [];
      if (typeof statuses === "number") return reply(statuses, { message: "Resource not accessible by integration" });
      const state = statuses.some((s) => s.state === "failure" || s.state === "error") ? "failure" : statuses.some((s) => s.state === "pending") || statuses.length === 0 ? "pending" : "success";
      return reply(200, { state, total_count: statuses.length, statuses: statuses.map((s) => ({ ...s, target_url: `https://ci.example.com/${s.context}` })) });
    }
    return reply(404, { message: `the fake GitHub has no ${method} ${url.pathname}` });
  }) as typeof fetch;

  return github;
}
