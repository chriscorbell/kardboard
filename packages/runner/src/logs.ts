import fs from "node:fs";
import path from "node:path";

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
