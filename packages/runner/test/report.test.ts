import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deliverWithRetry } from "../src/report.js";

const noWait = { wait: async () => {} };

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
