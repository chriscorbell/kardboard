import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { signJwt } from "@clerk/backend/jwt";

// Which User a Clerk sign-in becomes, and how its session token is checked. Nothing here calls Clerk:
// the profile is what `fetchUser` would have read, and tokens are signed with a key made here.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-clerk-sign-in-"));
const instanceKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "clerk";
process.env.KARDBOARD_PUBLIC_URL = "https://kardboard.test";
process.env.KARDBOARD_ADMIN_EMAIL = "root@example.com";
// On one line with `\n` escapes, the way an env file tends to hold a PEM.
process.env.CLERK_JWT_KEY = instanceKey.publicKey.trim().replace(/\n/g, "\\n");

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { env } = await import("../src/env.js");
const { ensureSeed } = await import("../src/seed.js");
const { activateFromClerk } = await import("../src/services/users.js");
const { signInEmail, verifySessionToken } = await import("../src/auth.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(async () => {
  await db.delete(schema.users);
  await db.insert(schema.users).values([
    { id: "admin", email: "root@example.com", handle: "root", name: "Root", role: "admin", status: "active", clerkUserId: "clerk_root" },
    { id: "ada", email: "ada@example.com", handle: "ada", name: "Ada", role: "member", status: "invited" },
  ]);
});

async function row(id: string) {
  return (await db.select().from(schema.users).where(eq(schema.users.id, id)).get())!;
}

function signIn(clerkUserId: string, email: string | null) {
  return activateFromClerk({ clerkUserId, email, name: null, avatarUrl: null });
}

describe("the address a Clerk user is matched by", () => {
  const address = (id: string, emailAddress: string, status: string | null) => ({ id, emailAddress, verification: status ? { status } : null });

  it("is the primary address when Clerk has verified it", () => {
    const user = { primaryEmailAddressId: "b", emailAddresses: [address("a", "first@example.com", "verified"), address("b", "primary@example.com", "verified")] };
    assert.equal(signInEmail(user), "primary@example.com");
  });

  it("is another verified address when the primary is not verified", () => {
    const user = { primaryEmailAddressId: "a", emailAddresses: [address("a", "primary@example.com", "unverified"), address("b", "other@example.com", "verified")] };
    assert.equal(signInEmail(user), "other@example.com");
  });

  it("is none when no address is verified, rather than the first one listed", () => {
    const user = { primaryEmailAddressId: "a", emailAddresses: [address("a", "primary@example.com", "unverified"), address("b", "other@example.com", null)] };
    assert.equal(signInEmail(user), null);
    assert.equal(signInEmail({ primaryEmailAddressId: null, emailAddresses: [address("a", "x@example.com", "expired")] }), null);
  });
});

describe("a first sign-in", () => {
  it("links the invited row at a verified address and makes it active", async () => {
    const user = await signIn("clerk_ada", "Ada@Example.com");
    assert.equal(user?.id, "ada");
    assert.equal(user?.status, "active");
    assert.equal((await row("ada")).clerkUserId, "clerk_ada");
  });

  it("is not invited without a verified address", async () => {
    assert.equal(await signIn("clerk_ada", null), null);
    assert.equal((await row("ada")).clerkUserId, null);
    assert.equal((await row("ada")).status, "invited");
  });

  it("never takes over a row another Clerk user holds, the Admin's included", async () => {
    assert.equal(await signIn("clerk_newcomer", "root@example.com"), null);
    const admin = await row("admin");
    assert.equal(admin.clerkUserId, "clerk_root");
    assert.equal(admin.role, "admin");

    await signIn("clerk_ada", "ada@example.com");
    assert.equal(await signIn("clerk_other", "ada@example.com"), null);
    assert.equal((await row("ada")).clerkUserId, "clerk_ada");
  });

  it("is refused to a revoked User", async () => {
    await db.update(schema.users).set({ status: "revoked" }).where(eq(schema.users.id, "ada"));
    assert.equal(await signIn("clerk_ada", "ada@example.com"), null);
    assert.equal((await row("ada")).clerkUserId, null);
  });

  it("lets the Admin seeded on a fresh deployment claim their row", async () => {
    await db.delete(schema.users);
    await ensureSeed();
    const seeded = (await db.select().from(schema.users).get())!;
    assert.equal(seeded.status, "invited");
    const user = await signIn("clerk_root", "root@example.com");
    assert.equal(user?.id, seeded.id);
    assert.equal(user?.role, "admin");
    assert.equal(user?.status, "active");
  });
});

describe("a linked User", () => {
  it("signs in by Clerk id whatever addresses their account now has", async () => {
    assert.equal((await signIn("clerk_root", null))?.id, "admin");
    assert.equal((await signIn("clerk_root", "new-address@example.com"))?.id, "admin");
    assert.equal((await row("admin")).email, "root@example.com");
  });
});

describe("verifying a session token with the instance's public key", () => {
  async function token(claims: Record<string, unknown>, privateKey = instanceKey.privateKey) {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({ sub: "user_123", azp: env.publicUrl, nbf: now - 5, exp: now + 60, ...claims }, privateKey, { algorithm: "RS256", header: { typ: "JWT", kid: "ins_test" } });
  }

  it("reads the key from an env file's one-line form", () => {
    assert.equal(env.clerkJwtKey, instanceKey.publicKey.trim());
  });

  // No secret key, so @clerk/backend could not have fetched keys from Clerk to check it.
  it("accepts a token the instance signed for this app, without asking Clerk", async () => {
    assert.deepEqual(await verifySessionToken(await token({}), { jwtKey: env.clerkJwtKey, secretKey: "" }), { sub: "user_123" });
  });

  it("refuses a token signed with another key, issued to another origin, or expired", async () => {
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const keys = { jwtKey: env.clerkJwtKey, secretKey: "" };
    assert.equal(await verifySessionToken(await token({}, other.privateKey), keys), null);
    assert.equal(await verifySessionToken(await token({ azp: "https://abcd1234.kardboard.test" }), keys), null);
    assert.equal(await verifySessionToken(await token({ exp: Math.floor(Date.now() / 1000) - 600 }), keys), null);
    assert.equal(await verifySessionToken("not a token", keys), null);
  });
});
