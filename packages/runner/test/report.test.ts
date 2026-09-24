import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deliverWithRetry, exitReportBody } from "../src/report.js";

const noWait = { wait: async () => {} };

describe("the exit report's body", () => {
  it("says the container ran out of memory when Docker says so", () => {
    assert.deepEqual(exitReportBody(137, { OOMKilled: true }), { exitCode: 137, oomKilled: true });
  });

  it("does not guess from the exit code alone", () => {
    assert.deepEqual(exitReportBody(137, { OOMKilled: false }), { exitCode: 137, oomKilled: false });
    assert.deepEqual(exitReportBody(137, null), { exitCode: 137, oomKilled: false }, "the container could not be inspected");
  });
});

describe("reporting an exit to the app", () => {
  it("keeps trying while the app is restarting, then stops once it answers", async () => {
    let calls = 0;
    const ok = await deliverWithRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return new Response(null, { status: 204 });
    }, noWait);
    assert.equal(ok, true);
    assert.equal(calls, 3);
  });

  it("retries a server error but not a refusal", async () => {
    const statuses = [502, 404];
    let calls = 0;
    const ok = await deliverWithRetry(async () => new Response(null, { status: statuses[calls++]! }), noWait);
    assert.equal(ok, false);
    assert.equal(calls, 2);
  });

  it("gives up after the last attempt", async () => {
    let calls = 0;
    const ok = await deliverWithRetry(async () => {
      calls++;
      throw new Error("down");
    }, { ...noWait, attempts: 4 });
    assert.equal(ok, false);
    assert.equal(calls, 4);
  });
});
