// How a Session's end is read and told. A container's exit code means little to the people on a
// Card, so it is turned into a sentence here, and a run that stopped short says so on the Card
// instead of leaving the request silently dropped. Plain functions: `session-end.ts` applies them.

/** What the runner reports when a Session's container exits. */
export interface ExitReport {
  exitCode: number;
  /** Docker's `State.OOMKilled`: the container hit its memory limit. */
  oomKilled?: boolean;
  reason?: string;
}

// `timeout` in the agent entrypoint exits 124 when it stopped the provider CLI at the wall clock.
const TIMEOUT_EXIT = 124;

export const NO_REPORT = "It ended without reporting back.";

/**
 * What a container's exit means for a Session that did not report through `finish`. A clean exit is
 * a success only if the Session told the Card something: every path through the workflow ends in a
 * Comment, whether a report, a question, or a duplicate link, so a clean exit with none consumed its
 * Triggers and answered nobody. Counting that as a success is how a request used to vanish, so it
 * fails, which puts the notice and Try again on the Card. `commented` is always true for a sweep,
 * which has no Card to answer on.
 */
export function outcomeOfExit(report: ExitReport, commented: boolean): { status: "succeeded" | "failed" | "timed_out"; summary: string } {
  if (report.exitCode === 0) {
    return commented ? { status: "succeeded", summary: report.reason ?? "Container exited cleanly." } : { status: "failed", summary: report.reason ?? NO_REPORT };
  }
  if (report.oomKilled) return { status: "failed", summary: "It ran out of memory." };
  if (report.exitCode === TIMEOUT_EXIT) return { status: "timed_out", summary: "It hit its time limit." };
  return { status: "failed", summary: report.reason ?? `It stopped unexpectedly (exit code ${report.exitCode}).` };
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The notice for a Session that stopped short, in words for the Card's people. `next` is what
 * happens now: they can press Try again, only comment when the Card is in Done (where Try again is
 * refused), or nothing, when the Card is already starting again on changes made during the run.
 */
export function stoppedNotice(input: { agentName: string; reason: string | null; next: "retry" | "comment" | "rerun" }): { title: string; reason: string; next: string; comment: string } {
  const { agentName } = input;
  const reason = input.reason?.trim() ? sentence(input.reason) : "It stopped unexpectedly.";
  const next = {
    retry: `Press Try again to start over, or add a comment and ${agentName} will pick the card up again.`,
    comment: `Add a comment and ${agentName} will pick the card up again.`,
    rerun: `${agentName} is starting again with the changes made since.`,
  }[input.next];
  const title = `${agentName} stopped before finishing`;
  return { title, reason, next, comment: `**${title} this card.** ${reason}\n\n${next}` };
}
