import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createAccessTokenSchema,
  createCardSchema,
  createCommentSchema,
  deleteBoardSchema,
  moveCardSchema,
  settingsSchema,
  updateCardSchema,
  updateCommentSchema,
  updateMeSchema,
  upsertBoardSchema,
  isDisplayableImage,
  mimeEssence,
  type BoardView,
  type CardDetail,
  type Me,
  type User,
} from "@kardboard/shared";
import { eq, desc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { requireUser, type AuthVariables } from "../auth.js";
import { createBoard, getBoardById, getBoardBySlug, listAllBoards, listBoardPeople, updateBoard } from "../services/boards.js";
import { ConflictError, createCard, getCard, listCards, listChildren, moveCard, updateCard } from "../services/cards.js";
import { addAttachment, createComment, deleteComment, getAttachment, getComment, listComments, underFileLock, updateComment } from "../services/comments.js";
import { getAgentProfile, getSettings, updateSettings } from "../services/settings.js";
import { getPreferences, updatePreferences } from "../services/users.js";
import { subscribe } from "../services/realtime.js";
import { backupsView, takeSnapshot } from "../services/backup.js";
import { overview } from "../services/overview.js";
import { BoardDeletionRefused, boardDeletionImpact, deleteBoard } from "../services/board-deletion.js";
import { createAccessToken, listAccessTokens, revokeAccessToken } from "../services/access-tokens.js";
import { deleteCard } from "../services/card-deletion.js";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// Every other body the API reads is a JSON document, the largest a Card's or a Comment's 20,000
// characters.
const MAX_JSON_BYTES = 1024 * 1024;
// How often an open event stream is pinged, which keeps a proxy from closing it as idle.
const EVENTS_PING_MS = Number(process.env.KARDBOARD_EVENTS_PING_MS ?? "25000");

export const api = new Hono<{ Variables: AuthVariables }>();

api.use("*", requireUser);

// A body is read into memory, so one larger than any the API takes is refused as it streams in. An
// Attachment upload is left out: its route has a larger limit of its own, and a limit on the whole
// router runs first, so it would refuse every upload over 1 MB.
const ATTACHMENT_UPLOAD = /\/comments\/[^/]+\/attachments$/;
const jsonLimit = bodyLimit({ maxSize: MAX_JSON_BYTES, onError: (c) => c.json({ error: "request body exceeds 1 MB" }, 413) });
api.use("*", (c, next) => (c.req.method === "POST" && ATTACHMENT_UPLOAD.test(c.req.path) ? next() : jsonLimit(c, next)));

// A body that fails its schema is answered with the first thing wrong with it, in words the client
// can show. Left to itself the validator answers with a serialised ZodError, which reaches a person
// as "[object Object]".
function json<T extends z.ZodTypeAny>(schema: T) {
  return zValidator("json", schema, (result, c) => {
    if (result.success) return;
    const issue = result.error.issues[0];
    const where = issue?.path.join(".");
    return c.json({ error: issue ? (where ? `${where}: ${issue.message}` : issue.message) : "invalid request" }, 400);
  });
}

function actorOf(c: { get: (k: "user") => { id: string } }) {
  return { kind: "user" as const, id: c.get("user").id };
}

async function meView(user: User): Promise<Me> {
  return { user, agent: await getAgentProfile(), ...(await getPreferences(user.id)) };
}

api.get("/me", async (c) => c.json(await meView(c.get("user"))));

// The User's own settings: whether they have seen the board explainer.
api.patch("/me", json(updateMeSchema), async (c) => {
  await updatePreferences(c.get("user").id, c.req.valid("json"));
  return c.json(await meView(c.get("user")));
});

api.get("/boards", async (c) => c.json(await listAllBoards()));

api.get("/overview", async (c) => c.json(await overview()));

api.get("/boards/:slug", async (c) => {
  const board = await getBoardBySlug(c.req.param("slug"));
  if (!board) return c.json({ error: "not_found" }, 404);
  const view: BoardView = {
    board,
    cards: await listCards(board.id),
    people: await listBoardPeople(),
    agent: await getAgentProfile(),
  };
  return c.json(view);
});

api.get("/boards/:slug/events", async (c) => {
  const board = await getBoardBySlug(c.req.param("slug"));
  if (!board) return c.json({ error: "not_found" }, 404);
  return streamSSE(c, async (stream) => {
    let id = 0;
    const unsubscribe = subscribe(board.id, (event) => {
      void stream.writeSSE({ id: String(id++), event: event.type, data: JSON.stringify(event) });
    });
    stream.onAbort(unsubscribe);
    await stream.writeSSE({ event: "ready", data: "{}" });
    while (!stream.aborted) {
      await stream.sleep(EVENTS_PING_MS);
      await stream.writeSSE({ event: "ping", data: "{}" });
    }
  });
});

api.post("/boards/:slug/cards", json(createCardSchema), async (c) => {
  const board = await getBoardBySlug(c.req.param("slug"));
  if (!board) return c.json({ error: "not_found" }, 404);
  const card = await createCard({ boardId: board.id, ...c.req.valid("json"), actor: actorOf(c) });
  return c.json(card, 201);
});

api.get("/cards/:id", async (c) => {
  const card = await getCard(c.req.param("id"));
  if (!card) return c.json({ error: "not_found" }, 404);
  const detail: CardDetail = {
    card,
    comments: await listComments(card.id),
    activity: (
      await db.select().from(schema.events).where(eq(schema.events.cardId, card.id)).orderBy(desc(schema.events.createdAt)).limit(100)
    ).map((e) => ({ id: e.id, type: e.type, actorKind: e.actorKind, actorId: e.actorId, payload: e.payload, createdAt: e.createdAt })),
    children: await listChildren(card.id),
  };
  return c.json(detail);
});

api.patch("/cards/:id", json(updateCardSchema), async (c) => {
  const card = await getCard(c.req.param("id"));
  if (!card) return c.json({ error: "not_found" }, 404);
  try {
    const input = c.req.valid("json");
    return c.json(await updateCard(card.id, { ...input, actor: actorOf(c) }));
  } catch (err) {
    if (err instanceof ConflictError) return c.json({ error: "conflict", card: await getCard(card.id) }, 409);
    throw err;
  }
});

api.post("/cards/:id/move", json(moveCardSchema), async (c) => {
  const card = await getCard(c.req.param("id"));
  if (!card) return c.json({ error: "not_found" }, 404);
  try {
    const input = c.req.valid("json");
    return c.json(await moveCard(card.id, { ...input, actor: actorOf(c) }));
  } catch (err) {
    if (err instanceof ConflictError) return c.json({ error: "conflict", card: await getCard(card.id) }, 409);
    throw err;
  }
});

api.post("/cards/:id/comments", json(createCommentSchema), async (c) => {
  const card = await getCard(c.req.param("id"));
  if (!card) return c.json({ error: "not_found" }, 404);
  const input = c.req.valid("json");
  const comment = await createComment({ cardId: card.id, ...input, actor: actorOf(c) });
  return c.json(comment, 201);
});

api.patch("/comments/:id", json(updateCommentSchema), async (c) => {
  const comment = await getComment(c.req.param("id"));
  if (!comment) return c.json({ error: "not_found" }, 404);
  // The User edits their own words; the Agent's are the Agent's to edit.
  const user = c.get("user");
  if (!(comment.authorKind === "user" && comment.authorId === user.id)) return c.json({ error: "forbidden" }, 403);
  return c.json(await updateComment(comment.id, { body: c.req.valid("json").body, actor: actorOf(c) }));
});

// For good, with everything on the Card: see deleteCard.
api.delete("/cards/:id", async (c) => {
  const card = await getCard(c.req.param("id"));
  if (!card) return c.json({ error: "not_found" }, 404);
  await deleteCard(card.id, actorOf(c));
  return c.body(null, 204);
});

// The User may delete any Comment, the Agent's included.
api.delete("/comments/:id", async (c) => {
  const comment = await getComment(c.req.param("id"));
  if (!comment) return c.json({ error: "not_found" }, 404);
  await deleteComment(comment.id, actorOf(c));
  return c.body(null, 204);
});

// The multipart body is read into memory, so it is refused as it streams in once it passes the
// limit, rather than after all of it has arrived.
const uploadLimit = bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES + 1024 * 1024, onError: (c) => c.json({ error: "file exceeds 25 MB" }, 413) });

api.post("/comments/:id/attachments", uploadLimit, async (c) => {
  const comment = await getComment(c.req.param("id"));
  if (!comment) return c.json({ error: "not_found" }, 404);
  const user = c.get("user");
  if (!(comment.authorKind === "user" && comment.authorId === user.id)) return c.json({ error: "forbidden" }, 403);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  if (file.size > MAX_ATTACHMENT_BYTES) return c.json({ error: "file exceeds 25 MB" }, 413);
  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(env.dataDir, "uploads", sha256.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, sha256);
  // Under the same lock as removing an unused file, so a Comment deleted at this moment cannot take
  // the file this Attachment is about to point at.
  const att = await underFileLock(sha256, async () => {
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
    return addAttachment({
      commentId: comment.id,
      filename: file.name || "attachment",
      mime: file.type,
      size: file.size,
      sha256,
    });
  });
  return c.json(att, 201);
});

api.get("/attachments/:id", async (c) => {
  const att = await getAttachment(c.req.param("id"));
  if (!att) return c.json({ error: "not_found" }, 404);
  const file = path.join(env.dataDir, "uploads", att.sha256.slice(0, 2), att.sha256);
  if (!fs.existsSync(file)) return c.json({ error: "missing" }, 404);
  // The uploader chose the type. Only the raster images are shown in place; anything else, an SVG
  // or an HTML page among them, downloads, and the sandbox header keeps it from running on this
  // origin if a browser renders it anyway. The type is cut down again here because rows written
  // before uploads were normalised can carry parameters or capitals.
  const type = mimeEssence(att.mime);
  const disposition = isDisplayableImage(type) ? "inline" : "attachment";
  return new Response(fs.createReadStream(file) as unknown as ReadableStream, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(att.size),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      // A page on another origin cannot embed the file, even if its request were to carry a
      // credential.
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
});

// ---- admin ----
// The User's settings. Named for the panel's old name, so the paths stay as the client calls them.
const admin = new Hono<{ Variables: AuthVariables }>();

admin.get("/boards", async (c) => c.json(await listAllBoards()));
admin.post("/boards", json(upsertBoardSchema), async (c) => {
  if (await getBoardBySlug(c.req.valid("json").slug)) return c.json({ error: "slug already in use" }, 409);
  return c.json(await createBoard(c.req.valid("json")), 201);
});
admin.patch("/boards/:id", json(upsertBoardSchema), async (c) => {
  const existing = await getBoardBySlug(c.req.valid("json").slug);
  if (existing && existing.id !== c.req.param("id")) return c.json({ error: "slug already in use" }, 409);
  const before = await getBoardById(c.req.param("id"));
  if (!before) return c.json({ error: "not_found" }, 404);
  return c.json(await updateBoard(before.id, c.req.valid("json")));
});
// What deleting the Board would remove.
admin.get("/boards/:id/deletion", async (c) => {
  const board = await getBoardById(c.req.param("id"));
  if (!board) return c.json({ error: "not_found" }, 404);
  return c.json(await boardDeletionImpact(board.id));
});
admin.delete("/boards/:id", json(deleteBoardSchema), async (c) => {
  const board = await getBoardById(c.req.param("id"));
  if (!board) return c.json({ error: "not_found" }, 404);
  if (c.req.valid("json").slug !== board.slug) return c.json({ error: "Type the board's slug exactly to confirm." }, 400);
  try {
    const { snapshot } = await deleteBoard(board.id, actorOf(c));
    return c.json({ ok: true, snapshot });
  } catch (err) {
    if (err instanceof BoardDeletionRefused) return c.json({ error: err.message }, err.status);
    throw err;
  }
});
// Access tokens for the User's own agents, each reaching every Board. The secret is in the creation
// response and nowhere else.
admin.get("/tokens", async (c) => c.json(await listAccessTokens()));
admin.post("/tokens", json(createAccessTokenSchema), async (c) => c.json(await createAccessToken(c.req.valid("json").name), 201));
admin.delete("/tokens/:tokenId", async (c) => ((await revokeAccessToken(c.req.param("tokenId"))) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404)));

admin.get("/settings", async (c) => c.json(await getSettings()));
admin.patch("/settings", json(settingsSchema), async (c) => c.json(await updateSettings(c.req.valid("json"))));

admin.get("/backups", (c) => c.json(backupsView()));
admin.post("/backups", async (c) => {
  const { snapshot } = await takeSnapshot();
  return c.json({ ...backupsView(), snapshot }, 201);
});

api.route("/admin", admin);
