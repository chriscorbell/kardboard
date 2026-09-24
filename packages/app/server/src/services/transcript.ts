import type { TranscriptEntry, TranscriptEntryKind } from "@kardboard/shared";

// A Session's log is one line per event, each prefixed by the Docker timestamp. Claude Code writes
// `stream-json`, so most lines are an event object; Codex and the entrypoint write plain text. Both
// end up here: anything that is not a recognised event is kept verbatim as a log line.

const DOCKER_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/;

const LIMITS: Record<TranscriptEntryKind, number> = {
  system: 400,
  thinking: 4_000,
  text: 8_000,
  tool: 800,
  tool_result: 1_200,
  result: 8_000,
  log: 2_000,
};

// The one-line summary of a tool call reads better as the argument that says what it acts on.
const TOOL_SUBJECT = ["command", "file_path", "path", "pattern", "url", "query", "prompt", "title", "body", "intent"];

function clip(kind: TranscriptEntryKind, body: string): { body: string; truncated: boolean } {
  const trimmed = body.replace(/\s+$/, "");
  const limit = LIMITS[kind];
  return trimmed.length > limit ? { body: trimmed.slice(0, limit), truncated: true } : { body: trimmed, truncated: false };
}

function entry(at: string | null, kind: TranscriptEntryKind, label: string | null, body: string, isError = false): TranscriptEntry {
  const clipped = clip(kind, body);
  return { at, kind, label, body: clipped.body, truncated: clipped.truncated, isError };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toolSubject(input: unknown): string {
  const record = asRecord(input);
  if (!record) return typeof input === "string" ? input : "";
  for (const key of TOOL_SUBJECT) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return JSON.stringify(record);
}

// A tool result's content is a string, or the content-block array the provider sends back.
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((block) => {
      const record = asRecord(block);
      if (!record) return String(block);
      if (typeof record.text === "string") return record.text;
      return record.type === "image" ? "[image]" : JSON.stringify(record);
    })
    .join("\n");
}

function fromMessage(at: string | null, event: Record<string, unknown>, out: TranscriptEntry[]): void {
  const message = asRecord(event.message);
  const content = message?.content;
  if (typeof content === "string") {
    if (content.trim()) out.push(entry(at, "text", null, content));
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") {
      if (record.text.trim()) out.push(entry(at, "text", null, record.text));
    } else if (record.type === "thinking" && typeof record.thinking === "string") {
      // Only the prose: the signature is a provider artefact and means nothing to a reader.
      if (record.thinking.trim()) out.push(entry(at, "thinking", null, record.thinking));
    } else if (record.type === "tool_use") {
      out.push(entry(at, "tool", typeof record.name === "string" ? record.name : "tool", toolSubject(record.input)));
    } else if (record.type === "tool_result") {
      out.push(entry(at, "tool_result", null, resultText(record.content), record.is_error === true));
    }
  }
}

function fromEvent(at: string | null, event: Record<string, unknown>): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  switch (event.type) {
    case "system": {
      // Everything but the opening line is a running counter, which is noise in a transcript.
      if (event.subtype !== "init") break;
      const tools = Array.isArray(event.tools) ? event.tools.length : 0;
      const model = typeof event.model === "string" ? event.model : "unknown model";
      out.push(entry(at, "system", "started", `${model}, ${tools} tools`));
      break;
    }
    case "assistant":
    case "user":
      fromMessage(at, event, out);
      break;
    case "result": {
      const body = typeof event.result === "string" ? event.result : String(event.subtype ?? "finished");
      const turns = typeof event.num_turns === "number" ? `${event.num_turns} turns` : null;
      const seconds = typeof event.duration_ms === "number" ? `${Math.round(event.duration_ms / 1000)}s` : null;
      const label = [turns, seconds].filter(Boolean).join(", ") || null;
      out.push(entry(at, "result", label, body, event.is_error === true));
      break;
    }
    default:
      break;
  }
  return out;
}

// Parses a slice of a log. Partial lines are the caller's problem: the runner returns whole lines.
export function parseTranscript(raw: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const stamped = DOCKER_TIMESTAMP.exec(line);
    const at = stamped ? stamped[1]! : null;
    const rest = stamped ? stamped[2]! : line;
    if (!rest.trim()) continue;
    if (rest.startsWith("{")) {
      let event: Record<string, unknown> | null = null;
      try {
        event = asRecord(JSON.parse(rest));
      } catch {
        event = null;
      }
      if (event && typeof event.type === "string") {
        out.push(...fromEvent(at, event));
        continue;
      }
    }
    out.push(entry(at, "log", null, rest));
  }
  return out;
}
