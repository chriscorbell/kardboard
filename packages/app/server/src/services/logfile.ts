import fs from "node:fs";
import path from "node:path";

// Every push recreates the app's container, and Docker's log goes with it, so the app also writes
// its console output to one file a day under `<data dir>/logs`, on the bind mount, kept 14 days.
// That is what explains a failure found the next morning.
//
// It works by teeing the process's own stdout and stderr, so every `console` call and the request
// logger land in the file without knowing about it. Writes go through a file stream, which queues
// them off the event loop. Three things keep a tee from becoming the problem: a line that arrives
// while the stream is already far behind is dropped and counted rather than queued without end; the
// file's own errors are reported on the real stderr and never through `console`, which would come
// back here; and after an error the tee stops for good rather than retrying on every line.

const FILE_RE = /^app-(\d{4}-\d{2}-\d{2})\.log$/;
const ANSI_COLOUR = /\u001b\[[0-9;]*m/g;
// About a minute of a busy server's output. Past it the disk is not keeping up.
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

/** A logged URL with the value of any `token` parameter blanked out. */
export function redactTokens(line: string): string {
  return line.replace(/([?&]token=)[^&\s#]+/gi, "$1[redacted]");
}

export function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function logFileName(day: string): string {
  return `app-${day}.log`;
}

/** The files in `names` from before the `keepDays` days ending today. Other files are left alone. */
export function expiredLogFiles(names: string[], today: string, keepDays: number): string[] {
  const oldest = new Date(Date.parse(`${today}T00:00:00.000Z`) - (keepDays - 1) * 86_400_000).toISOString().slice(0, 10);
  return names.filter((name) => {
    const day = FILE_RE.exec(name)?.[1];
    return day !== undefined && day < oldest;
  });
}

/**
 * Puts `stamp` in front of every line that starts in `text`. Output arrives in arbitrary pieces, so
 * whether the first piece starts a line is carried from the previous call.
 */
export function stampLines(text: string, atLineStart: boolean, stamp: string): { text: string; atLineStart: boolean } {
  if (text === "") return { text, atLineStart };
  const lines = text.split("\n");
  const out = lines.map((line, i) => {
    const startsLine = i === 0 ? atLineStart : true;
    // The piece after a trailing newline is empty and belongs to the next call.
    if (i === lines.length - 1 && line === "") return line;
    return startsLine ? `${stamp} ${line}` : line;
  });
  return { text: out.join("\n"), atLineStart: text.endsWith("\n") };
}

type Write = (text: string) => void;

export class DailyLogFile {
  private day = "";
  private stream: fs.WriteStream | null = null;
  private atLineStart = true;
  private dropped = 0;
  private failed = false;

  constructor(
    private readonly dir: string,
    private readonly keepDays: number,
    private readonly now: () => Date = () => new Date(),
    // Where the tee reports its own trouble: the real stderr, never `console`.
    private readonly report: Write = (text) => void process.stderr.write(text),
  ) {}

  write(text: string): void {
    if (this.failed) return;
    const now = this.now();
    const day = dayOf(now);
    if (day !== this.day) this.open(day);
    const stream = this.stream;
    if (!stream) return;
    if (stream.writableLength > MAX_QUEUED_BYTES) {
      this.dropped++;
      return;
    }
    const stamp = now.toISOString();
    if (this.dropped > 0) {
      stream.write(`${stamp} [logfile] ${this.dropped} write(s) dropped while the disk was behind\n`);
      this.dropped = 0;
      this.atLineStart = true;
    }
    // The request logger colours its status codes, which a file shows as escape codes.
    const stamped = stampLines(text.replace(ANSI_COLOUR, ""), this.atLineStart, stamp);
    this.atLineStart = stamped.atLineStart;
    stream.write(stamped.text);
  }

  close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    return new Promise((resolve) => (stream ? stream.end(resolve) : resolve()));
  }

  private open(day: string): void {
    this.stream?.end();
    this.stream = null;
    this.day = day;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const name of expiredLogFiles(fs.readdirSync(this.dir), day, this.keepDays)) fs.rmSync(path.join(this.dir, name), { force: true });
    } catch (err) {
      this.fail(err);
      return;
    }
    const stream = fs.createWriteStream(path.join(this.dir, logFileName(day)), { flags: "a" });
    stream.on("error", (err) => this.fail(err));
    this.stream = stream;
    // A piece of a line from yesterday's file does not continue in today's.
    this.atLineStart = true;
  }

  private fail(err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.stream = null;
    this.report(`[logfile] stopped writing ${this.dir}: ${(err as Error).message}\n`);
  }
}

function chunkText(chunk: unknown, encoding: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString(typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
  return String(chunk);
}

/** Copies everything written to stdout and stderr into `file`, as well as where it was going. */
export function teeProcessOutput(file: Pick<DailyLogFile, "write">, targets: Pick<NodeJS.WriteStream, "write">[] = [process.stdout, process.stderr]): void {
  for (const target of targets) {
    const original = target.write.bind(target) as (...args: unknown[]) => boolean;
    let inside = false;
    target.write = ((chunk: unknown, ...rest: unknown[]) => {
      // Anything written while this very tee is writing is the tee's own trouble report.
      if (!inside) {
        inside = true;
        try {
          file.write(chunkText(chunk, rest[0]));
        } catch {
          // Never let the copy cost the original line.
        } finally {
          inside = false;
        }
      }
      return original(chunk, ...rest);
    }) as typeof target.write;
  }
}

export function startLogFile(dir: string, keepDays: number): DailyLogFile {
  const file = new DailyLogFile(dir, keepDays);
  teeProcessOutput(file);
  return file;
}
