import type Docker from "dockerode";
import fs from "node:fs";

// The runner learns that a Session's container exited by waiting on it, and it only waits on the
// containers it started. After a restart it is waiting on none of them, so their exits would go
// unreported and the app would hold their Claims until the wall clock. At boot it picks each
// running Session container up again, and resumes its log where the file left off.

/** The running Session containers, by Session ID. */
export async function runningSessions(docker: Docker): Promise<{ sessionId: string; containerId: string; name: string }[]> {
  const list = await docker.listContainers({ filters: { label: ["kardboard.session"], status: ["running"] } });
  return list.flatMap((c) => {
    const sessionId = c.Labels["kardboard.session"];
    return sessionId ? [{ sessionId, containerId: c.Id, name: c.Names[0] ?? c.Id }] : [];
  });
}

// A log line as Docker writes it with `timestamps`: RFC 3339 with up to nine fraction digits.
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}) /;

/** A line's timestamp as the `seconds.nanoseconds` Docker takes for `since`, moved on by `plusNs`. */
export function sinceValue(line: string, plusNs = 0): string | undefined {
  const m = TIMESTAMP.exec(line);
  if (!m) return undefined;
  let seconds = Date.parse(`${m[1]}${m[3]}`) / 1000;
  let nanos = Number((m[2] ?? "").padEnd(9, "0")) + plusNs;
  if (nanos >= 1e9) {
    seconds += 1;
    nanos -= 1e9;
  }
  return `${seconds}.${String(nanos).padStart(9, "0")}`;
}

/**
 * Where to resume following a Session's log after a restart, as Docker's `since`. Docker includes a
 * line stamped exactly at `since`, so the resume point is one nanosecond after the last whole line:
 * nothing is written twice, and whatever the container printed while the runner was down is fetched.
 * Undefined when there is nothing to resume after, and the whole log is fetched.
 */
export function resumeLogFrom(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  let buf = fs.readFileSync(file);
  const whole = buf.lastIndexOf(0x0a) + 1;
  if (whole < buf.length) {
    // A line cut short when the runner stopped. The app reads whole lines only, so it has not seen
    // this one; it is cut from the file and Docker sends it again whole.
    const partial = sinceValue(buf.subarray(whole, whole + 64).toString("utf8"));
    fs.truncateSync(file, whole);
    if (partial) return partial;
    buf = buf.subarray(0, whole);
  }
  if (buf.length === 0) return undefined;
  const last = buf.lastIndexOf(0x0a, buf.length - 2) + 1;
  return sinceValue(buf.subarray(last, last + 64).toString("utf8"), 1);
}
