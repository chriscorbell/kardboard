import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTranscript } from "../src/services/transcript.js";

const STAMP = "2026-09-14T23:51:14.271000000Z";

function stamped(event: unknown): string {
  return `${STAMP} ${JSON.stringify(event)}\n`;
}

describe("plain lines", () => {
  it("keeps the entrypoint's own output, with its time", () => {
    const [line] = parseTranscript(`${STAMP} [session abc] cloning https://github.com/x/y\n`);
    assert.equal(line?.kind, "log");
    assert.equal(line?.body, "[session abc] cloning https://github.com/x/y");
    assert.equal(line?.at, STAMP);
  });

  it("keeps a line that has no timestamp", () => {
    const [line] = parseTranscript("Cloning into 'repo'...\n");
    assert.equal(line?.kind, "log");
    assert.equal(line?.at, null);
  });

  it("drops blank lines", () => {
    assert.deepEqual(parseTranscript("\n   \n"), []);
  });

  it("keeps JSON that is not a session event as a log line", () => {
    const entries = parseTranscript(`${STAMP} {"hello":"world"}\n${STAMP} {not json\n`);
    assert.deepEqual(entries.map((e) => e.kind), ["log", "log"]);
    assert.equal(entries[0]?.body, '{"hello":"world"}');
  });
});

describe("claude code events", () => {
  it("opens with the model and tool count", () => {
    const [line] = parseTranscript(stamped({ type: "system", subtype: "init", model: "claude-opus-5", tools: ["Bash", "Read"] }));
    assert.equal(line?.kind, "system");
    assert.equal(line?.label, "started");
    assert.equal(line?.body, "claude-opus-5, 2 tools");
  });

  it("drops the running token counters", () => {
    assert.deepEqual(parseTranscript(stamped({ type: "system", subtype: "thinking_tokens", estimated_tokens: 12 })), []);
  });

  it("splits an assistant message into its blocks", () => {
    const entries = parseTranscript(
      stamped({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "weighing it up", signature: "secret-artefact" },
            { type: "text", text: "Reading the schema." },
            { type: "tool_use", name: "Read", input: { file_path: "server/src/db/schema.ts" } },
          ],
        },
      }),
    );
    assert.deepEqual(
      entries.map((e) => [e.kind, e.label, e.body]),
      [
        ["thinking", null, "weighing it up"],
        ["text", null, "Reading the schema."],
        ["tool", "Read", "server/src/db/schema.ts"],
      ],
    );
  });

  it("never carries a thinking signature through", () => {
    const [line] = parseTranscript(stamped({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hm", signature: "EpsDCrIBCBEYAipA" }] } }));
    assert.equal(line?.body, "hm");
    assert.ok(!JSON.stringify(line).includes("EpsDCrIBCBEYAipA"));
  });

  it("summarises a tool call by what it acts on", () => {
    const [bash] = parseTranscript(stamped({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm -r test", description: "run tests" } }] } }));
    assert.equal(bash?.body, "pnpm -r test");
    const [other] = parseTranscript(stamped({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__kardboard__move_card", input: { column: "review" } }] } }));
    assert.equal(other?.body, '{"column":"review"}');
  });

  it("reads a tool result out of its content blocks", () => {
    const [ok] = parseTranscript(stamped({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "3 files changed" }] }] } }));
    assert.equal(ok?.kind, "tool_result");
    assert.equal(ok?.body, "3 files changed");
    assert.equal(ok?.isError, false);
    const [bad] = parseTranscript(stamped({ type: "user", message: { content: [{ type: "tool_result", content: "exit 1", is_error: true }] } }));
    assert.equal(bad?.body, "exit 1");
    assert.equal(bad?.isError, true);
  });

  it("closes with the result, its turns and its duration", () => {
    const [line] = parseTranscript(stamped({ type: "result", subtype: "success", result: "Opened pull request #9.", num_turns: 12, duration_ms: 91_400, is_error: false }));
    assert.equal(line?.kind, "result");
    assert.equal(line?.label, "12 turns, 91s");
    assert.equal(line?.body, "Opened pull request #9.");
  });

  it("marks a failed result", () => {
    const [line] = parseTranscript(stamped({ type: "result", subtype: "error_during_execution", is_error: true }));
    assert.equal(line?.isError, true);
    assert.equal(line?.body, "error_during_execution");
  });

  it("ignores event types it does not know", () => {
    assert.deepEqual(parseTranscript(stamped({ type: "stream_event", event: { type: "content_block_delta" } })), []);
  });
});

describe("length", () => {
  it("clips a long body and says so", () => {
    const [line] = parseTranscript(stamped({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(9_000) }] } }));
    assert.equal(line?.truncated, true);
    assert.equal(line?.body.length, 8_000);
  });

  it("leaves a short body alone", () => {
    const [line] = parseTranscript(stamped({ type: "assistant", message: { content: [{ type: "text", text: "short" }] } }));
    assert.equal(line?.truncated, false);
  });
});
