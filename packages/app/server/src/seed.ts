import { sql } from "drizzle-orm";
import { db, schema } from "./db/index.js";
import { env } from "./env.js";
import { newId } from "./ids.js";

const ADMIN_EMAIL = process.env.KARDBOARD_ADMIN_EMAIL ?? "hi@chriscorbell.com";
const ADMIN_NAME = process.env.KARDBOARD_ADMIN_NAME ?? "Chris Corbell";

// The User is created from env so a fresh deployment can sign in. Demo content only appears in dev auth mode.
export async function ensureSeed(): Promise<void> {
  const userCount = Number((await db.select({ n: sql<number>`count(*)` }).from(schema.users).get())?.n ?? 0);
  if (userCount === 0) {
    await db.insert(schema.users).values({ id: newId(), email: ADMIN_EMAIL.toLowerCase(), name: ADMIN_NAME });
    console.log(`[seed] created ${ADMIN_EMAIL}`);
  }
  const boardCount = Number((await db.select({ n: sql<number>`count(*)` }).from(schema.boards).get())?.n ?? 0);
  if (boardCount === 0 && env.authMode === "dev") await seedDemo();
}

// A few of one person's projects, worked by them and their agent: what a board looks like a few weeks in.
async function seedDemo(): Promise<void> {
  const me = (await db.select().from(schema.users).get())!;
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  const site = { id: newId(), slug: "portfolio", name: "Portfolio site", repoUrl: "https://github.com/chriscorbell/portfolio" };
  const homelab = { id: newId(), slug: "homelab", name: "Homelab", repoUrl: "https://github.com/chriscorbell/fleet" };
  const recipes = { id: newId(), slug: "recipes", name: "Recipe box", repoUrl: null };
  await db.insert(schema.boards).values([site, homelab, recipes]);

  type C = typeof schema.cards.$inferInsert;
  const card = (boardId: string, column: C["column"], position: number, title: string, rest: Partial<C> = {}): C => ({
    id: newId(),
    boardId,
    title,
    description: "",
    priority: "none",
    column,
    position,
    creatorKind: "user",
    creatorId: me.id,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(30),
    ...rest,
  });
  const agent = { creatorKind: "agent" as const, creatorId: null };
  const cards: C[] = [
    card(site.id, "inbox", 1000, "Contact form drops the phone number on Safari", { ...agent, type: "bug", priority: "high", description: "Found while working on the footer redesign (card \"Footer newsletter signup\").\n\nThe `tel` input loses its value when Safari autofills the form, so the email that arrives has an empty phone line. Chrome and Firefox are fine.\n\n- `src/components/ContactForm.tsx`: the controlled input resets on the autofill `change` event.", createdAt: minutesAgo(12), updatedAt: minutesAgo(12) }),
    card(site.id, "inbox", 2000, "Image component ships the full-size original to phones", { ...agent, type: "bug", priority: "medium", description: "Found while profiling the case study page. `src/components/Figure.tsx` sets `srcset` but no `sizes`, so phones download the 2400px file.", createdAt: minutesAgo(40), updatedAt: minutesAgo(40) }),
    card(site.id, "inbox", 3000, "Add a dark-mode toggle to the header", { type: "idea", createdAt: minutesAgo(400), updatedAt: minutesAgo(400) }),
    card(site.id, "blocked", 1000, "Swap the hero photography for the spring shoot", { priority: "medium", description: "Assets are in the \"Spring 2026 hero\" folder. Use the landscape crops.", createdAt: minutesAgo(600), updatedAt: minutesAgo(300) }),
    card(site.id, "ready", 1000, "Press page with a downloadable logo pack", { type: "feature", priority: "medium", description: "One page with the SVG and PNG logos and a short brand paragraph.", createdAt: minutesAgo(900), updatedAt: minutesAgo(200) }),
    card(site.id, "in_progress", 1000, "Case study page for the Meridian rebrand", { type: "feature", priority: "medium", description: "Before and after, three pull quotes, and the process timeline.", branch: "meridian-case-study", createdAt: minutesAgo(1200), updatedAt: minutesAgo(15) }),
    card(site.id, "review", 1000, "Footer newsletter signup", { type: "feature", priority: "low", description: "An email field in the footer that posts to the Buttondown list.", branch: "footer-newsletter", prUrl: "https://github.com/chriscorbell/portfolio/pull/41", prNumber: 41, createdAt: minutesAgo(1500), updatedAt: minutesAgo(45) }),
    card(site.id, "done", 1000, "Fix the 404 page layout on mobile", { type: "bug", branch: "404-mobile", prUrl: "https://github.com/chriscorbell/portfolio/pull/38", prNumber: 38, outcome: "implemented", createdAt: minutesAgo(4000), updatedAt: minutesAgo(2000) }),
    card(homelab.id, "inbox", 1000, "Watchtower restarts containers that opt out of updates", { ...agent, type: "bug", priority: "high", description: "Found while moving the media stack. The opt-out label is set on the service, but Watchtower reads it from the container, and compose only copies labels across on recreate.", createdAt: minutesAgo(90), updatedAt: minutesAgo(90) }),
    card(homelab.id, "ready", 1000, "Move the NAS backups to the new pool", { type: "chore", priority: "medium", createdAt: minutesAgo(3000), updatedAt: minutesAgo(3000) }),
    card(homelab.id, "in_progress", 1000, "Put the media stack behind the tunnel", { branch: "media-tunnel", createdAt: minutesAgo(800), updatedAt: minutesAgo(60) }),
    card(recipes.id, "inbox", 1000, "Scale ingredient amounts by servings", { type: "feature", createdAt: minutesAgo(5000), updatedAt: minutesAgo(5000) }),
    card(recipes.id, "inbox", 2000, "Import recipes from a URL", { type: "idea", createdAt: minutesAgo(5200), updatedAt: minutesAgo(5200) }),
  ];
  await db.insert(schema.cards).values(cards);

  const byTitle = (prefix: string) => cards.find((c) => c.title.startsWith(prefix))!;
  const hero = byTitle("Swap the hero");
  const footer = byTitle("Footer newsletter");
  const meridian = byTitle("Case study page");
  const notfound = byTitle("Fix the 404");
  await db.insert(schema.comments).values([
    { id: newId(), cardId: hero.id, authorKind: "agent", authorId: null, body: "The folder holds landscape and square crops, each at 2400px and 1600px. Which set should the homepage hero use? I'll wire the rest once you say.", createdAt: minutesAgo(300) },
    { id: newId(), cardId: meridian.id, authorKind: "user", authorId: me.id, body: "The pull quotes are highlighted in the copy doc. Keep the timeline to five steps.", createdAt: minutesAgo(88) },
    { id: newId(), cardId: footer.id, authorKind: "agent", authorId: null, body: "Ready for a look in #41. The field posts to the Buttondown list, confirms inline, and keeps the footer height the same on mobile.", createdAt: minutesAgo(45) },
    { id: newId(), cardId: notfound.id, authorKind: "agent", authorId: null, body: "Merged #38. The illustration scales with the viewport and the page fits on a 360px screen.", createdAt: minutesAgo(2000) },
  ]);

  const ev = (cardId: string, type: string, actorKind: "user" | "agent", payload: Record<string, unknown>, at: string) => ({ id: newId(), boardId: site.id, cardId, actorKind, actorId: actorKind === "user" ? me.id : null, type, payload, createdAt: at });
  await db.insert(schema.events).values([
    ev(hero.id, "card.created", "user", { column: "inbox" }, minutesAgo(600)),
    ev(hero.id, "card.moved", "agent", { from: "inbox", to: "blocked" }, minutesAgo(300)),
    ev(meridian.id, "card.moved", "agent", { from: "ready", to: "in_progress" }, minutesAgo(80)),
    ev(footer.id, "card.pr_linked", "agent", { prNumber: 41, prUrl: footer.prUrl }, minutesAgo(46)),
    ev(footer.id, "card.moved", "agent", { from: "in_progress", to: "review" }, minutesAgo(45)),
    ev(notfound.id, "card.merged", "agent", { prNumber: 38, prUrl: notfound.prUrl }, minutesAgo(2000)),
    ev(notfound.id, "card.moved", "agent", { from: "review", to: "done" }, minutesAgo(2000)),
  ]);
  console.log("[seed] demo boards created");
}

if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  const { runMigrations } = await import("./db/index.js");
  await runMigrations();
  await ensureSeed();
  process.exit(0);
}
