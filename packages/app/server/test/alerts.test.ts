import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";

// The database module opens its file at import time, so point it at a scratch directory first. With
// no Resend key an email is logged and marked as such, which is enough to count them.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-alerts-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";
process.env.KARDBOARD_PUBLIC_URL = "https://kardboard.test";
process.env.RESEND_API_KEY = "";
process.env.KARDBOARD_RUNNER_TOKEN = "control-token";

// A stand-in egress proxy whose `/limits` answer each test sets.
let limitsBody: unknown = { claude: null, codex: null };
let limitsStatus = 200;
const egress = http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer control-token") {
    res.writeHead(401).end();
    return;
  }
  res.writeHead(limitsStatus, { "content-type": "application/json" });
  res.end(JSON.stringify(limitsBody));
});
await new Promise<void>((resolve) => egress.listen(0, "127.0.0.1", resolve));
process.env.KARDBOARD_EGRESS_URL = `http://127.0.0.1:${(egress.address() as AddressInfo).port}`;

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { alertAdmin, ALERT_DEDUPE_MS } = await import("../src/services/alerts.js");
const { checkEgress, egressAlerts, nextRunnerHealth, runnerAlert, RUNNER_DOWN_ALERT_MS, EGRESS_RECENT_MS } = await import("../src/services/monitor.js");
const { readEgressStatus, readProviderLimits } = await import("../src/services/provider-limits.js");
const { api } = await import("../src/routes/api.js");

await runMigrations();
after(() => {
  egress.closeAllConnections();
  egress.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const t of [schema.outboundEmails, schema.settings, schema.users]) await db.delete(t);
  await db.insert(schema.users).values([
    { id: "admin", email: "root@example.com", handle: "root", name: "Root", role: "admin", status: "active" },
    { id: "admin-2", email: "second@example.com", handle: "second", name: "Second", role: "admin", status: "active" },
    { id: "invited-admin", email: "later@example.com", handle: "later", name: "Later", role: "admin", status: "invited" },
    { id: "revoked-admin", email: "gone@example.com", handle: "gone", name: "Gone", role: "admin", status: "revoked" },
    { id: "ada", email: "ada@example.com", handle: "ada", name: "Ada", role: "member", status: "active" },
  ]);
  limitsBody = { claude: null, codex: null };
  limitsStatus = 200;
});

async function recipients(): Promise<string[]> {
  return (await db.select().from(schema.outboundEmails)).map((e) => e.toUserId).sort();
}

const NOW = new Date("2026-09-24T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("alertAdmin", () => {
  it("emails every active Admin and nobody else", async () => {
    assert.equal(await alertAdmin({ key: "test.one", subject: "Something broke", body: "Details." }, NOW), true);
    assert.deepEqual(await recipients(), ["admin", "admin-2"]);
    const email = (await db.select().from(schema.outboundEmails).where(eq(schema.outboundEmails.toUserId, "admin")).get())!;
    assert.equal(email.subject, "kardboard: Something broke");
    assert.match(email.html, /Details\./);
    assert.match(email.html, /https:\/\/kardboard\.test\/admin/);
  });

  it("sends the same key once in six hours, and again after", async () => {
    assert.equal(await alertAdmin({ key: "test.repeat", subject: "A", body: "a" }, NOW), true);
    assert.equal(await alertAdmin({ key: "test.repeat", subject: "A", body: "a" }, later(60_000)), false);
    assert.equal(await alertAdmin({ key: "test.repeat", subject: "A", body: "a" }, later(ALERT_DEDUPE_MS - 1)), false);
    assert.equal(await alertAdmin({ key: "test.other", subject: "B", body: "b" }, later(60_000)), true, "another key is another alert");
    assert.equal(await alertAdmin({ key: "test.repeat", subject: "A", body: "a" }, later(ALERT_DEDUPE_MS)), true);
    assert.equal((await recipients()).length, 6);
  });

  it("remembers what it sent in the database, so a restart does not send it again", async () => {
    await alertAdmin({ key: "test.persisted", subject: "A", body: "a" }, NOW);
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, "alert:test.persisted")).get();
    assert.equal(row?.value, NOW.toISOString());
  });

  it("gives the slot back when the emails could not be queued, so the next occurrence tries again", async () => {
    const insert = db.insert.bind(db);
    let failing = true;
    // Queueing an email is an insert into outbound_emails; fail that one, leave the claim alone.
    (db as { insert: unknown }).insert = ((table: unknown) => {
      if (failing && table === schema.outboundEmails) throw new Error("disk full");
      return insert(table as typeof schema.settings);
    }) as unknown;
    try {
      await assert.rejects(alertAdmin({ key: "test.retry", subject: "A", body: "a" }, NOW), /disk full/);
      assert.equal(await db.select().from(schema.settings).where(eq(schema.settings.key, "alert:test.retry")).get(), undefined);
      failing = false;
      assert.equal(await alertAdmin({ key: "test.retry", subject: "A", body: "a" }, later(1_000)), true);
    } finally {
      (db as { insert: unknown }).insert = insert;
    }
  });

  it("sends once when two callers race on one key", async () => {
    const results = await Promise.all([1, 2, 3].map(() => alertAdmin({ key: "test.race", subject: "A", body: "a" }, NOW)));
    assert.deepEqual(results.filter(Boolean).length, 1);
    assert.equal((await recipients()).length, 2);
  });
});

describe("the runner check", () => {
  it("alerts only once the runner has been down for five minutes, counted from the first failure", () => {
    let health = nextRunnerHealth({ state: "unknown", downSince: null, error: null, checkedAt: null }, "ECONNREFUSED", NOW);
    assert.equal(health.downSince, NOW.toISOString());
    assert.equal(runnerAlert(health, NOW), null);
    health = nextRunnerHealth(health, "ECONNREFUSED", later(RUNNER_DOWN_ALERT_MS - 1_000));
    assert.equal(health.downSince, NOW.toISOString(), "a second failure does not restart the clock");
    assert.equal(runnerAlert(health, later(RUNNER_DOWN_ALERT_MS - 1_000)), null);
    const alert = runnerAlert(health, later(RUNNER_DOWN_ALERT_MS));
    assert.equal(alert?.key, "runner.unreachable");
    assert.match(alert?.body ?? "", /ECONNREFUSED/);
  });

  it("forgets the outage as soon as the runner answers", () => {
    const down = nextRunnerHealth({ state: "unknown", downSince: null, error: null, checkedAt: null }, "answered 503: docker unreachable", NOW);
    const up = nextRunnerHealth(down, null, later(10 * 60_000));
    assert.deepEqual({ state: up.state, downSince: up.downSince }, { state: "up", downSince: null });
    assert.equal(runnerAlert(up, later(10 * 60_000)), null);
  });
});

describe("what the egress proxy saw", () => {
  const reachable = (overrides: { authFailure?: { at: string; status: number | null; reason: string }; last?: { at: string; provider: "claude" | "codex"; method: string; path: string } }) => ({
    egress: "reachable" as const,
    checkedAt: NOW.toISOString(),
    limits: { claude: null, codex: null },
    providers: [
      { provider: "claude" as const, credentialLoaded: true, limit: null, authFailure: overrides.authFailure ?? null },
      { provider: "codex" as const, credentialLoaded: false, limit: null, authFailure: null },
    ],
    refusals: { count: overrides.last ? 3 : 0, last: overrides.last ?? null },
  });

  it("alerts on a rejected credential and a refused call that are recent, per provider", () => {
    const alerts = egressAlerts(
      reachable({
        authFailure: { at: NOW.toISOString(), status: 401, reason: "POST /v1/messages answered 401" },
        last: { at: NOW.toISOString(), provider: "claude", method: "POST", path: "/v1/files" },
      }),
      later(60_000),
    );
    assert.deepEqual(
      alerts.map((a) => a.key),
      ["egress.auth.claude", "egress.refused.claude"],
    );
    assert.match(alerts[0]!.body, /claude setup-token/);
    assert.match(alerts[1]!.body, /POST \/v1\/files/);
    assert.match(alerts[1]!.body, /3 refused/);
  });

  it("quotes a refused path as code, so a Session cannot put a link in the Admin's email", () => {
    const [alert] = egressAlerts(reachable({ last: { at: NOW.toISOString(), provider: "claude", method: "GET", path: "/v1/[Your token was revoked, sign in again](https://evil.example/login)" } }), later(60_000));
    assert.ok(alert);
    assert.doesNotMatch(alert.body, /\]\(https/);
    assert.match(alert.body, /`GET \/v1\/Your token was revoked, sign in againhttps:\/\/evil.example\/login`/);
  });

  it("stays quiet about events older than two polls, and about a proxy it could not read", () => {
    const old = new Date(NOW.getTime() - EGRESS_RECENT_MS - 1_000).toISOString();
    assert.deepEqual(egressAlerts(reachable({ authFailure: { at: old, status: 401, reason: "x" }, last: { at: old, provider: "codex", method: "GET", path: "/wham" } }), NOW), []);
    assert.deepEqual(egressAlerts({ ...reachable({ authFailure: { at: NOW.toISOString(), status: 401, reason: "x" } }), egress: "unreachable" }, NOW), []);
  });

  it("reads the proxy's full report, and an older proxy's limits-only answer as nothing seen", async () => {
    const at = new Date().toISOString();
    limitsBody = {
      claude: { at, until: null },
      codex: null,
      authFailures: { claude: null, codex: { at, status: 401, reason: "the sign-in file could not be read or refreshed" } },
      refusals: { count: 2, last: { at, provider: "codex", method: "GET", path: "/wham/usage" } },
      credentials: { claude: true, codex: true },
    };
    const status = await readEgressStatus();
    assert.equal(status.egress, "reachable");
    assert.deepEqual(status.limits, { claude: { at, until: null }, codex: null });
    assert.equal(status.providers.find((p) => p.provider === "codex")?.authFailure?.status, 401);
    assert.equal(status.providers.find((p) => p.provider === "claude")?.credentialLoaded, true);
    assert.equal(status.refusals.count, 2);
    assert.deepEqual(await readProviderLimits(), { claude: { at, until: null }, codex: null }, "fallback reads the same answer");

    limitsBody = { claude: null, codex: null };
    const old = await readEgressStatus();
    assert.equal(old.egress, "reachable");
    assert.deepEqual(
      old.providers.map((p) => [p.credentialLoaded, p.authFailure]),
      [
        [null, null],
        [null, null],
      ],
    );

    // A report fallback does not need, gone wrong, leaves the limits fallback does need.
    limitsBody = { claude: { at, until: null }, codex: null, authFailures: "garbled", refusals: { count: "many" } };
    const garbled = await readEgressStatus();
    assert.equal(garbled.egress, "reachable");
    assert.deepEqual(garbled.limits, { claude: { at, until: null }, codex: null });
    assert.equal(garbled.refusals.count, 0);

    limitsStatus = 500;
    assert.equal((await readEgressStatus()).egress, "unreachable");
  });

  it("emails the Admin from a poll, once", async () => {
    const at = new Date().toISOString();
    limitsBody = { claude: null, codex: null, authFailures: { claude: { at, status: 403, reason: "POST /v1/messages answered 403" }, codex: null }, refusals: { count: 0, last: null } };
    await checkEgress();
    await checkEgress();
    assert.deepEqual(await recipients(), ["admin", "admin-2"]);
    assert.match((await db.select().from(schema.outboundEmails).get())!.subject, /Claude Code rejected its credential/);
  });

  it("is served to the Admin, and only the Admin, on /api/admin/limits", async () => {
    const at = new Date().toISOString();
    limitsBody = { claude: { at, until: null }, codex: null, credentials: { claude: true, codex: false } };
    const res = await api.request("/admin/limits", { headers: { "x-dev-user": "root@example.com" } });
    assert.equal(res.status, 200);
    const view = (await res.json()) as { egress: string; providers: { provider: string; limit: unknown; credentialLoaded: boolean | null }[]; limits?: unknown };
    assert.equal(view.egress, "reachable");
    assert.deepEqual(view.providers[0], { provider: "claude", credentialLoaded: true, limit: { at, until: null }, authFailure: null });
    assert.equal(view.limits, undefined);
    assert.equal((await api.request("/admin/limits", { headers: { "x-dev-user": "ada@example.com" } })).status, 403);
  });
});
