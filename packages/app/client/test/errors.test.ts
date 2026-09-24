import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, describeError, errorCode, NO_RESPONSE, shouldRetry } from "../src/lib/errors.js";

describe("errorCode", () => {
  it("takes the server's string code", () => {
    assert.equal(errorCode({ error: "conflict" }, 409), "conflict");
  });

  it("falls back to the status when the error is an object, as a validator sends it", () => {
    assert.equal(errorCode({ success: false, error: { issues: [] } }, 400), "http_400");
  });

  it("falls back to the status for an empty or missing body", () => {
    assert.equal(errorCode({}, 502), "http_502");
    assert.equal(errorCode(null, 500), "http_500");
    assert.equal(errorCode({ error: "  " }, 400), "http_400");
  });
});

describe("describeError", () => {
  it("never shows [object Object]", () => {
    const err = new ApiError(400, errorCode({ error: { issues: [] } }, 400), null);
    assert.equal(err.message, "Some of those values are not valid.");
  });

  it("keeps a sentence the server wrote for people", () => {
    assert.equal(describeError(409, "slug already in use"), "Slug already in use.");
    assert.equal(describeError(400, "Only cards in Review can be approved."), "Only cards in Review can be approved.");
  });

  it("translates known codes and statuses", () => {
    assert.equal(describeError(409, "conflict"), "Someone else changed this first.");
    assert.equal(describeError(413, "http_413"), "That file is too large.");
    assert.match(describeError(503, "http_503"), /server ran into a problem \(503\)/);
    assert.equal(describeError(418, "http_418"), "The request failed (418).");
  });
});

describe("shouldRetry", () => {
  it("retries a request that got no answer, and server errors", () => {
    assert.equal(shouldRetry(0, new ApiError(NO_RESPONSE, "network", null)), true);
    assert.equal(shouldRetry(1, new ApiError(502, "http_502", null)), true);
  });

  it("does not retry an answer like 401 or 403", () => {
    assert.equal(shouldRetry(0, new ApiError(401, "unauthenticated", null)), false);
    assert.equal(shouldRetry(0, new ApiError(403, "not_invited", null)), false);
  });

  it("stops at the limit", () => {
    assert.equal(shouldRetry(2, new ApiError(500, "http_500", null)), false);
  });
});
