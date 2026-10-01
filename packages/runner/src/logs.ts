import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";

// The runner is the only process that can see a Session's container log, so it also serves it.
// Reading is incremental by byte offset: the caller keeps the offset and asks for what is new.

export const MAX_SLICE_BYTES = 256 * 1024;

export interface LogSlice {
  exists: boolean;
  size: number;
  // Byte offset the returned text starts at, which is not the requested one when the request was
  // too far behind the head or the file was replaced.
  offset: number;
  nextOffset: number;
  text: string;
  // True when bytes between the requested offset and `offset` were passed over.
  skipped: boolean;
}

const EMPTY: LogSlice = { exists: false, size: 0, offset: 0, nextOffset: 0, text: "", skipped: false };

// Session and Preview ids come from `newId()`; anything else must not reach the filesystem.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function logPathFor(dir: string, sessionId: string): string | null {
  if (!ID_PATTERN.test(sessionId)) return null;
  return path.join(dir, `${sessionId}.log`);
}

// Returns whole lines only. A line still being written is left for the next call, so a caller that
// follows `nextOffset` never sees half a line.
export function readLogSlice(dir: string, sessionId: string, offset: number, maxBytes = MAX_SLICE_BYTES): LogSlice {
  const file = logPathFor(dir, sessionId);
  if (!file) return EMPTY;
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return EMPTY;
  const size = stat.size;

  // A negative or past-the-end offset means the caller and the file disagree; start over from 0.
  let start = Number.isFinite(offset) && offset > 0 && offset <= size ? Math.floor(offset) : 0;
  let skipped = false;
  if (size - start > maxBytes) {
    start = size - maxBytes;
    skipped = true;
  }
  if (start >= size) return { exists: true, size, offset: start, nextOffset: start, text: "", skipped: false };

  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }

  // Skipping lands mid-line, so drop the partial first line with it.
  let from = 0;
  if (skipped) {
    const firstBreak = buf.indexOf(0x0a);
    if (firstBreak === -1) return { exists: true, size, offset: start, nextOffset: start, text: "", skipped };
    from = firstBreak + 1;
  }
  const lastBreak = buf.lastIndexOf(0x0a);
  if (lastBreak === -1 || lastBreak < from) return { exists: true, size, offset: start, nextOffset: start, text: "", skipped };

  return {
    exists: true,
    size,
    offset: start + from,
    nextOffset: start + lastBreak + 1,
    text: buf.subarray(from, lastBreak + 1).toString("utf8"),
    skipped,
  };
}

// A Session or a Preview build can print without end, and its log lands on the runner's data mount,
// on the same disk as the app's database. So a log stops growing at a ceiling: one last line says it
// was cut there, and everything after is dropped. The container keeps running, since the app's wall
// clock is what ends a Session. The line carries a timestamp the way Docker's lines do, so the
// transcript shows it like any other log line and a re-attach after a restart resumes after it.

export const MAX_LOG_BYTES = 200 * 1024 * 1024;

const sizeOf = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;

export function cutNotice(maxBytes: number, at = new Date()): string {
  const limit = maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / (1024 * 1024))} MB` : `${maxBytes} bytes`;
  return `${at.toISOString()} [runner] this log reached its ${limit} limit and was cut here; nothing printed after this was kept\n`;
}

/** Decides what of each chunk reaches a log that already holds `existingBytes`. */
export class LogCap {
  private size: number;
  private cut: boolean;
  private endsLine = true;

  constructor(
    existingBytes: number,
    private maxBytes = MAX_LOG_BYTES,
  ) {
    this.size = existingBytes;
    // Already full when opened: an earlier runner process cut it, and said so.
    this.cut = existingBytes >= maxBytes;
  }

  /** The chunk itself while it fits, the notice once when it does not, and nothing after that. */
  take(chunk: Buffer): Buffer | null {
    if (this.cut) return null;
    if (this.size + chunk.length <= this.maxBytes) {
      this.size += chunk.length;
      if (chunk.length > 0) this.endsLine = chunk[chunk.length - 1] === 0x0a;
      return chunk;
    }
    this.cut = true;
    // Docker can split a long line across chunks, so the notice may need a line break of its own.
    return Buffer.from(`${this.endsLine ? "" : "\n"}${cutNotice(this.maxBytes)}`);
  }
}

/** Appends a container's output stream to its log file, up to the ceiling. */
export function cappedLogStream(file: string, maxBytes = MAX_LOG_BYTES): Writable {
  const cap = new LogCap(sizeOf(file), maxBytes);
  const out = fs.createWriteStream(file, { flags: "a" });
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      const kept = cap.take(chunk);
      if (kept) out.write(kept, done);
      else done();
    },
    final(done) {
      out.end(done);
    },
  });
}

/** Appends one line at a time to a log written synchronously, as a Preview build's is, up to the ceiling. */
export function cappedLineAppender(file: string, maxBytes = MAX_LOG_BYTES): (line: string) => void {
  const cap = new LogCap(sizeOf(file), maxBytes);
  return (line) => {
    const kept = cap.take(Buffer.from(`${line}\n`));
    if (kept) fs.appendFileSync(file, kept);
  };
}
