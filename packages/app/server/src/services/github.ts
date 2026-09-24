import { createSign } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { CheckState } from "@kardboard/shared";
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
// A call GitHub never answers would otherwise hold whatever waits on it, a merge or a poll, forever.
const REQUEST_TIMEOUT_MS = 30_000;

async function gh<T>(token: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

// The app's own merge token is reused for a few minutes: the reconciliation poll reads every open
// pull request every two minutes, and a fresh token per read would double its calls. A Session's
// token is never shared, so each Session still gets its own.
const mergeTokens = new Map<string, InstallationToken & { reuseUntil: number }>();

export async function mintInstallationToken(kind: GitHubAppKind, owner: string, repo: string): Promise<InstallationToken> {
  if (kind === "merge") {
    const cached = mergeTokens.get(`${owner}/${repo}`);
    if (cached && cached.reuseUntil > Date.now()) return { token: cached.token, expiresAt: cached.expiresAt };
  }
  const minted = await mintFresh(kind, owner, repo);
  if (kind === "merge") {
    const reuseUntil = Math.min(Date.now() + 10 * 60_000, Date.parse(minted.expiresAt) - 5 * 60_000);
    mergeTokens.set(`${owner}/${repo}`, { ...minted, reuseUntil });
  }
  return minted;
}

async function mintFresh(kind: GitHubAppKind, owner: string, repo: string): Promise<InstallationToken> {
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
  /** The branch it merges into. */
  baseRef: string;
  state: "open" | "closed";
  merged: boolean;
  /** When it was last closed, merged or not; a pull request reopened and closed again gets a new one. */
  closedAt: string | null;
  mergeCommitSha: string | null;
  /** Null while GitHub is still working it out in the background. */
  mergeable: boolean | null;
  mergeableState: string;
}

type PullJson = {
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  head: { sha: string; ref: string; repo?: { full_name: string } | null };
  base?: { ref: string };
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  merge_commit_sha?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
};

function toPr(p: PullJson): PullRequest {
  return {
    number: p.number,
    url: p.html_url,
    title: p.title,
    body: p.body ?? "",
    headSha: p.head.sha,
    headRef: p.head.ref,
    headRepo: p.head.repo?.full_name ?? null,
    baseRef: p.base?.ref ?? "",
    state: p.state,
    merged: Boolean(p.merged ?? p.merged_at),
    closedAt: p.closed_at ?? null,
    mergeCommitSha: p.merge_commit_sha ?? null,
    mergeable: p.mergeable ?? null,
    mergeableState: p.mergeable_state ?? "unknown",
  };
}

async function readPullRequest(token: string, owner: string, repo: string, number: number): Promise<PullRequest | null> {
  const r = await gh<PullJson & { message?: string }>(token, `/repos/${owner}/${repo}/pulls/${number}`);
  return r.status === 200 ? toPr(r.body) : null;
}

export async function getPullRequest(owner: string, repo: string, number: number): Promise<PullRequest | null> {
  const { token } = await mintInstallationToken("merge", owner, repo);
  return readPullRequest(token, owner, repo, number);
}

export async function findPullRequestByBranch(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
  const { token } = await mintInstallationToken("merge", owner, repo);
  const r = await gh<PullJson[]>(token, `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`);
  if (r.status !== 200 || !Array.isArray(r.body) || r.body.length === 0) return null;
  // The list endpoint omits mergeability; fetch the full record.
  return getPullRequest(owner, repo, r.body[0]!.number);
}

// `pending` is a merge GitHub turned away only because it had not yet worked out whether the pull
// request can merge, even after being asked again: nothing is wrong with it, it just has to be
// tried again shortly.
export type MergeOutcome = { ok: true; sha: string } | { ok: false; reason: "head_changed" | "not_mergeable" | "pending" | "error"; message: string };

/**
 * What a 405 from the merge endpoint means. GitHub gives that status for every merge it will not
 * do right now, and they call for different things: `conflict` needs the branch brought up to date,
 * `retry` is GitHub still computing mergeability in the background (the pull request reads
 * `mergeable: null`) or a base branch that moved a moment ago, and `refused` is a rule or setting
 * of the repository's own that nothing on the branch will fix.
 */
export function classifyMergeRefusal(message: string, pr: Pick<PullRequest, "mergeable" | "mergeableState"> | null): "conflict" | "retry" | "refused" {
  if (pr?.mergeable === false || pr?.mergeableState === "dirty" || /merge conflict|out of date/i.test(message)) return "conflict";
  if (!pr || pr.mergeable === null || pr.mergeableState === "unknown" || /base branch was modified|not mergeable/i.test(message)) return "retry";
  return "refused";
}

// How long to wait before asking again after GitHub answered that it was still working out
// mergeability; the second wait is twice the first. Tests shorten it.
const MERGE_RECHECK_MS = Number(process.env.KARDBOARD_MERGE_RECHECK_MS ?? "3000");
const MERGE_ATTEMPTS = 3;

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
  const request = JSON.stringify({ merge_method: "squash", sha: expectedHeadSha, commit_title: title, commit_message: stripAttribution(body) });
  for (let attempt = 1; ; attempt++) {
    const r = await gh<{ merged?: boolean; sha?: string; message?: string } | null>(token, `/repos/${owner}/${repo}/pulls/${number}/merge`, { method: "PUT", body: request });
    const message = (r.body && typeof r.body === "object" ? r.body.message : undefined) ?? "";
    if (r.status === 200 && r.body?.merged) return { ok: true, sha: r.body.sha! };
    if (r.status === 409) return { ok: false, reason: "head_changed", message: message || "head changed" };
    if (r.status !== 405) return { ok: false, reason: "error", message: `${r.status} ${message}`.trim() };
    // The status alone does not say which kind of 405 this is, so the pull request is read again.
    const pr = await readPullRequest(token, owner, repo, number).catch(() => null);
    if (pr?.merged) return pr.headSha === expectedHeadSha ? { ok: true, sha: pr.mergeCommitSha ?? "" } : { ok: false, reason: "head_changed", message: "merged at another head" };
    if (pr && pr.headSha !== expectedHeadSha) return { ok: false, reason: "head_changed", message: "head changed" };
    const verdict = classifyMergeRefusal(message, pr);
    if (verdict === "conflict") return { ok: false, reason: "not_mergeable", message: message || "not mergeable" };
    if (verdict === "refused") return { ok: false, reason: "error", message: `405 ${message}`.trim() };
    if (attempt >= MERGE_ATTEMPTS) return { ok: false, reason: "pending", message: message || "GitHub has not finished checking whether it can be merged" };
    await sleep(MERGE_RECHECK_MS * attempt);
  }
}

// ---- CI on a commit ----
// Two GitHub APIs report CI and a repository can use either: check runs (GitHub Actions and most
// apps, behind the Checks permission) and commit statuses (older integrations, behind Commit
// statuses). Both are read with the merge token, which carries whatever the Merge app installation
// was granted; a repository that did not grant one answers 403 there, and that half is unknown.

export interface CheckItem {
  name: string;
  /** `completed`, or where it is on the way there: `queued`, `in_progress`, `pending`, and so on. */
  status: string;
  /** How a completed check ended, such as `success`, `failure`, `skipped`, or `error` for a commit status. Null until then. */
  conclusion: string | null;
  url: string | null;
}

export interface CommitChecks {
  state: CheckState;
  total: number;
  failed: number;
  pending: number;
  checks: CheckItem[];
}

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale", "error"]);

/**
 * One state for a commit's CI. Anything failed is `failing` whatever else is unknown; otherwise a
 * half that could not be read makes the whole `unknown`, since a passing half says nothing of the
 * other. `none` is a commit nothing ran on at all.
 */
export function summarizeChecks(parts: { runs: CheckItem[] | null; statuses: CheckItem[] | null }): Omit<CommitChecks, "checks"> {
  const known = [...(parts.runs ?? []), ...(parts.statuses ?? [])];
  const pending = known.filter((c) => c.status !== "completed").length;
  const failed = known.filter((c) => c.status === "completed" && c.conclusion !== null && FAILED_CONCLUSIONS.has(c.conclusion)).length;
  const blind = parts.runs === null || parts.statuses === null;
  const state: CheckState = failed > 0 ? "failing" : blind ? "unknown" : pending > 0 ? "pending" : known.length === 0 ? "none" : "passing";
  return { state, total: known.length, failed, pending };
}

type CheckRunJson = { name: string; status: string; conclusion: string | null; html_url?: string | null; details_url?: string | null };

// The list endpoint returns only the latest run of each check by default, so a re-run replaces the
// run it repeats instead of counting twice.
async function readCheckRuns(token: string, owner: string, repo: string, sha: string): Promise<CheckItem[] | null> {
  const out: CheckItem[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await gh<{ total_count?: number; check_runs?: CheckRunJson[] } | null>(token, `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    const runs = r.status === 200 ? r.body?.check_runs : undefined;
    if (!Array.isArray(runs)) return null;
    out.push(...runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url ?? c.details_url ?? null })));
    if (runs.length < 100 || out.length >= (r.body?.total_count ?? 0)) break;
  }
  return out;
}

// The combined status carries the latest status of each context.
async function readStatuses(token: string, owner: string, repo: string, sha: string): Promise<CheckItem[] | null> {
  const r = await gh<{ statuses?: { context: string; state: string; target_url?: string | null }[] } | null>(token, `/repos/${owner}/${repo}/commits/${sha}/status?per_page=100`);
  const statuses = r.status === 200 ? r.body?.statuses : undefined;
  if (!Array.isArray(statuses)) return null;
  return statuses.map((s) => ({ name: s.context, status: s.state === "pending" ? "pending" : "completed", conclusion: s.state === "pending" ? null : s.state, url: s.target_url ?? null }));
}

/** CI on one commit. Never throws: anything GitHub will not or cannot say comes back `unknown`. */
export async function readCommitChecks(owner: string, repo: string, sha: string): Promise<CommitChecks> {
  try {
    const { token } = await mintInstallationToken("merge", owner, repo);
    const [runs, statuses] = await Promise.all([readCheckRuns(token, owner, repo, sha), readStatuses(token, owner, repo, sha)]);
    return { ...summarizeChecks({ runs, statuses }), checks: [...(runs ?? []), ...(statuses ?? [])] };
  } catch (err) {
    console.warn(`[github] could not read checks for ${owner}/${repo}@${sha.slice(0, 7)}: ${(err as Error).message}`);
    return { state: "unknown", total: 0, failed: 0, pending: 0, checks: [] };
  }
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
