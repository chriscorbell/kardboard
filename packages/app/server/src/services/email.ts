import { eq } from "drizzle-orm";
import type { User } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { newId } from "../ids.js";
import { getAgentProfile } from "./settings.js";
import { getUser } from "./users.js";

const CARD_FOOTER = "This address does not receive replies. Reply on the card instead.";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function queueEmail(input: {
  toUserId: string;
  subject: string;
  heading: string;
  body: string;
  linkUrl: string;
  linkLabel: string;
  footer?: string;
}): Promise<void> {
  const html = `<!doctype html><html><body style="margin:0;background:#141311;font-family:ui-sans-serif,system-ui,sans-serif;color:#e7e2d9">
<div style="max-width:560px;margin:0 auto;padding:40px 24px">
  <p style="margin:0 0 24px;font-size:13px;letter-spacing:.04em;color:#9b9384">kardboard</p>
  <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;line-height:1.3">${escapeHtml(input.heading)}</h1>
  <div style="white-space:pre-wrap;font-size:15px;line-height:1.55;color:#cfc8bd;border-left:2px solid #3a3731;padding-left:14px;margin:0 0 28px">${escapeHtml(input.body)}</div>
  <a href="${escapeHtml(input.linkUrl)}" style="display:inline-block;background:#d9a05b;color:#1b1710;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:8px">${escapeHtml(input.linkLabel)}</a>
  <p style="margin:36px 0 0;font-size:12px;color:#6f6960">${escapeHtml(input.footer ?? CARD_FOOTER)}</p>
</div></body></html>`;
  const id = newId();
  await db.insert(schema.outboundEmails).values({ id, toUserId: input.toUserId, subject: input.subject, html });
  void deliver(id).catch((err) => console.error("[email] delivery failed", err));
}

// An invitation only puts an address on the allowlist; this is the only thing that tells the
// person it happened. Sent on the first invite, on a repeat invite of the same address, and on a
// reinstatement, which are exactly the cases that leave the User waiting to sign in. An active
// User has already accepted, so nothing is sent and the caller hears false.
export async function sendInvitation(user: User, invitedBy: User | null): Promise<boolean> {
  if (user.status !== "invited") return false;
  const agent = await getAgentProfile();
  const inviter = invitedBy && invitedBy.id !== user.id ? invitedBy.name : null;
  const heading = inviter ? `${inviter} invited you to kardboard` : "You have been invited to kardboard";
  await queueEmail({
    toUserId: user.id,
    subject: heading,
    heading,
    body:
      `kardboard is a board you share with ${agent.name}, the coding agent: you write a card, ${agent.name} picks it up and opens a pull request, and the work merges when you approve it.\n\n` +
      `Sign in with ${user.email} to accept. Any other address will be turned away.`,
    linkUrl: env.publicUrl,
    linkLabel: "Sign in to kardboard",
    footer: "You are receiving this because this address was invited to kardboard. If you were not expecting it, ignore this email.",
  });
  return true;
}

async function deliver(id: string): Promise<void> {
  const row = await db.select().from(schema.outboundEmails).where(eq(schema.outboundEmails.id, id)).get();
  if (!row) return;
  const user = await getUser(row.toUserId);
  if (!user) return;
  // Revoked between queueing and sending: a revoked User is not written to at all.
  if (user.status === "revoked") {
    await db.update(schema.outboundEmails).set({ status: "failed", error: "recipient is revoked" }).where(eq(schema.outboundEmails.id, id));
    return;
  }
  if (!env.resendApiKey) {
    console.log(`[email] (logged, no RESEND_API_KEY) to=${user.email} subject=${JSON.stringify(row.subject)}`);
    await db
      .update(schema.outboundEmails)
      .set({ status: "logged", sentAt: new Date().toISOString() })
      .where(eq(schema.outboundEmails.id, id));
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.emailFrom,
      to: [user.email],
      subject: row.subject,
      html: row.html,
      reply_to: "no-reply@kardboard.cc",
    }),
  });
  if (!res.ok) {
    const error = `${res.status} ${await res.text()}`;
    await db.update(schema.outboundEmails).set({ status: "failed", error }).where(eq(schema.outboundEmails.id, id));
    console.error("[email] resend rejected", error);
    return;
  }
  await db
    .update(schema.outboundEmails)
    .set({ status: "sent", sentAt: new Date().toISOString() })
    .where(eq(schema.outboundEmails.id, id));
  console.log(`[email] sent to=${user.email} subject=${JSON.stringify(row.subject)}`);
}
