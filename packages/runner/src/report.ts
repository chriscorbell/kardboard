import { setTimeout as sleep } from "node:timers/promises";

/** The part of a container's inspected state an exit report carries. */
export interface ContainerExitState {
  OOMKilled?: boolean;
}

// What the app hears when a Session's container exits. Docker marks a container that hit its memory
// limit with `OOMKilled`, and says so nowhere else: the exit code alone is the same 137 as any other
// kill, so without this the Card could only say the run stopped unexpectedly.
export function exitReportBody(exitCode: number, state: ContainerExitState | null | undefined): { exitCode: number; oomKilled: boolean } {
  return { exitCode, oomKilled: state?.OOMKilled === true };
}

// Watchtower restarts the app and the runner together on every deploy, so an exit that happens then
// meets an app that is not listening yet. A report the app never gets leaves the Session holding its
// Claim until the wall clock, and the app then records it as failed. Retrying for about a minute
// outlasts a restart; a 4xx means the app heard and refused, so asking again would not help.
export async function deliverWithRetry(
  send: () => Promise<Response>,
  opts: { attempts?: number; baseMs?: number; wait?: (ms: number) => Promise<unknown> } = {},
): Promise<boolean> {
  const { attempts = 6, baseMs = 2_000, wait = (ms: number) => sleep(ms) } = opts;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await wait(baseMs * 2 ** (attempt - 1));
    try {
      const res = await send();
      if (res.ok || (res.status >= 400 && res.status < 500)) return res.ok;
    } catch {
      // The app is down or restarting: try again.
    }
  }
  return false;
}
