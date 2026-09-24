import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type { AdminSessionSummary, AdminSessionsPage, UsageTotalsView } from "@kardboard/shared";

// The database module opens its file at import time, so point it at a scratch directory first. Any
// runner URL puts the client in http mode; the one call usage makes, `logSlice`, is replaced below.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-usage-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_TRIGGER_COALESCE_MS = "600000";
process.env.KARDBOARD_RUNNER_URL = "http://runner.invalid";
process.env.KARDBOARD_RUNNER_TOKEN = "test-runner-token";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { runner } = await import("../src/services/runner-client.js");
const { recordSessionUsage, usageFromLog, usageTotals } = await import("../src/services/usage.js");
const { listAdminSessions } = await import("../src/services/admin-sessions.js");
const { endSession } = await import("../src/services/orchestrator.js");
const { api } = await import("../src/routes/api.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

// Lines as the runner writes them: a Docker timestamp, then what the container printed. The
// `result` event is Claude Code's stream-json summary of the whole run, last thing before it exits.
const stamp = (s: number) => `2026-09-24T12:00:${String(s).padStart(2, "0")}.123456789Z`;
const INIT = `${stamp(0)} {"type":"system","subtype":"init","model":"claude-opus-4-1","tools":["Bash","Read"]}`;
const ASSISTANT = `${stamp(5)} {"type":"assistant","message":{"content":[{"type":"text","text":"Reading the card."}],"usage":{"input_tokens":3,"output_tokens":9}}}`;
const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 184_233,
  duration_api_ms: 170_002,
  num_turns: 23,
  result: "Opened pull request #41.",
  session_id: "a2b1",
  total_cost_usd: 1.8432,
  usage: { input_tokens: 41, cache_creation_input_tokens: 51_210, cache_read_input_tokens: 1_204_775, output_tokens: 9_804, service_tier: "standard" },
  modelUsage: {
    "claude-opus-4-1": { inputTokens: 41, outputTokens: 9_804, cacheReadInputTokens: 1_204_775, cacheCreationInputTokens: 51_210, webSearchRequests: 0, costUSD: 1.83 },
    "claude-3-5-haiku": { inputTokens: 1_200, outputTokens: 80, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.0132 },
  },
};
const RESULT_LINE = `${stamp(9)} ${JSON.stringify(RESULT)}`;

describe("reading usage from a log", () => {
  it("sums the per-model usage of the last result event, with cost, turns, and duration", () => {
    assert.deepEqual(usageFromLog([INIT, ASSISTANT, RESULT_LINE, ""].join("\n")), {
      inputTokens: 1_241,
      outputTokens: 9_884,
      cacheReadTokens: 1_204_775,
      cacheCreationTokens: 51_210,
      costUsd: 1.8432,
      numTurns: 23,
      durationMs: 184_233,
    });
  });

  it("falls back to the top-level usage when there is no per-model breakdown", () => {
    const { modelUsage: _, ...plain } = RESULT;
    const usage = usageFromLog(`${INIT}\n${stamp(9)} ${JSON.stringify(plain)}\n`);
    assert.deepEqual(usage && [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens], [41, 9_804, 1_204_775, 51_210]);
  });

  it("reads an error result too, which still used tokens", () => {
    const failed = { ...RESULT, subtype: "error_max_turns", is_error: true, total_cost_usd: 0.25 };
    assert.equal(usageFromLog(`${stamp(9)} ${JSON.stringify(failed)}`)?.costUsd, 0.25);
  });

  it("finds nothing in a log with no result event, or in Codex's plain text", () => {
    assert.equal(usageFromLog([INIT, ASSISTANT].join("\n")), null);
    assert.equal(usageFromLog(`${stamp(1)} [kardboard] starting codex\n${stamp(2)} tokens used: 12,345\n`), null);
    assert.equal(usageFromLog(`${stamp(1)} {"type":"result",`), null, "a line cut short is not an event");
  });
});

const BOARD = "board-1";
const OTHER = "board-2";

beforeEach(async () => {
  for (const t of [schema.sessions, schema.cards, schema.boards, schema.users]) await db.delete(t);
  await db.insert(schema.boards).values([
    { id: BOARD, slug: "board-one", name: "Board one" },
    { id: OTHER, slug: "board-two", name: "Board two" },
  ]);
  await db.insert(schema.users).values([
    { id: "admin", email: "root@example.com", handle: "root", name: "Root", role: "admin", status: "active" },
    { id: "ada", email: "ada@example.com", handle: "ada", name: "Ada", role: "member", status: "active" },
  ]);
  await db.insert(schema.cards).values({ id: "card-1", boardId: BOARD, title: "Fix the login page" });
});

type SessionRow = typeof schema.sessions.$inferInsert;
async function session(id: string, fields: Partial<SessionRow> = {}): Promise<void> {
  await db.insert(schema.sessions).values({ id, boardId: BOARD, cardId: "card-1", provider: "claude", status: "succeeded", ...fields });
}

async function usageRow(id: string) {
  return (await db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get())!;
}

describe("recording a Session's usage when it ends", () => {
  it("waits for the result line the runner has not written yet, then stores it on the row", async () => {
    await session("s-late");
    let reads = 0;
    runner.logSlice = async () => {
      reads++;
      const text = reads < 3 ? `${INIT}\n${ASSISTANT}\n` : `${INIT}\n${ASSISTANT}\n${RESULT_LINE}\n`;
      return { exists: true, size: text.length, offset: 0, nextOffset: text.length, text, skipped: false };
    };
    await recordSessionUsage("s-late", { waitMs: 1 });
    assert.equal(reads, 3);
    const row = await usageRow("s-late");
    assert.deepEqual([row.inputTokens, row.outputTokens, row.costUsd, row.numTurns, row.durationMs], [1_241, 9_884, 1.8432, 23, 184_233]);
  });

  it("records nothing for a Codex Session, and does not read its log", async () => {
    await session("s-codex", { provider: "codex" });
    let reads = 0;
    runner.logSlice = async () => {
      reads++;
      return { exists: true, size: 0, offset: 0, nextOffset: 0, text: RESULT_LINE, skipped: false };
    };
    await recordSessionUsage("s-codex", { waitMs: 1 });
    assert.equal(reads, 0);
    assert.equal((await usageRow("s-codex")).inputTokens, null);
  });

  it("is started by the Session's end, which does not wait for it", async () => {
    await session("s-ended", { status: "running", startedAt: new Date().toISOString() });
    const text = `${INIT}\n${RESULT_LINE}\n`;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    runner.logSlice = async () => {
      await held;
      return { exists: true, size: text.length, offset: 0, nextOffset: text.length, text, skipped: false };
    };
    await endSession("s-ended", "succeeded", "Container exited cleanly.");
    assert.equal((await usageRow("s-ended")).status, "succeeded");
    assert.equal((await usageRow("s-ended")).costUsd, null, "the end did not wait on the log");
    release();
    for (let i = 0; i < 50 && (await usageRow("s-ended")).costUsd === null; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await usageRow("s-ended")).costUsd, 1.8432);
  });

  it("looks once at a Session that was stopped, and stops at a log that does not exist", async () => {
    await session("s-cancelled", { status: "cancelled" });
    await session("s-never", { status: "failed" });
    let reads = 0;
    runner.logSlice = async (id) => {
      reads++;
      const text = `${INIT}\n`;
      return id === "s-never" ? { exists: false, size: 0, offset: 0, nextOffset: 0, text: "", skipped: false } : { exists: true, size: text.length, offset: 0, nextOffset: text.length, text, skipped: false };
    };
    await recordSessionUsage("s-cancelled", { waitMs: 1 });
    assert.equal(reads, 1);
    await recordSessionUsage("s-never", { waitMs: 1 });
    assert.equal(reads, 2);
    assert.equal((await usageRow("s-cancelled")).costUsd, null);
  });
});

function call(as: string, url: string) {
  return api.request(url, { headers: { "x-dev-user": as } });
}

describe("per-Board totals", () => {
  it("adds up the last 30 days by Board, costliest first, counting Sessions that reported nothing", async () => {
    const now = new Date("2026-09-24T12:00:00.000Z");
    await session("a", { createdAt: "2026-09-20T00:00:00.000Z", inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, costUsd: 0.5 });
    await session("b", { createdAt: "2026-09-21T00:00:00.000Z", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, costUsd: 0.25 });
    await session("c", { createdAt: "2026-09-22T00:00:00.000Z", provider: "codex" });
    await session("old", { createdAt: "2026-08-01T00:00:00.000Z", inputTokens: 999, costUsd: 99 });
    await session("d", { boardId: OTHER, cardId: null, kind: "sweep", createdAt: "2026-09-23T00:00:00.000Z", inputTokens: 5, outputTokens: 5, cacheReadTokens: 5, cacheCreationTokens: 5, costUsd: 2 });

    const totals = await usageTotals(30, now);
    assert.equal(totals.since, "2026-08-25T12:00:00.000Z");
    assert.deepEqual(
      totals.boards.map((b) => [b.boardId, b.sessions, b.measured, b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens, b.costUsd]),
      [
        [OTHER, 1, 1, 20, 2],
        [BOARD, 3, 2, 110, 0.75],
      ],
    );

    const res = await call("root@example.com", "/admin/usage?days=7");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as UsageTotalsView).days, 7);
    assert.equal((await call("ada@example.com", "/admin/usage")).status, 403);
  });
});

describe("the Admin's Sessions list", () => {
  async function page(query = ""): Promise<AdminSessionsPage> {
    const res = await call("root@example.com", `/admin/sessions${query}`);
    assert.equal(res.status, 200);
    return (await res.json()) as AdminSessionsPage;
  }

  it("carries the Card's title and the recorded usage", async () => {
    await session("with-usage", { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, costUsd: 0.01, numTurns: 2, durationMs: 900 });
    await session("sweep", { boardId: OTHER, cardId: null, kind: "sweep" });
    const { sessions } = await page();
    const withUsage = sessions.find((s) => s.id === "with-usage")!;
    assert.equal(withUsage.cardTitle, "Fix the login page");
    assert.equal(withUsage.boardId, BOARD);
    assert.deepEqual(withUsage.usage, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, costUsd: 0.01, numTurns: 2, durationMs: 900 });
    const sweep = sessions.find((s) => s.id === "sweep")!;
    assert.equal(sweep.cardTitle, null);
    assert.equal(sweep.usage, null);
  });

  it("filters by Board, status, and kind, with `active` for everything still holding a Claim", async () => {
    await session("running", { status: "running" });
    await session("queued", { status: "queued" });
    await session("failed", { status: "failed" });
    await session("other-board", { boardId: OTHER, cardId: null, kind: "sweep", status: "running" });
    const ids = (p: AdminSessionsPage) => p.sessions.map((s) => s.id).sort();
    assert.deepEqual(ids(await page(`?board=${OTHER}`)), ["other-board"]);
    assert.deepEqual(ids(await page("?status=failed")), ["failed"]);
    assert.deepEqual(ids(await page("?status=active")), ["other-board", "queued", "running"]);
    assert.deepEqual(ids(await page(`?status=active&board=${BOARD}&kind=card`)), ["queued", "running"]);
    assert.deepEqual(ids(await page("?kind=sweep")), ["other-board"]);
    assert.equal((await page("?status=nonsense")).sessions.length, 4, "an unknown value filters nothing");
  });

  it("pages newest first, fifty at a time, without skipping Sessions created in the same instant", async () => {
    const createdAt = "2026-09-24T10:00:00.000Z";
    for (let i = 0; i < 120; i++) {
      // Forty share one timestamp, so only the id orders them.
      await session(`s-${String(i).padStart(3, "0")}`, { createdAt: i < 40 ? createdAt : new Date(Date.parse(createdAt) + i * 1000).toISOString() });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const next: AdminSessionsPage = await page(cursor ? `?before=${cursor}` : "");
      pages++;
      seen.push(...next.sessions.map((s) => s.id));
      cursor = next.nextCursor;
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(seen.length, 120);
    assert.equal(new Set(seen).size, 120);
    assert.equal(seen[0], "s-119");
    assert.equal(seen[119], "s-000");
  });

  it("finds one Session by id for a link to it, and 404s an unknown one", async () => {
    await session("linked");
    const res = await call("root@example.com", "/admin/sessions/linked");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as AdminSessionSummary).cardTitle, "Fix the login page");
    assert.equal((await call("root@example.com", "/admin/sessions/nope")).status, 404);
    assert.equal((await call("ada@example.com", "/admin/sessions/linked")).status, 403);
    assert.equal((await listAdminSessions({ boardId: OTHER })).sessions.length, 0);
  });
});
