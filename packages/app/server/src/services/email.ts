import { eq } from "drizzle-orm";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { newId } from "../ids.js";
import { getUser } from "./users.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Mail clients drop stylesheets, so every element the Markdown can produce carries its style inline.
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";
const INLINE_STYLES: Record<string, string> = {
  p: "margin:0 0 12px",
  a: "color:#d9a05b;text-decoration:underline",
  ul: "margin:0 0 12px;padding-left:22px",
  ol: "margin:0 0 12px;padding-left:22px",
  li: "margin:2px 0",
  blockquote: "margin:0 0 12px;padding-left:12px;border-left:2px solid #3a3731;color:#9b9384",
  h1: "margin:16px 0 8px;font-size:17px;font-weight:600;color:#e7e2d9",
  h2: "margin:16px 0 8px;font-size:15px;font-weight:600;color:#e7e2d9",
  h3: "margin:14px 0 6px;font-size:14px;font-weight:600;color:#e7e2d9",
  h4: "margin:12px 0 6px;font-size:14px;font-weight:600;color:#e7e2d9",
  h5: "margin:12px 0 6px;font-size:14px;font-weight:600;color:#e7e2d9",
  h6: "margin:12px 0 6px;font-size:14px;font-weight:600;color:#e7e2d9",
  hr: "border:0;border-top:1px solid #3a3731;margin:16px 0",
  img: "max-width:100%;border-radius:6px",
  table: "border-collapse:collapse;margin:0 0 12px;font-size:13px",
  th: "border:1px solid #3a3731;padding:4px 8px;text-align:left",
  td: "border:1px solid #3a3731;padding:4px 8px",
};

/**
 * Markdown as email HTML. micromark is the parser underneath the app's own
 * Markdown, and it is safe by default: raw HTML in the source is escaped rather than passed
 * through, and a link to anything but http(s), mailto and the like is emptied. Every `<` left in
 * its output is a tag it wrote, so the tags can be given inline styles by pattern. A link to a path
 * on this site is made absolute, since an email has no site to be relative to.
 */
export function renderEmailMarkdown(body: string, baseUrl: string): string {
  let html = micromark(body, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  html = html.replace(/<pre><code(?: class="[^"]*")?>/g, `<pre style="margin:0 0 12px;padding:10px 12px;background:#1b1a17;border:1px solid #3a3731;border-radius:6px;overflow-x:auto"><code style="font-family:${MONO};font-size:13px">`);
  html = html.replace(/<code>/g, `<code style="font-family:${MONO};font-size:13px;background:#26241f;padding:1px 5px;border-radius:4px">`);
  html = html.replace(/<(p|a|ul|ol|li|blockquote|h[1-6]|hr|img|table|th|td)(?=[\s>/])/g, (_m, tag: string) => `<${tag} style="${INLINE_STYLES[tag]}"`);
  const base = baseUrl.replace(/\/+$/, "");
  return html.replace(/ (href|src)="\/(?!\/)/g, (_m, attr: string) => ` ${attr}="${escapeHtml(base)}/`);
}

export async function queueEmail(input: {
  toUserId: string;
  subject: string;
  heading: string;
  body: string;
  linkUrl: string;
  linkLabel: string;
  footer: string;
  /** Told once delivery settles whether the email went out: sent, or logged with no Resend key. */
  onSettled?: (delivered: boolean) => void;
}): Promise<void> {
  const html = `<!doctype html><html><body style="margin:0;background:#141311;font-family:ui-sans-serif,system-ui,sans-serif;color:#e7e2d9">
<div style="max-width:560px;margin:0 auto;padding:40px 24px">
  <p style="margin:0 0 24px;font-size:13px;letter-spacing:.04em;color:#9b9384">kardboard</p>
  <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;line-height:1.3">${escapeHtml(input.heading)}</h1>
  <div style="font-size:15px;line-height:1.55;color:#cfc8bd;border-left:2px solid #3a3731;padding-left:14px;margin:0 0 28px">${renderEmailMarkdown(input.body, env.publicUrl)}</div>
  <a href="${escapeHtml(input.linkUrl)}" style="display:inline-block;background:#d9a05b;color:#1b1710;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:8px">${escapeHtml(input.linkLabel)}</a>
  <p style="margin:36px 0 0;font-size:12px;color:#6f6960">${escapeHtml(input.footer)}</p>
</div></body></html>`;
  const id = newId();
  await db.insert(schema.outboundEmails).values({ id, toUserId: input.toUserId, subject: input.subject, html });
  void deliver(id)
    .catch((err) => console.error("[email] delivery failed", err))
    .then(async () => {
      if (!input.onSettled) return;
      const row = await db.select({ status: schema.outboundEmails.status }).from(schema.outboundEmails).where(eq(schema.outboundEmails.id, id)).get();
      input.onSettled(row?.status === "sent" || row?.status === "logged");
    })
    .catch(() => undefined);
}

async function deliver(id: string): Promise<void> {
  const row = await db.select().from(schema.outboundEmails).where(eq(schema.outboundEmails.id, id)).get();
  if (!row) return;
  const user = await getUser(row.toUserId);
  if (!user) return;
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
