import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { AUTH_CLAIM, CodexCredential, accountIdFrom, decodeJwt, expiryOf, needsRefresh, writeAuthFile, type CodexAuthFile } from "../src/codex-credential.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-codex-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A token shaped like the ones Codex stores: header, claims, signature we never check. */
function jwt(claims: Record<string, unknown>): string {
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.signature`;
}

let n = 0;
function authFile(auth: CodexAuthFile): string {
  const file = path.join(root, `auth-${n++}.json`);
  writeAuthFile(file, auth);
  return file;
}

describe("reading a sign-in file", () => {
  it("decodes the claims of a token", () => {
    assert.deepEqual(decodeJwt(jwt({ sub: "user-1" })), { sub: "user-1" });
  });

  it("treats anything that is not a token as having no claims", () => {
    for (const bad of [null, undefined, "", "not-a-jwt", "a.!!!.c"]) assert.equal(decodeJwt(bad), null);
  });

  it("takes the account id the file names", () => {
    assert.equal(accountIdFrom({ account_id: "acct-named", id_token: jwt({ [AUTH_CLAIM]: { chatgpt_account_id: "acct-claim" } }) }), "acct-named");
  });

  it("falls back to the account id inside the token, as Codex itself does", () => {
    assert.equal(accountIdFrom({ id_token: jwt({ [AUTH_CLAIM]: { chatgpt_account_id: "acct-claim" } }) }), "acct-claim");
    assert.equal(accountIdFrom({ access_token: jwt({ [AUTH_CLAIM]: { chatgpt_account_id: "acct-access" } }) }), "acct-access");
  });

  it("reports no account id rather than inventing one", () => {
    assert.equal(accountIdFrom(null), null);
    assert.equal(accountIdFrom({ access_token: jwt({ sub: "user-1" }) }), null);
  });

  it("reads the expiry off a token", () => {
    assert.equal(expiryOf(jwt({ exp: 1_800_000_000 })), 1_800_000_000);
    assert.equal(expiryOf(jwt({ sub: "no-exp" })), null);
  });
});

describe("deciding to refresh", () => {
  const now = 1_800_000_000;

  it("refreshes when there is no access token at all", () => {
    assert.equal(needsRefresh(null, now), true);
    assert.equal(needsRefresh({ refresh_token: "rt" }, now), true);
  });

  it("keeps a token that is comfortably in date", () => {
    assert.equal(needsRefresh({ access_token: jwt({ exp: now + 3600 }) }, now), false);
  });

  it("refreshes before expiry rather than at it, so a long turn does not expire mid-flight", () => {
    assert.equal(needsRefresh({ access_token: jwt({ exp: now + 299 }) }, now), true);
    assert.equal(needsRefresh({ access_token: jwt({ exp: now + 301 }) }, now), false);
  });

  it("refreshes an expired token", () => {
    assert.equal(needsRefresh({ access_token: jwt({ exp: now - 1 }) }, now), true);
  });

  it("leaves a token with no expiry for the upstream to judge", () => {
    assert.equal(needsRefresh({ access_token: "opaque-token" }, now), false);
  });
});

describe("handing out headers", () => {
  const now = 1_800_000_000;

  it("uses a valid token without spending the refresh token", async () => {
    const file = authFile({ tokens: { access_token: jwt({ exp: now + 3600, [AUTH_CLAIM]: { chatgpt_account_id: "acct-1" } }), refresh_token: "rt" } });
    let calls = 0;
    const credential = new CodexCredential(file, {
      now: () => now,
      fetchImpl: async () => {
        calls++;
        throw new Error("should not refresh");
      },
    });
    assert.deepEqual(await credential.headers(), { authorization: `Bearer ${jwt({ exp: now + 3600, [AUTH_CLAIM]: { chatgpt_account_id: "acct-1" } })}`, accountId: "acct-1" });
    assert.equal(calls, 0);
  });

  it("refreshes an expired token and reports the new one", async () => {
    const fresh = jwt({ exp: now + 3600, [AUTH_CLAIM]: { chatgpt_account_id: "acct-1" } });
    const file = authFile({ tokens: { access_token: jwt({ exp: now - 10 }), refresh_token: "rt-old" } });
    const credential = new CodexCredential(file, {
      now: () => now,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as Record<string, string>;
        assert.equal(body.grant_type, "refresh_token");
        assert.equal(body.refresh_token, "rt-old");
        return new Response(JSON.stringify({ access_token: fresh, refresh_token: "rt-new" }), { status: 200 });
      },
    });
    assert.deepEqual(await credential.headers(), { authorization: `Bearer ${fresh}`, accountId: "acct-1" });
  });

  it("writes the rotated refresh token back, so a restart is not stranded", async () => {
    const fresh = jwt({ exp: now + 3600 });
    const file = authFile({ tokens: { access_token: jwt({ exp: now - 10 }), refresh_token: "rt-old", account_id: "acct-1" } });
    const credential = new CodexCredential(file, {
      now: () => now,
      fetchImpl: async () => new Response(JSON.stringify({ access_token: fresh, refresh_token: "rt-new" }), { status: 200 }),
    });
    await credential.headers();
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as CodexAuthFile;
    assert.equal(saved.tokens?.refresh_token, "rt-new");
    assert.equal(saved.tokens?.access_token, fresh);
    assert.equal(saved.tokens?.account_id, "acct-1", "fields the refresh does not return are kept");
    assert.equal(saved.last_refresh, new Date(now * 1000).toISOString());
  });

  it("keeps the old refresh token when the endpoint does not rotate it", async () => {
    const file = authFile({ tokens: { access_token: jwt({ exp: now - 10 }), refresh_token: "rt-old" } });
    const credential = new CodexCredential(file, {
      now: () => now,
      fetchImpl: async () => new Response(JSON.stringify({ access_token: jwt({ exp: now + 3600 }) }), { status: 200 }),
    });
    await credential.headers();
    assert.equal((JSON.parse(fs.readFileSync(file, "utf8")) as CodexAuthFile).tokens?.refresh_token, "rt-old");
  });

  it("spends the refresh token once when Sessions arrive together", async () => {
    const file = authFile({ tokens: { access_token: jwt({ exp: now - 10 }), refresh_token: "rt" } });
    let calls = 0;
    const credential = new CodexCredential(file, {
      now: () => now,
      fetchImpl: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return new Response(JSON.stringify({ access_token: jwt({ exp: now + 3600 }) }), { status: 200 });
      },
    });
    const all = await Promise.all([credential.headers(), credential.headers(), credential.headers()]);
    assert.equal(calls, 1);
    assert.equal(new Set(all.map((h) => h.authorization)).size, 1);
  });

  it("picks up a file the Admin refreshed out of band instead of refreshing again", async () => {
    const file = authFile({ tokens: { access_token: jwt({ exp: now - 10 }), refresh_token: "rt" } });
    const credential = new CodexCredential(file, {
      now: () => now,
      fetchImpl: async () => {
        throw new Error("should not refresh");
      },
    });
    writeAuthFile(file, { tokens: { access_token: jwt({ exp: now + 3600 }), refresh_token: "rt" } });
    assert.equal((await credential.headers()).authorization.startsWith("Bearer "), true);
  });

  it("reports a refusal from the token endpoint", async () => {
    const file = authFile({ tokens: { access_token: jwt({ exp: now - 10 }), refresh_token: "rt" } });
    const credential = new CodexCredential(file, {
      now: () => now,
      fetchImpl: async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    });
    await assert.rejects(credential.headers(), /codex token refresh failed: 400/);
  });

  it("does not retry forever on one failure: the next call tries again", async () => {
    const file = authFile({ tokens: { access_token: jwt({ exp: now - 10 }), refresh_token: "rt" } });
    let calls = 0;
    const credential = new CodexCredential(file, {
      now: () => now,
      fetchImpl: async () => {
        calls++;
        return calls === 1 ? new Response("nope", { status: 500 }) : new Response(JSON.stringify({ access_token: jwt({ exp: now + 3600 }) }), { status: 200 });
      },
    });
    await assert.rejects(credential.headers());
    assert.equal((await credential.headers()).authorization.startsWith("Bearer "), true);
    assert.equal(calls, 2);
  });

  it("refuses when the file has no refresh token to spend", async () => {
    const file = authFile({ tokens: { access_token: jwt({ exp: now - 10 }) } });
    const credential = new CodexCredential(file, { now: () => now });
    await assert.rejects(credential.headers(), /no refresh token/);
  });
});
