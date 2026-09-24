import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconnectDelay } from "../src/lib/backoff.js";

describe("reconnectDelay", () => {
  it("doubles from one second", () => {
    const top = () => 1;
    assert.deepEqual([0, 1, 2, 3].map((n) => reconnectDelay(n, top)), [1_000, 2_000, 4_000, 8_000]);
  });

  it("caps at thirty seconds", () => {
    assert.equal(reconnectDelay(12, () => 1), 30_000);
  });

  it("spreads reconnects by up to a fifth", () => {
    assert.equal(reconnectDelay(0, () => 0), 800);
    assert.equal(reconnectDelay(5, () => 0), 24_000);
  });
});
