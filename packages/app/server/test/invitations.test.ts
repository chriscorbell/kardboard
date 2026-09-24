import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { desc, eq } from "drizzle-orm";
import type { User } from "@kardboard/shared";

// The database module opens its file at import time, so point it at a scratch directory first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-invitations-"));
process.env.KARDBOARD_DATA_DIR = root;

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { env } = await import("../src/env.js");
const { sendInvitation } = await import("../src/services/email.js");
const { inviteUser, setUserStatus } = await import("../src/services/users.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(async () => {
  await db.delete(schema.outboundEmails);
  await db.delete(schema.users);
  await db.delete(schema.settings);
});

async function admin(name: string): Promise<User> {
  return inviteUser({ email: `${name.toLowerCase()}@example.com`, name, role: "admin" }).then(async (u) => {
    await setUserStatus(u.id, "active");
    return { ...u, status: "active" as const };
  });
}

async function lastEmail(): Promise<typeof schema.outboundEmails.$inferSelect | undefined> {
  return db.select().from(schema.outboundEmails).orderBy(desc(schema.outboundEmails.createdAt)).get();
}

describe("sendInvitation", () => {
  it("tells the invited address who invited them and where to sign in", async () => {
    const grace = await admin("Grace");
    const ada = await inviteUser({ email: "Ada@example.com", name: "Ada Lovelace", role: "member" });

    assert.equal(await sendInvitation(ada, grace), true);

    const mail = (await lastEmail())!;
    assert.equal(mail.toUserId, ada.id);
    assert.equal(mail.subject, "Grace invited you to kardboard");
    assert.match(mail.html, /Grace invited you to kardboard/);
    // Sign-in is by address, so the address the allowlist holds has to be in the email.
    assert.match(mail.html, /ada@example\.com/);
    assert.match(mail.html, new RegExp(`href="${env.publicUrl}"`));
    assert.match(mail.html, /Sign in to kardboard/);
    // The card footer would be wrong here: there is no card to reply on.
    assert.doesNotMatch(mail.html, /Reply on the card/);
  });

  it("names the agent the board is shared with", async () => {
    await db.insert(schema.settings).values({ key: "agentName", value: "Ripley" });
    const ada = await inviteUser({ email: "ada@example.com", name: "Ada Lovelace", role: "member" });

    await sendInvitation(ada, null);

    assert.match((await lastEmail())!.html, /Ripley/);
  });

  it("omits the inviter when there is none", async () => {
    const ada = await inviteUser({ email: "ada@example.com", name: "Ada Lovelace", role: "member" });

    await sendInvitation(ada, null);

    assert.equal((await lastEmail())!.subject, "You have been invited to kardboard");
  });

  it("stays quiet for a user who has already signed in", async () => {
    const grace = await admin("Grace");

    assert.equal(await sendInvitation(grace, grace), false);
    assert.equal(await lastEmail(), undefined);
  });

  it("stays quiet for a revoked user", async () => {
    const ada = await inviteUser({ email: "ada@example.com", name: "Ada Lovelace", role: "member" });
    await setUserStatus(ada.id, "revoked");

    assert.equal(await sendInvitation({ ...ada, status: "revoked" }, null), false);
    assert.equal(await lastEmail(), undefined);
  });

  it("sends again when the same address is invited twice", async () => {
    const grace = await admin("Grace");
    const first = await inviteUser({ email: "ada@example.com", name: "Ada Lovelace", role: "member" });
    await sendInvitation(first, grace);

    const again = await inviteUser({ email: "ada@example.com", name: "Ada Lovelace", role: "member" });

    assert.equal(again.id, first.id);
    assert.equal(await sendInvitation(again, grace), true);
    assert.equal((await db.select().from(schema.outboundEmails)).length, 2);
  });

  it("sends when a revoked address is invited back", async () => {
    const grace = await admin("Grace");
    const ada = await inviteUser({ email: "ada@example.com", name: "Ada Lovelace", role: "member" });
    await setUserStatus(ada.id, "revoked");

    const reinstated = await inviteUser({ email: "ada@example.com", name: "Ada Lovelace", role: "member" });

    assert.equal(reinstated.status, "invited");
    assert.equal(await sendInvitation(reinstated, grace), true);
    assert.equal((await lastEmail())!.toUserId, ada.id);
  });

  it("escapes an inviter name that looks like markup", async () => {
    await db.insert(schema.users).values({ id: "user-x", email: "x@example.com", handle: "x", name: "<script>x</script>", role: "admin", status: "active" });
    const inviter = (await db.select().from(schema.users).where(eq(schema.users.id, "user-x")).get())! as User;
    const ada = await inviteUser({ email: "ada@example.com", name: "Ada Lovelace", role: "member" });

    await sendInvitation(ada, inviter);

    assert.doesNotMatch((await lastEmail())!.html, /<script>/);
  });
});
