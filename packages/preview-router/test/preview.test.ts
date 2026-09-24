import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { COOKIE_NAME, cookieHeader, forwardHeaders, holdingPage, readCookie, safeNext, signInRedirect, verifyCookie, type PreviewCookie, type Route } from "../src/preview.js";

const secret = "test-secret";
const host = "k6u39mjg.kardboard.cc";
const route: Route = { host, target: "http://kardboard-preview-pv1:3000", status: "running", error: null, epoch: 3 };

function cookie(payload: Partial<PreviewCookie>, withSecret = secret): string {
  const body = Buffer.from(
    JSON.stringify({ host, board: "b1", user: "u1", epoch: 3, exp: Math.floor(Date.now() / 1000) + 600, ...payload }),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", withSecret).update(body).digest("base64url")}`;
}

describe("the preview cookie", () => {
  it("lets a member through on the host it was issued for", () => {
    assert.equal(verifyCookie(cookie({}), host, route, secret), true);
  });

  it("does not open a different preview host", () => {
    assert.equal(verifyCookie(cookie({}), "other.kardboard.cc", { ...route, host: "other.kardboard.cc" }, secret), false);
  });

  it("rejects a forged signature", () => {
    assert.equal(verifyCookie(cookie({}, "wrong-secret"), host, route, secret), false);
  });

  it("rejects an expired cookie", () => {
    assert.equal(verifyCookie(cookie({ exp: Math.floor(Date.now() / 1000) - 1 }), host, route, secret), false);
  });

  it("stops working once the board's membership changes", () => {
    assert.equal(verifyCookie(cookie({ epoch: 2 }), host, route, secret), false, "a cookie from before the change is refused");
    assert.equal(verifyCookie(cookie({ epoch: 4 }), host, route, secret), true, "a newer one still works");
  });

  it("refuses everything when no secret is configured", () => {
    assert.equal(verifyCookie(cookie({}), host, route, ""), false);
  });

  it("is host-only and unreadable from JavaScript", () => {
    const header = cookieHeader("value", 3600, true);
    assert.match(header, /^kardboard_preview=value; Path=\/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure$/);
    assert.ok(!header.includes("Domain="), "no Domain attribute, so siblings under the parent domain never see it");
  });

  it("is read out of a header that carries other cookies too", () => {
    assert.equal(readCookie(`other=1; ${COOKIE_NAME}=abc; third=2`), "abc");
    assert.equal(readCookie("other=1"), undefined);
  });
});

describe("what reaches branch-controlled code", () => {
  it("strips every kardboard credential before proxying", () => {
    const headers = forwardHeaders(
      { host, cookie: `${COOKIE_NAME}=abc; __session=clerk`, authorization: "Bearer secret", "proxy-authorization": "Basic x", "user-agent": "curl" },
      "kardboard-preview-pv1:3000",
    );
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["proxy-authorization"], undefined);
    assert.equal(headers.host, "kardboard-preview-pv1:3000", "the upstream sees its own host");
    assert.equal(headers["user-agent"], "curl", "ordinary headers are left alone");
  });
});

describe("the sign-in redirect", () => {
  it("sends an unauthenticated visitor to the app with the path they wanted", () => {
    assert.equal(
      signInRedirect("https://kardboard.cc", host, "/settings?tab=1"),
      "https://kardboard.cc/preview-auth?host=k6u39mjg.kardboard.cc&next=%2Fsettings%3Ftab%3D1",
    );
  });

  it("only ever returns to a path on the preview host", () => {
    assert.equal(safeNext("/deep/link"), "/deep/link");
    assert.equal(safeNext("//evil.example.com"), "/");
    assert.equal(safeNext("https://evil.example.com"), "/");
    assert.equal(safeNext(null), "/");
  });
});

describe("a preview that is not up", () => {
  it("holds the visitor with a refreshing page while it builds", () => {
    const { status, body } = holdingPage({ ...route, status: "building", target: null }, host);
    assert.equal(status, 503);
    assert.match(body, /http-equiv="refresh"/);
  });

  it("shows the build failure rather than a blank 502", () => {
    const { status, body } = holdingPage({ ...route, status: "failed", target: null, error: "Dockerfile is not in the branch" }, host);
    assert.equal(status, 502);
    assert.match(body, /Dockerfile is not in the branch/);
  });

  it("escapes what the build wrote into that page", () => {
    const { body } = holdingPage({ ...route, status: "failed", target: null, error: "<script>alert(1)</script>" }, host);
    assert.ok(!body.includes("<script>alert(1)</script>"));
    assert.match(body, /&lt;script&gt;/);
  });
});
