import { createSign } from "node:crypto";
import { env } from "../env.js";

// Two GitHub Apps with the same repository permissions but different trust:
//   sessions: minted per Session, one hour, scoped to the Card's repository. Pushes branches and
//             opens pull requests. Cannot merge, because the branch ruleset requires an approval
//             it can never give.
//   merge:    used only by the app itself, on a recorded Approval, as the ruleset's bypass actor.
// See docs/adr/0008-two-github-apps-for-merge-authority.md.

export type GitHubAppKind = "sessions" | "merge";

type AppConfig = { id: string; privateKey: string; slug: string };

function appConfig(kind: GitHubAppKind): AppConfig | null {
  const cfg = kind === "sessions" ? env.githubSessionsApp : env.githubMergeApp;
  if (!cfg.id || !cfg.privateKey) return null;
  return cfg;
}

export function githubConfigured(kind: GitHubAppKind): boolean {
  return appConfig(kind) !== null;
}

export function parseRepoUrl(url: string | null): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function appJwt(cfg: AppConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: cfg.id }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(cfg.privateKey))}`;
}

const API = "https://api.github.com";

async function gh<T>(token: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      "User-Agent": "kardboard",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

const installationCache = new Map<string, { id: number; expires: number }>();

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function installationId(kind: GitHubAppKind, owner: string, repo: string): Promise<number> {
  const cfg = appConfig(kind);
  if (!cfg) throw new GitHubError(`GitHub ${kind} app is not configured`, 503);
  const key = `${kind}:${owner}/${repo}`;
  const cached = installationCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.id;
  const r = await gh<{ id?: number; message?: string }>(appJwt(cfg), `/repos/${owner}/${repo}/installation`);
  if (r.status !== 200 || !r.body.id) throw new GitHubError(`GitHub app "${cfg.slug}" is not installed on ${owner}/${repo} (${r.status})`, r.status);
  installationCache.set(key, { id: r.body.id, expires: Date.now() + 10 * 60_000 });
  return r.body.id;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

export async function mintInstallationToken(kind: GitHubAppKind, owner: string, repo: string): Promise<InstallationToken> {
  const cfg = appConfig(kind)!;
  const id = await installationId(kind, owner, repo);
  // Session tokens are narrowed to the three permissions a Session needs. The merge token takes
  // everything the Merge app installation holds, so a pull request touching workflow files can be
  // merged once the app is granted `workflows: write`.
  const body: Record<string, unknown> = { repositories: [repo] };
  if (kind === "sessions") body.permissions = { contents: "write", pull_requests: "write", metadata: "read" };
  const r = await gh<{ token?: string; expires_at?: string; message?: string }>(appJwt(cfg), `/app/installations/${id}/access_tokens`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (r.status !== 201 || !r.body.token) throw new GitHubError(`could not mint ${kind} token: ${r.status} ${r.body.message ?? ""}`, r.status);
  return { token: r.body.token, expiresAt: r.body.expires_at! };
}

export function botIdentity(kind: GitHubAppKind): { name: string; email: string } {
  const cfg = appConfig(kind);
  const slug = cfg?.slug ?? "kardboard";
  return { name: `${slug}[bot]`, email: `${cfg?.id ?? "0"}+${slug}[bot]@users.noreply.github.com` };
}

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  headSha: string;
  headRef: string;
  /** `owner/repo` the head branch lives in: another repository for a fork, null for a deleted one. */
  headRepo: string | null;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
}

function toPr(p: { number: number; html_url: string; title: string; body?: string | null; head: { sha: string; ref: string; repo?: { full_name: string } | null }; state: "open" | "closed"; merged?: boolean; merged_at?: string | null; mergeable?: boolean | null; mergeable_state?: string }): PullRequest {
  return { number: p.number, url: p.html_url, title: p.title, body: p.body ?? "", headSha: p.head.sha, headRef: p.head.ref, headRepo: p.head.repo?.full_name ?? null, state: p.state, merged: Boolean(p.merged ?? p.merged_at), mergeable: p.mergeable ?? null, mergeableState: p.mergeable_state ?? "unknown" };
}

export async function getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest | null> {
  const { token } = await mintInstallationToken("merge", owner, repo);
  const r = await gh<Parameters<typeof toPr>[0] & { message?: string }>(token, `/repos/${owner}/${repo}/pulls/${number}`);
  return r.status === 200 ? toPr(r.body) : null;
}

export async function findPullRequestByBranch(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
  const { token } = await mintInstallationToken("merge", owner, repo);
  const r = await gh<Parameters<typeof toPr>[0][]>(token, `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`);
  if (r.status !== 200 || !Array.isArray(r.body) || r.body.length === 0) return null;
  // The list endpoint omits mergeability; fetch the full record.
  return getPullRequest(owner, repo, r.body[0]!.number);
}

export type MergeOutcome = { ok: true; sha: string } | { ok: false; reason: "head_changed" | "not_mergeable" | "error"; message: string };

// Squash-merge with GitHub's head-SHA precondition: if anyone pushed after the Approval was
// recorded, GitHub answers 409 and nothing merges.
// Attribution lines that tools append to commits and pull requests. The squash commit carries none of them.
const ATTRIBUTION_LINE = /^\s*(co-authored-by:|signed-off-by:|generated with|🤖)/i;

export function stripAttribution(text: string): string {
  return text
    .split("\n")
    .filter((line) => !ATTRIBUTION_LINE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function mergePullRequest(owner: string, repo: string, number: number, expectedHeadSha: string, title: string, body: string): Promise<MergeOutcome> {
  const { token } = await mintInstallationToken("merge", owner, repo);
  // GitHub's default squash message concatenates every branch commit, trailers included. Passing
  // the message explicitly keeps the history to the pull request's own description.
  const r = await gh<{ merged?: boolean; sha?: string; message?: string }>(token, `/repos/${owner}/${repo}/pulls/${number}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: "squash", sha: expectedHeadSha, commit_title: title, commit_message: stripAttribution(body) }),
  });
  if (r.status === 200 && r.body.merged) return { ok: true, sha: r.body.sha! };
  if (r.status === 409) return { ok: false, reason: "head_changed", message: r.body.message ?? "head changed" };
  if (r.status === 405) return { ok: false, reason: "not_mergeable", message: r.body.message ?? "not mergeable" };
  return { ok: false, reason: "error", message: `${r.status} ${r.body.message ?? ""}` };
}

export async function deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
  const { token } = await mintInstallationToken("merge", owner, repo);
  await gh(token, `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "DELETE" });
}

export async function installationStatus(owner: string, repo: string): Promise<Record<GitHubAppKind, "installed" | "missing" | "unconfigured">> {
  const out = {} as Record<GitHubAppKind, "installed" | "missing" | "unconfigured">;
  for (const kind of ["sessions", "merge"] as const) {
    if (!githubConfigured(kind)) {
      out[kind] = "unconfigured";
      continue;
    }
    try {
      await installationId(kind, owner, repo);
      out[kind] = "installed";
    } catch {
      out[kind] = "missing";
    }
  }
  return out;
}
