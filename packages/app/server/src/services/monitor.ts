import type { Provider } from "@kardboard/shared";
import { env } from "../env.js";
import { alertAdmin, type AdminAlert } from "./alerts.js";
import { readEgressStatus, type EgressStatus } from "./provider-limits.js";
import { runner } from "./runner-client.js";

// Watches the two services a Session depends on and tells the Admin when one needs a person: the
// runner not answering, and anything the egress proxy saw that only a person can fix. The checks are
// cheap reads the app could make anyway; every decision about what is worth an alert is a plain
// function below, so it can be tested without a clock or a network.

const RUNNER_CHECK_MS = 60_000;
const EGRESS_CHECK_MS = 5 * 60_000;
// Longer than a Watchtower restart of the runner, which takes seconds, and short enough that Cards
// have not waited long when the email arrives.
export const RUNNER_DOWN_ALERT_MS = 5 * 60_000;
// The egress proxy remembers the last event of each kind until it restarts. One older than two polls
// was either already seen or happened while the app was down, and is history rather than news.
export const EGRESS_RECENT_MS = 2 * EGRESS_CHECK_MS;

const PROVIDER_NAME: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };

// How to replace each credential, which is the whole of the fix for a rejected one.
const REPLACE_CREDENTIAL: Record<Provider, string> = {
  claude: "Run `claude setup-token`, put the new token in CLAUDE_CODE_OAUTH_TOKEN in the stack's .env, and run `docker compose up -d egress`.",
  codex:
    "Make a new sign-in for kardboard alone with `CODEX_HOME=\"$(mktemp -d)\" codex login`, copy its auth.json over the file KARDBOARD_CODEX_AUTH_FILE names, and run `docker compose restart egress`. See deploy/.env.example.",
};

export interface RunnerHealth {
  state: "unconfigured" | "unknown" | "up" | "down";
  /** When it went down; null while it answers. */
  downSince: string | null;
  error: string | null;
  checkedAt: string | null;
}

let runnerHealth: RunnerHealth = { state: runner.mode === "noop" ? "unconfigured" : "unknown", downSince: null, error: null, checkedAt: null };
let egressState: EgressStatus["egress"] | "unknown" = env.egressUrl ? "unknown" : "unconfigured";

/** The runner's own check, which also pings Docker. Null when healthy, otherwise what went wrong. */
async function probeRunner(): Promise<string | null> {
  try {
    const res = await fetch(`${env.runnerUrl.replace(/\/$/, "")}/healthz`, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    return `answered ${res.status}${typeof body.error === "string" ? `: ${body.error}` : ""}`;
  } catch (err) {
    return (err as Error).message;
  }
}

export function nextRunnerHealth(prev: RunnerHealth, error: string | null, now: Date): RunnerHealth {
  const checkedAt = now.toISOString();
  if (error === null) return { state: "up", downSince: null, error: null, checkedAt };
  return { state: "down", downSince: prev.state === "down" && prev.downSince ? prev.downSince : checkedAt, error, checkedAt };
}

export function runnerAlert(health: RunnerHealth, now: Date): AdminAlert | null {
  if (health.state !== "down" || !health.downSince) return null;
  const downMs = now.getTime() - Date.parse(health.downSince);
  if (downMs < RUNNER_DOWN_ALERT_MS) return null;
  const minutes = Math.round(downMs / 60_000);
  return {
    key: "runner.unreachable",
    subject: `The runner has not answered for ${minutes} minutes`,
    body:
      `kardboard has not been able to reach the runner since ${health.downSince} (last error: ${health.error ?? "unknown"}). ` +
      "No Session can start, and a running one cannot report its end, until it answers again. Cards keep their pending work and start once it is back.\n\n" +
      "On the host: `docker compose ps runner`, then `docker compose logs --tail 100 runner`.",
    path: "/admin/sessions",
  };
}

function recent(at: string, now: Date): boolean {
  const ms = Date.parse(at);
  return Number.isFinite(ms) && now.getTime() - ms <= EGRESS_RECENT_MS;
}

export function egressAlerts(status: EgressStatus, now: Date): AdminAlert[] {
  if (status.egress !== "reachable") return [];
  const alerts: AdminAlert[] = [];
  for (const p of status.providers) {
    const failure = p.authFailure;
    if (!failure || !recent(failure.at, now)) continue;
    const name = PROVIDER_NAME[p.provider];
    alerts.push({
      key: `egress.auth.${p.provider}`,
      subject: `${name} rejected its credential`,
      body:
        `At ${failure.at} the egress proxy saw ${name} refuse the credential it holds (${failure.reason}${failure.status ? `, status ${failure.status}` : ""}). ` +
        `Every Session on ${name} fails until it is replaced.\n\n${REPLACE_CREDENTIAL[p.provider]}`,
      path: "/admin/agent",
    });
  }
  const last = status.refusals.last;
  if (last && recent(last.at, now)) {
    const name = PROVIDER_NAME[last.provider];
    alerts.push({
      key: `egress.refused.${last.provider}`,
      subject: `The egress proxy refused a call from ${name}`,
      body:
        `At ${last.at} a Session asked the egress proxy for ${codeSpan(`${last.method} ${last.path}`)} on ${name}, which is not on the proxy's allowlist, so it was refused ` +
        `(${status.refusals.count} refused since the proxy started).\n\n` +
        `After a CLI upgrade this usually means ${name} now calls something new, and its Sessions may fail; the path belongs in ALLOWED_CALLS in packages/egress/src/proxy.ts if it is a call a turn needs. ` +
        "Otherwise a Session tried to reach part of the account it has no use for.",
      path: "/admin/agent",
    });
  }
  return alerts;
}

async function send(alert: AdminAlert | null): Promise<void> {
  if (alert) await alertAdmin(alert).catch((err) => console.error("[monitor] could not send an alert", err));
}

export async function checkRunner(now = new Date(), probe = probeRunner): Promise<RunnerHealth> {
  if (runner.mode === "noop") return runnerHealth;
  const error = await probe();
  const wasUp = runnerHealth.state !== "down";
  runnerHealth = nextRunnerHealth(runnerHealth, error, now);
  if (error && wasUp) console.warn(`[monitor] the runner did not answer: ${error}`);
  if (!error && !wasUp) console.log("[monitor] the runner answers again");
  await send(runnerAlert(runnerHealth, now));
  return runnerHealth;
}

export async function checkEgress(now = new Date(), read: (now: Date) => Promise<EgressStatus> = readEgressStatus): Promise<EgressStatus> {
  const status = await read(now);
  egressState = status.egress;
  for (const alert of egressAlerts(status, now)) await send(alert);
  return status;
}

/** Last known reachability, for `/healthz`. Informational: neither ever fails the app's own check. */
export function monitorSnapshot(): { runner: RunnerHealth["state"]; egress: EgressStatus["egress"] | "unknown" } {
  return { runner: runnerHealth.state, egress: egressState };
}

export function startMonitor(): void {
  const every = (ms: number, firstMs: number, fn: () => Promise<unknown>) => {
    const run = () => void fn().catch((err) => console.error("[monitor] check failed", err));
    // The first look waits a little: Watchtower restarts the app alongside the runner and the proxy.
    setTimeout(run, firstMs).unref();
    setInterval(run, ms).unref();
  };
  if (runner.mode !== "noop") every(RUNNER_CHECK_MS, 30_000, () => checkRunner());
  if (env.egressUrl) every(EGRESS_CHECK_MS, 45_000, () => checkEgress());
}

// A refused path is whatever a Session asked for, so it goes into the email as literal code: never
// a link or formatting the Session chose. Characters a path has no need of are dropped first.
function codeSpan(text: string): string {
  return `\`${text.replace(/[^A-Za-z0-9/_.%~:@!$&'*+,;=?# -]/g, "").slice(0, 200)}\``;
}
