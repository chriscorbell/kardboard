import fs from "node:fs";

// Every Session on every Board runs the CLIs in the shared volume, holding a repository push token
// and an MCP token while it does. A release published from a hijacked npm account would reach all of
// them at the next update pass, and the hijacked releases of popular packages seen in 2025 were
// caught and pulled within hours. So a release waits: the runner takes a version only once it has
// seen npm name it `latest` at least `minAgeMs` ago. npm's abbreviated metadata carries no publish time, and the full document
// that does runs to megabytes, so the clock starts when this runner first sees the version instead,
// which is never earlier than its publication.
//
// Those first-seen times are kept in a small file on the runner's data mount, so a restart does not
// start every clock again. A file that cannot be read is ignored and replaced at the next save, and
// every clock starts from now, which can only delay a release, never hurry one.

export const DEFAULT_MIN_AGE_HOURS = 24;
// A version is forgotten this long after it became eligible, unless it is the one in use.
const FORGET_AFTER_MS = 14 * 86_400_000;

const RELEASE = /^\d+\.\d+\.\d+$/;

/** KARDBOARD_CLI_MIN_AGE_HOURS. Empty or unreadable keeps the default rather than turning the wait off. */
export function minAgeHoursFrom(value: string | undefined): number {
  return value !== undefined && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : DEFAULT_MIN_AGE_HOURS;
}

/** Orders two plain releases, `1.2.10` after `1.2.9`. */
export function compareReleases(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

export interface PendingRelease {
  version: string;
  /** When it will have been `latest` for the minimum age, as an ISO time. */
  eligibleAt: string;
}

export interface ReleaseChoice {
  /** The newest version old enough to run, or null when none is yet. */
  version: string | null;
  /** The next newer version to become old enough, if one is waiting. */
  pending: PendingRelease | null;
}

/**
 * Picks from a CLI's first-seen times. Nothing newer than npm's current `latest` is taken, so a
 * release npm has stepped back from, as it does for a bad one, is not adopted when its clock runs out.
 */
export function chooseRelease(seen: Record<string, string>, latest: string, now: number, minAgeMs: number): ReleaseChoice {
  const candidates = Object.entries(seen)
    .filter(([version]) => compareReleases(version, latest) <= 0)
    .map(([version, at]) => ({ version, eligibleAt: Date.parse(at) + minAgeMs }));
  let version: string | null = null;
  for (const c of candidates) {
    if (c.eligibleAt <= now && (version === null || compareReleases(c.version, version) > 0)) version = c.version;
  }
  let next: { version: string; eligibleAt: number } | null = null;
  for (const c of candidates) {
    if (c.eligibleAt <= now || (version !== null && compareReleases(c.version, version) <= 0)) continue;
    if (!next || c.eligibleAt < next.eligibleAt) next = c;
  }
  return { version, pending: next && { version: next.version, eligibleAt: new Date(next.eligibleAt).toISOString() } };
}

type FirstSeen = Record<string, Record<string, string>>;

// A CLI's name as `clis.ts` spells it, which also keeps `__proto__` out of the object built below.
const TOOL = /^[a-z][a-z-]{0,31}$/;

// Keeps only what reads as a CLI, a release and a time, so a hand-edited or half-written file cannot
// make the comparisons above misbehave.
function readFirstSeen(file: string): FirstSeen {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[clis] ignoring ${file}, which could not be read, so every release waits from now: ${(err as Error).message}`);
    return {};
  }
  const out: FirstSeen = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [tool, versions] of Object.entries(raw)) {
    if (!TOOL.test(tool) || !versions || typeof versions !== "object" || Array.isArray(versions)) continue;
    for (const [version, at] of Object.entries(versions)) {
      if (RELEASE.test(version) && typeof at === "string" && Number.isFinite(Date.parse(at))) (out[tool] ??= {})[version] = at;
    }
  }
  return out;
}

export class ReleaseCooldown {
  private seen: FirstSeen;

  /** `file` is null to keep the first-seen times in memory only. */
  constructor(
    private file: string | null,
    readonly minAgeMs: number,
  ) {
    this.seen = file ? readFirstSeen(file) : {};
  }

  /** Records `latest` the first time it is seen, and says which version a CLI should run now. */
  observe(tool: string, latest: string, now: Date): ReleaseChoice {
    const seen = (this.seen[tool] ??= {});
    let changed = false;
    if (!(latest in seen)) {
      seen[latest] = now.toISOString();
      changed = true;
    }
    const choice = chooseRelease(seen, latest, now.getTime(), this.minAgeMs);
    for (const [version, at] of Object.entries(seen)) {
      if (version === choice.version || version === latest) continue;
      if (now.getTime() - Date.parse(at) > this.minAgeMs + FORGET_AFTER_MS) {
        delete seen[version];
        changed = true;
      }
    }
    if (changed) this.save();
    return choice;
  }

  // Written whole and renamed into place, so a runner stopped mid-write leaves the previous file.
  // A failure costs only the memory of a restart, so it is reported and the pass goes on.
  private save(): void {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(this.seen, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[clis] could not save when each release was first seen: ${(err as Error).message}`);
    }
  }
}
