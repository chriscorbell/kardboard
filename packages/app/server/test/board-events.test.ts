import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

// A Board's live event stream, read the way the browser reads it. It pings to stay open, every few
// milliseconds in these tests instead of every 25 s. Dev authentication signs the tests in as the User.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-board-events-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_EVENTS_PING_MS = "20";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOARD = "board-1";

beforeEach(async () => {
  for (const t of [schema.events, schema.cards, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-one", name: "Board one" });
  await db.insert(schema.users).values({ id: "user", email: "root@example.com", name: "Root" });
});

// A stream left open would keep pinging, and the test run would never exit.
const open: ReadableStreamDefaultReader<Uint8Array>[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((reader) => reader.cancel().catch(() => {})));
});

function call(method: string, url: string, body?: unknown) {
  return api.request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const until = (ms: number) => new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));

// Opens the stream and reads it in the background: `text` is everything received so far, and `ended`
// settles when the server ends the response.
async function watch() {
  const res = await call("GET", "/boards/board-one/events");
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  open.push(reader);
  const decoder = new TextDecoder();
  const seen = { text: "" };
  const ended = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return "ended" as const;
      seen.text += decoder.decode(value);
    }
  })();
  return { seen, ended, pings: () => seen.text.split("event: ping").length - 1 };
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("timed out");
    await until(5);
  }
}

describe("a board's event stream", () => {
  it("stays open, pinging", async () => {
    const stream = await watch();
    await waitFor(() => stream.pings() >= 3);
    assert.equal(await Promise.race([stream.ended, until(60)]), "timeout");
  });

  it("carries a change made on the Board", async () => {
    const stream = await watch();
    await waitFor(() => stream.seen.text.includes("event: ready"));
    assert.equal((await call("POST", "/boards/board-one/cards", { title: "Seen live" })).status, 201);
    await waitFor(() => stream.seen.text.includes("event: card.upserted"));
    assert.match(stream.seen.text, /"title":"Seen live"/);
  });
});
