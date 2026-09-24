import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { User } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { newId } from "../ids.js";
import { canAccessBoard } from "./boards.js";
import { mintInstallationToken, parseRepoUrl } from "./github.js";
import { toUser } from "./users.js";
import { runner } from "./runner-client.js";

// Runner-hosted Previews. The app owns the registry: which Card has a Preview, at which hostname,
// and whether its container is up. The runner builds and runs it; the preview router reads this
// registry for its routing table and comes back here to turn a signed-in Member into a cookie.
//
// Nothing here ever puts a kardboard credential on a Preview host. A Member arrives at the app,
// which checks Board membership and hands out a single-use code; the router spends that code
// server-to-server and sets a cookie good for that one host.

export type PreviewRow = typeof schema.previews.$inferSelect;

export class PreviewError extends Error {}

// The Card's short id, the same prefix its branch name carries.
export const cardSlug = (cardId: string) => cardId.slice(0, 8);

export function previewHostFor(cardId: string): string {
  if (!env.previewDomain) throw new PreviewError("KARDBOARD_PREVIEW_DOMAIN is not set, so preview hostnames cannot be formed.");
  return env.previewHostPattern.replace("{card}", cardSlug(cardId)).replace("{domain}", env.previewDomain).toLowerCase();
}

export const previewUrlFor = (host: string) => `${env.previewScheme}://${host}`;

// Ask the runner to build this Card's branch and run it. The hostname is known before the build
// starts, so the Session can report a URL immediately; the router holds visitors until it is up.
export async function startPreview(cardId: string): Promise<PreviewRow> {
  const card = await db.select().from(schema.cards).where(eq(schema.cards.id, cardId)).get();
  if (!card) throw new PreviewError("card not found");
  const board = await db.select().from(schema.boards).where(eq(schema.boards.id, card.boardId)).get();
  if (!board) throw new PreviewError("board not found");
  if (board.previewMode !== "runner") throw new PreviewError(`this board is in ${board.previewMode} preview mode, so kardboard does not host its previews`);
  if (!card.branch) throw new PreviewError("the card has no branch yet; push one first");
  const repo = parseRepoUrl(board.repoUrl);
  if (!repo) throw new PreviewError("the board has no GitHub repository URL");
  if (runner.mode !== "http") throw new PreviewError("no runner is configured, so nothing can host a preview");

  const host = previewHostFor(card.id);
  const existing = await db.select().from(schema.previews).where(eq(schema.previews.cardId, card.id)).get();
  const id = existing?.id ?? newId();
  const nowIso = new Date().toISOString();
  if (existing) {
    await db
      .update(schema.previews)
      .set({ host, status: "building", branch: card.branch, error: null, updatedAt: nowIso })
      .where(eq(schema.previews.id, id));
  } else {
    await db.insert(schema.previews).values({ id, boardId: board.id, cardId: card.id, host, status: "building", branch: card.branch, port: 3000 });
  }

  // A one-hour installation token, minted here rather than taken from the Session, so the clone
  // credential is the app's and expires on its own.
  const { token } = await mintInstallationToken("sessions", repo.owner, repo.repo);
  try {
    await runner.startPreview({
      previewId: id,
      boardSlug: board.slug,
      cardId: card.id,
      host,
      repoUrl: board.repoUrl!,
      branch: card.branch,
      githubToken: token,
      dockerfile: "Dockerfile",
      port: 3000,
      env: { KARDBOARD_PREVIEW_HOST: host, KARDBOARD_PREVIEW_URL: previewUrlFor(host) },
    });
  } catch (err) {
    await applyPreviewState(id, { status: "failed", error: `the runner refused the build: ${(err as Error).message}` });
    throw new PreviewError(`the runner refused the build: ${(err as Error).message}`);
  }
  return (await db.select().from(schema.previews).where(eq(schema.previews.id, id)).get())!;
}

// Reported by the runner when the build finishes, one way or the other.
export async function applyPreviewState(
  previewId: string,
  state: { status: "running" | "failed"; containerId?: string | null; target?: string | null; error?: string | null },
): Promise<void> {
  const row = await db.select().from(schema.previews).where(eq(schema.previews.id, previewId)).get();
  if (!row) return;
  await db
    .update(schema.previews)
    .set({
      status: state.status,
      containerId: state.containerId ?? null,
      target: state.target ?? null,
      error: state.error ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.previews.id, previewId));
}

export async function getPreviewForCard(cardId: string): Promise<PreviewRow | undefined> {
  return db.select().from(schema.previews).where(eq(schema.previews.cardId, cardId)).get();
}

export async function removePreviewForCard(cardId: string): Promise<void> {
  const row = await getPreviewForCard(cardId);
  if (!row) return;
  await runner.stopPreview(row.id).catch((err) => console.error(`[preview] could not remove ${row.id}`, err));
  await db.delete(schema.previews).where(eq(schema.previews.id, row.id));
}

// What the preview router polls. `epoch` travels with the route so the router can reject cookies
// issued before a membership change on that Board.
export interface PreviewRoute {
  host: string;
  target: string | null;
  status: "building" | "running" | "failed";
  error: string | null;
  epoch: number;
}

export async function previewRoutes(): Promise<PreviewRoute[]> {
  const rows = await db
    .select({ preview: schema.previews, epoch: schema.boards.previewEpoch })
    .from(schema.previews)
    .innerJoin(schema.boards, eq(schema.previews.boardId, schema.boards.id));
  return rows.map((r) => ({ host: r.preview.host, target: r.preview.target, status: r.preview.status, error: r.preview.error, epoch: r.epoch }));
}

// A Board's Preview cookies stop working the moment its membership narrows.
export async function bumpPreviewEpoch(boardId: string): Promise<void> {
  const board = await db.select().from(schema.boards).where(eq(schema.boards.id, boardId)).get();
  if (!board) return;
  await db.update(schema.boards).set({ previewEpoch: board.previewEpoch + 1 }).where(eq(schema.boards.id, boardId));
}

export async function bumpEveryPreviewEpoch(): Promise<void> {
  const boards = await db.select({ id: schema.boards.id }).from(schema.boards);
  for (const b of boards) await bumpPreviewEpoch(b.id);
}

export interface PreviewCookie {
  host: string;
  board: string;
  user: string;
  epoch: number;
  exp: number;
}

export function signPreviewCookie(payload: PreviewCookie, secret = env.previewSecret): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function verifyPreviewCookie(value: string | undefined, secret: string): PreviewCookie | null {
  if (!value || !secret) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PreviewCookie;
  } catch {
    return null;
  }
}

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");
const CODE_TTL_MS = 60_000;

// Step one of the sign-in redirect: a signed-in Member with access to the Card's Board gets a
// single-use code for one Preview host. Only the hash is stored.
export async function issuePreviewCode(user: User, host: string): Promise<{ code: string; redirectBase: string }> {
  const preview = await db.select().from(schema.previews).where(eq(schema.previews.host, host.toLowerCase())).get();
  if (!preview) throw new PreviewError("there is no preview at that address");
  if (!(await canAccessBoard(user, preview.boardId))) throw new PreviewError("you are not a member of this preview's board");
  const code = randomBytes(32).toString("base64url");
  await db.insert(schema.previewCodes).values({
    code: hashCode(code),
    previewId: preview.id,
    userId: user.id,
    expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  });
  return { code, redirectBase: previewUrlFor(preview.host) };
}

// Step two, called by the router over the control network. Spending a code deletes it, and
// membership is checked again here rather than trusted from step one.
export async function exchangePreviewCode(code: string, host: string): Promise<{ cookie: string; maxAgeSeconds: number }> {
  const hashed = hashCode(code);
  const row = await db.select().from(schema.previewCodes).where(eq(schema.previewCodes.code, hashed)).get();
  await db.delete(schema.previewCodes).where(eq(schema.previewCodes.code, hashed));
  if (!row) throw new PreviewError("that sign-in link was already used or has expired");
  if (new Date(row.expiresAt).getTime() < Date.now()) throw new PreviewError("that sign-in link has expired");

  const preview = await db.select().from(schema.previews).where(eq(schema.previews.id, row.previewId)).get();
  if (!preview || preview.host !== host.toLowerCase()) throw new PreviewError("that sign-in link is for a different preview");
  const userRow = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).get();
  if (!userRow || userRow.status === "revoked") throw new PreviewError("that account can no longer open previews");
  const board = await db.select().from(schema.boards).where(eq(schema.boards.id, preview.boardId)).get();
  if (!board) throw new PreviewError("that preview's board is gone");
  if (!(await canAccessBoard(toUser(userRow), board.id))) {
    throw new PreviewError("you are not a member of this preview's board");
  }

  const maxAgeSeconds = Math.max(60, Math.floor(env.previewCookieMinutes * 60));
  await db.update(schema.previews).set({ lastAccessAt: new Date().toISOString() }).where(eq(schema.previews.id, preview.id));
  return {
    cookie: signPreviewCookie({ host: preview.host, board: board.id, user: userRow.id, epoch: board.previewEpoch, exp: Math.floor(Date.now() / 1000) + maxAgeSeconds }),
    maxAgeSeconds,
  };
}

// Previews are removed when their Card reaches Done and after the configured idle window.
export async function reapPreviews(): Promise<number> {
  await db.delete(schema.previewCodes).where(lt(schema.previewCodes.expiresAt, new Date().toISOString()));
  const cutoff = new Date(Date.now() - env.previewIdleDays * 86_400_000).toISOString();
  const stale = await db.select().from(schema.previews).where(lt(schema.previews.lastAccessAt, cutoff));
  const done = await db
    .select({ preview: schema.previews })
    .from(schema.previews)
    .innerJoin(schema.cards, eq(schema.previews.cardId, schema.cards.id))
    .where(eq(schema.cards.column, "done"));
  const byId = new Map<string, PreviewRow>();
  for (const row of [...stale, ...done.map((d) => d.preview)]) byId.set(row.id, row);
  for (const row of byId.values()) await removePreviewForCard(row.cardId);
  return byId.size;
}

export function startPreviewReaper(): void {
  const tick = () => void reapPreviews().catch((err) => console.error("[preview] reap failed", err));
  setInterval(tick, 3_600_000).unref?.();
  setTimeout(tick, 30_000).unref?.();
}

export async function listPreviews(): Promise<PreviewRow[]> {
  return db.select().from(schema.previews);
}
