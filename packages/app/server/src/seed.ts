import { sql } from "drizzle-orm";
import { db, schema } from "./db/index.js";
import { env } from "./env.js";
import { newId } from "./ids.js";

const ADMIN_EMAIL = process.env.KARDBOARD_ADMIN_EMAIL ?? "hi@chriscorbell.com";
const ADMIN_NAME = process.env.KARDBOARD_ADMIN_NAME ?? "Chris Corbell";

// The first Admin is created from env so a fresh deployment can sign in. Demo content only appears in dev auth mode.
export async function ensureSeed(): Promise<void> {
  const userCount = Number((await db.select({ n: sql<number>`count(*)` }).from(schema.users).get())?.n ?? 0);
  if (userCount === 0) {
    await db.insert(schema.users).values({
      id: newId(),
      email: ADMIN_EMAIL.toLowerCase(),
      handle: "chris",
      name: ADMIN_NAME,
      role: "admin",
      status: env.authMode === "dev" ? "active" : "invited",
    });
    console.log(`[seed] created admin ${ADMIN_EMAIL}`);
  }
  const boardCount = Number((await db.select({ n: sql<number>`count(*)` }).from(schema.boards).get())?.n ?? 0);
  if (boardCount === 0 && env.authMode === "dev") await seedDemo();
}

async function seedDemo(): Promise<void> {
  const admin = (await db.select().from(schema.users).get())!;
  const members = [
    { id: newId(), email: "priya@lumen-studio.example", handle: "priya", name: "Priya Raghunathan", role: "member" as const, status: "active" as const },
    { id: newId(), email: "tomasz@lumen-studio.example", handle: "tomasz", name: "Tomasz Wierzbicki", role: "member" as const, status: "active" as const },
    { id: newId(), email: "ines@harbor-and-co.example", handle: "ines", name: "Inês Ferreira", role: "member" as const, status: "invited" as const },
  ];
  await db.insert(schema.users).values(members);
  const [priya, tomasz, ines] = members;

  const lumen = { id: newId(), slug: "lumen", name: "Lumen Studio site", repoUrl: "https://github.com/chriscorbell/lumen-site", provider: "claude" as const, previewMode: "external" as const, maxConcurrentSessions: 3, promptAppend: "" };
  const harbor = { id: newId(), slug: "harbor", name: "Harbor booking app", repoUrl: "https://github.com/chriscorbell/harbor-booking", provider: "codex" as const, previewMode: "runner" as const, maxConcurrentSessions: 2, promptAppend: "Run the Playwright suite before opening a PR." };
  await db.insert(schema.boards).values([lumen, harbor]);
  await db.insert(schema.boardMembers).values([
    { boardId: lumen.id, userId: priya!.id },
    { boardId: lumen.id, userId: tomasz!.id },
    { boardId: harbor.id, userId: ines!.id },
  ]);

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  type C = typeof schema.cards.$inferInsert;
  const cards: C[] = [
    { id: newId(), boardId: lumen.id, title: "Contact form drops the phone number", description: "When someone fills in the phone field and submits, the email we get has the field blank. Tested in Safari and Chrome.\n\nSteps:\n1. Open /contact\n2. Fill every field\n3. Submit\n\nThe phone line is missing in the notification email.", priority: "high", column: "inbox", position: 1000, creatorKind: "user", creatorId: priya!.id, createdAt: minutesAgo(4), updatedAt: minutesAgo(4) },
    { id: newId(), boardId: lumen.id, title: "Add a press page with downloadable logo pack", description: "We keep getting asked for logos. A single page with the SVG and PNG versions plus a short brand paragraph would do.", priority: "medium", column: "ready", position: 1000, creatorKind: "user", creatorId: tomasz!.id, createdAt: minutesAgo(180), updatedAt: minutesAgo(60) },
    { id: newId(), boardId: lumen.id, title: "Swap hero photography for the spring shoot", description: "Assets are in the shared Drive folder \"Spring 2026 hero\". Use the landscape crops.", priority: "medium", column: "blocked", position: 1000, creatorKind: "user", creatorId: priya!.id, createdAt: minutesAgo(400), updatedAt: minutesAgo(300) },
    { id: newId(), boardId: lumen.id, title: "Case study page for the Meridian rebrand", description: "Long-form page with before/after, three pull quotes, and the process timeline. Copy is final in the doc linked below.", priority: "medium", column: "in_progress", position: 1000, creatorKind: "user", creatorId: tomasz!.id, branch: "kardboard/meridian-case-study", createdAt: minutesAgo(90), updatedAt: minutesAgo(12) },
    { id: newId(), boardId: lumen.id, title: "Footer newsletter signup", description: "Small email field in the footer that posts to our Buttondown list.", priority: "low", column: "review", position: 1000, creatorKind: "user", creatorId: priya!.id, branch: "kardboard/footer-newsletter", prUrl: "https://github.com/chriscorbell/lumen-site/pull/41", prNumber: 41, previewUrl: "https://footer-newsletter.lumen-site.pages.dev", createdAt: minutesAgo(1500), updatedAt: minutesAgo(45) },
    { id: newId(), boardId: lumen.id, title: "Fix the 404 page layout on mobile", description: "The illustration overflows the viewport on phones.", priority: "none", column: "done", position: 1000, creatorKind: "user", creatorId: tomasz!.id, branch: "kardboard/404-mobile", prUrl: "https://github.com/chriscorbell/lumen-site/pull/38", prNumber: 38, createdAt: minutesAgo(4000), updatedAt: minutesAgo(2000) },
    { id: newId(), boardId: lumen.id, title: "Cookie banner keeps reappearing", description: "Dismissed it three times on my laptop, it comes back on every visit.", priority: "none", column: "done", position: 2000, creatorKind: "user", creatorId: priya!.id, createdAt: minutesAgo(6000), updatedAt: minutesAgo(5000) },
    { id: newId(), boardId: harbor.id, title: "Double booking when two people pick the same slot", description: "Two customers managed to book the 10:00 slot on Thursday. We need a hard guarantee that a slot can only be booked once.", priority: "high", column: "ready", position: 1000, creatorKind: "user", creatorId: ines!.id, createdAt: minutesAgo(30), updatedAt: minutesAgo(30) },
    { id: newId(), boardId: harbor.id, title: "Send a reminder email 24 hours before a booking", description: "", priority: "medium", column: "inbox", position: 1000, creatorKind: "user", creatorId: ines!.id, createdAt: minutesAgo(8), updatedAt: minutesAgo(8) },
  ];
  await db.insert(schema.cards).values(cards);

  const [bug, press, hero, meridian, footer, notfound] = cards;
  const comments: (typeof schema.comments.$inferInsert)[] = [
    { id: newId(), cardId: hero!.id, authorKind: "agent", authorId: null, body: `@priya I can see the Drive folder but it holds both landscape and square crops at two resolutions. Which set should go on the homepage hero: the 2400px landscape crops, or the 1600px ones? I'll wire the rest once you confirm.`, createdAt: minutesAgo(300) },
    { id: newId(), cardId: meridian!.id, authorKind: "user", authorId: tomasz!.id, body: "Copy doc: https://docs.google.com/document/d/meridian-final. The pull quotes are highlighted in yellow.", createdAt: minutesAgo(88) },
    { id: newId(), cardId: footer!.id, authorKind: "agent", authorId: null, body: `@priya The newsletter field is live on the preview: https://footer-newsletter.lumen-site.pages.dev\n\nIt posts to the Buttondown list, shows an inline confirmation, and keeps the footer height unchanged on mobile. Press Approve on this card when you're happy and I'll merge it.`, createdAt: minutesAgo(45) },
    { id: newId(), cardId: notfound!.id, authorKind: "agent", authorId: null, body: `@tomasz Merged and deployed. The illustration now scales with the viewport and the page fits on a 360px screen.`, createdAt: minutesAgo(2000) },
    { id: newId(), cardId: notfound!.id, authorKind: "user", authorId: tomasz!.id, body: "Looks right on my phone, thanks.", createdAt: minutesAgo(1900) },
    { id: newId(), cardId: press!.id, authorKind: "user", authorId: priya!.id, body: "Logo files are attached to the brand card in the old Trello board, I'll upload them here shortly.", editedAt: minutesAgo(55), createdAt: minutesAgo(60) },
  ];
  await db.insert(schema.comments).values(comments);
  await db.insert(schema.mentions).values([
    { commentId: comments[0]!.id, userId: priya!.id, notifiedAt: minutesAgo(300) },
    { commentId: comments[2]!.id, userId: priya!.id, notifiedAt: minutesAgo(45) },
    { commentId: comments[3]!.id, userId: tomasz!.id, notifiedAt: minutesAgo(2000) },
  ]);

  // The signed-in dev Admin needs something behind the bell.
  await db.insert(schema.notifications).values([
    { id: newId(), userId: admin.id, boardId: lumen.id, cardId: footer!.id, kind: "mention", title: "Milo mentioned you", body: comments[2]!.body.slice(0, 500), actorName: "Milo", createdAt: minutesAgo(45) },
    { id: newId(), userId: admin.id, boardId: lumen.id, cardId: meridian!.id, kind: "card_moved", title: "Milo moved your card to In progress", body: "Inbox → In progress", actorName: "Milo", createdAt: minutesAgo(80) },
    { id: newId(), userId: admin.id, boardId: lumen.id, cardId: notfound!.id, kind: "card_moved", title: "Milo moved your card to Done", body: "Review → Done", actorName: "Milo", readAt: minutesAgo(1900), createdAt: minutesAgo(2000) },
  ]);

  const ev = (cardId: string, type: string, actorKind: "user" | "agent" | "system", actorId: string | null, payload: Record<string, unknown>, at: string) => ({ id: newId(), boardId: lumen.id, cardId, actorKind, actorId, type, payload, createdAt: at });
  await db.insert(schema.events).values([
    ev(bug!.id, "card.created", "user", priya!.id, { column: "inbox" }, minutesAgo(4)),
    ev(hero!.id, "card.created", "user", priya!.id, { column: "inbox" }, minutesAgo(400)),
    ev(hero!.id, "card.moved", "agent", null, { from: "inbox", to: "blocked" }, minutesAgo(300)),
    ev(meridian!.id, "card.created", "user", tomasz!.id, { column: "inbox" }, minutesAgo(90)),
    ev(meridian!.id, "card.moved", "agent", null, { from: "inbox", to: "in_progress" }, minutesAgo(80)),
    ev(footer!.id, "card.created", "user", priya!.id, { column: "inbox" }, minutesAgo(1500)),
    ev(footer!.id, "card.moved", "agent", null, { from: "in_progress", to: "review" }, minutesAgo(45)),
    ev(notfound!.id, "card.approved", "user", tomasz!.id, { prNumber: 38 }, minutesAgo(2100)),
    ev(notfound!.id, "card.moved", "agent", null, { from: "review", to: "done" }, minutesAgo(2000)),
  ]);

  await db.insert(schema.sessions).values([
    { id: newId(), boardId: lumen.id, cardId: meridian!.id, kind: "card", provider: "claude", status: "running", intent: "Build the Meridian case study page from the final copy doc; touching src/pages/work and the shared timeline component.", branch: "kardboard/meridian-case-study", startedAt: minutesAgo(12), createdAt: minutesAgo(12) },
    { id: newId(), boardId: lumen.id, cardId: footer!.id, kind: "card", provider: "claude", status: "succeeded", intent: "Add footer newsletter signup posting to Buttondown.", branch: "kardboard/footer-newsletter", startedAt: minutesAgo(70), endedAt: minutesAgo(45), outcomeSummary: "Opened PR #41 with a preview and moved the card to Review.", createdAt: minutesAgo(70) },
    { id: newId(), boardId: lumen.id, cardId: hero!.id, kind: "card", provider: "claude", status: "succeeded", intent: "Clarify which crops to use before touching the hero.", startedAt: minutesAgo(305), endedAt: minutesAgo(300), outcomeSummary: "Asked Priya which crop set to use and moved the card to Blocked.", createdAt: minutesAgo(305) },
    { id: newId(), boardId: lumen.id, cardId: null, kind: "sweep", provider: "claude", status: "succeeded", intent: "Nightly hygiene sweep.", startedAt: minutesAgo(700), endedAt: minutesAgo(696), outcomeSummary: "All cards were in the right columns. Nothing moved.", createdAt: minutesAgo(700) },
  ]);
  console.log("[seed] demo boards created");
}

if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  const { runMigrations } = await import("./db/index.js");
  await runMigrations();
  await ensureSeed();
  process.exit(0);
}
