import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  boardMembersSchema,
  createAccessTokenSchema,
  createCardSchema,
  createCommentSchema,
  deleteBoardSchema,
  inviteUserSchema,
  markNotificationsReadSchema,
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
import { refreshFromClerk, requireAdmin, requireUser, type AuthVariables } from "../auth.js";
import { canAccessBoard, createBoard, getBoardById, getBoardBySlug, listAllBoards, listBoardPeople, listBoardsForUser, listMembers, listMentionable, setMembers, updateBoard } from "../services/boards.js";
import { ConflictError, createCard, getCard, listCards, listChildren, moveCard, updateCard } from "../services/cards.js";
import { addAttachment, createComment, deleteComment, getAttachment, getComment, listComments, underFileLock, updateComment } from "../services/comments.js";
import { getAgentProfile, getSettings, updateSettings } from "../services/settings.js";
import { getPreferences, getUser, inviteUser, isRemoved, listUsers, removeUser, RemoveRefused, setUserStatus, updatePreferences } from "../services/users.js";
import { sendInvitation } from "../services/email.js";
import { subscribe } from "../services/realtime.js";
import { listNotifications, markCardNotificationsRead, markNotificationsRead } from "../services/notifications.js";
import { backupsView, takeSnapshot } from "../services/backup.js";
import { BoardDeletionRefused, boardDeletionImpact, deleteBoard } from "../services/board-deletion.js";
import { createAccessToken, listAccessTokens, revokeAccessToken } from "../services/access-tokens.js";
import { deleteCard, mayDeleteCard } from "../services/card-deletion.js";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// Every other body the API reads is a JSON document, the largest a Card's or a Comment's 20,000
// characters.
const MAX_JSON_BYTES = 1024 * 1024;
// How often an open event stream is pinged, which keeps a proxy from closing it as idle and is when
// the stream checks that its User may still watch the Board.
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

async function boardForUser(c: Parameters<typeof actorOf>[0] & { json: (b: unknown, s: 403 | 404) => Response }, boardId: string) {
  const board = await getBoardById(boardId);
  if (!board) return { error: c.json({ error: "not_found" }, 404) };
  if (!(await canAccessBoard(c.get("user") as never, board.id))) return { error: c.json({ error: "forbidden" }, 403) };
  return { board };
}

// Whether a User may still watch a Board whose event stream they opened: they are not revoked, which
// a removed User always is, and the Board is still there for them to open.
async function mayStillWatch(userId: string, boardId: string): Promise<boolean> {
  const user = await getUser(userId);
  if (!user || user.status === "revoked") return false;
  return Boolean(await getBoardById(boardId)) && (await canAccessBoard(user, boardId));
}

async function meView(user: User): Promise<Me> {
  return { user, agent: await getAgentProfile(), authMode: env.authMode, ...(await getPreferences(user.id)) };
}

api.get("/me", async (c) => c.json(await meView(c.get("user"))));

api.post("/me/refresh", async (c) => c.json(await meView(await refreshFromClerk(c.get("user")))));

// A User's own settings: how much email they want, and whether they have seen the board explainer.
api.patch("/me", json(updateMeSchema), async (c) => {
  await updatePreferences(c.get("user").id, c.req.valid("json"));
  return c.json(await meView(c.get("user")));
});

api.get("/boards", async (c) => c.json(await listBoardsForUser(c.get("user"))));

api.get("/notifications", async (c) => c.json(await listNotifications(c.get("user"))));

// An empty body means "mark everything read"; a list of ids marks just those.
api.post("/notifications/read", async (c) => {
  const parsed = markNotificationsReadSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid" }, 400);
  return c.json(await markNotificationsRead(c.get("user"), parsed.data.ids));
});

api.get("/boards/:slug", async (c) => {
  const board = await getBoardBySlug(c.req.param("slug"));
  if (!board) return c.json({ error: "not_found" }, 404);
  if (!(await canAccessBoard(c.get("user"), board.id))) return c.json({ error: "forbidden" }, 403);
  const members = await listMentionable(board.id);
  const view: BoardView = {
    board,
    cards: await listCards(board.id),
    // See BoardMember: the emails go to the Admin alone.
    members: c.get("user").role === "admin" ? members : members.map(({ email: _email, ...member }) => member),
    people: await listBoardPeople(board.id),
    agent: await getAgentProfile(),
  };
  return c.json(view);
});

api.get("/boards/:slug/events", async (c) => {
  const board = await getBoardBySlug(c.req.param("slug"));
  if (!board) return c.json({ error: "not_found" }, 404);
  if (!(await canAccessBoard(c.get("user"), board.id))) return c.json({ error: "forbidden" }, 403);
  const userId = c.get("user").id;
  return streamSSE(c, async (stream) => {
    let id = 0;
    const unsubscribe = subscribe(board.id, (event) => {
      void stream.writeSSE({ id: String(id++), event: event.type, data: JSON.stringify(event) });
    });
    stream.onAbort(unsubscribe);
    await stream.writeSSE({ event: "ready", data: "{}" });
    while (!stream.aborted) {
      await stream.sleep(EVENTS_PING_MS);
      // Access is checked again at every ping, so a User revoked, removed, or taken off the Board
      // stops receiving its changes within one interval rather than for as long as the tab stays
      // open. Aborting unsubscribes and ends the response, and the client's reconnect is refused
      // like any other request of theirs.
      if (!(await mayStillWatch(userId, board.id))) return stream.abort();
      await stream.writeSSE({ event: "ping", data: "{}" });
    }
  });
});

api.post("/boards/:slug/cards", json(createCardSchema), async (c) => {
  const board = await getBoardBySlug(c.req.param("slug"));
  if (!board) return c.json({ error: "not_found" }, 404);
  if (!(await canAccessBoard(c.get("user"), board.id))) return c.json({ error: "forbidden" }, 403);
  const input = c.req.valid("json");
  const column = c.get("user").role === "admin" ? input.column : "inbox";
  const card = await createCard({ boardId: board.id, ...input, column, actor: actorOf(c) });
  return c.json(card, 201);
});

api.get("/cards/:id", async (c) => {
  const card = await getCard(c.req.param("id"));
  if (!card) return c.json({ error: "not_found" }, 404);
  const access = await boardForUser(c as never, card.boardId);
  if ("error" in access) return access.error;
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

// The card sheet calls this as it opens: whatever the bell held about this Card has now been seen.
api.post("/cards/:id/read", async (c) => {
  const card = await getCard(c.req.param("id"));
  if (!card) return c.json({ error: "not_found" }, 404);
  const access = await boardForUser(c as never, card.boardId);
  if ("error" in access) return access.error;
  return c.json(await markCardNotificationsRead(c.get("user"), card.id));
});

api.patch("/cards/:id", json(updateCardSchema), async (c) => {
  const card = await getCard(c.req.param("id"));
  if (!card) return c.json({ error: "not_found" }, 404);
  const access = await boardForUser(c as never, card.boardId);
  if ("error" in access) return access.error;
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
  const access = await boardForUser(c as never, card.boardId);
  if ("error" in access) return access.error;
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
  const access = await boardForUser(c as never, card.boardId);
  if ("error" in access) return access.error;
  const input = c.req.valid("json");
  const comment = await createComment({ cardId: card.id, ...input, actor: actorOf(c) });
  return c.json(comment, 201);
});

api.patch("/comments/:id", json(updateCommentSchema), async (c) => {
  const comment = await getComment(c.req.param("id"));
  if (!comment) return c.json({ error: "not_found" }, 404);
  // Authorship alone is not enough: a Member who has lost the Board must not be able to change what
  // it says by editing an old Comment.
  const card = (await getCard(comment.cardId))!;
  const access = await boardForUser(c as never, card.boardId);
  if ("error" in access) return access.error;
  const user = c.get("user");
  if (!(comment.authorKind === "user" && comment.authorId === user.id)) return c.json({ error: "forbidden" }, 403);
  return c.json(await updateComment(comment.id, { body: c.req.valid("json").body, actor: actorOf(c) }));
});

// A Comment's author may delete it, and so may the Admin, who alone can remove the Agent's. As with
// an edit, the author must still be able to open the Board.
// For good, with everything on the Card: see deleteCard. The Admin may delete any Card, a Member one
// they created.
api.delete("/cards/:id", async (c) => {
  const card = await getCard(c.req.param("id"));
  if (!card) return c.json({ error: "not_found" }, 404);
  const access = await boardForUser(c as never, card.boardId);
  if ("error" in access) return access.error;
  if (!mayDeleteCard(c.get("user"), card)) return c.json({ error: "Only the Admin, or the person who created this card, can delete it." }, 403);
  await deleteCard(card.id, actorOf(c));
  return c.body(null, 204);
});

api.delete("/comments/:id", async (c) => {
  const comment = await getComment(c.req.param("id"));
  if (!comment) return c.json({ error: "not_found" }, 404);
  const card = (await getCard(comment.cardId))!;
  const access = await boardForUser(c as never, card.boardId);
  if ("error" in access) return access.error;
  const user = c.get("user");
  const mine = comment.authorKind === "user" && comment.authorId === user.id;
  if (!mine && user.role !== "admin") return c.json({ error: "forbidden" }, 403);
  await deleteComment(comment.id, actorOf(c));
  return c.body(null, 204);
});

// The multipart body is read into memory, so it is refused as it streams in once it passes the
// limit, rather than after all of it has arrived.
const uploadLimit = bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES + 1024 * 1024, onError: (c) => c.json({ error: "file exceeds 25 MB" }, 413) });

api.post("/comments/:id/attachments", uploadLimit, async (c) => {
  const comment = await getComment(c.req.param("id"));
  if (!comment) return c.json({ error: "not_found" }, 404);
  const card = (await getCard(comment.cardId))!;
  const access = await boardForUser(c as never, card.boardId);
  if ("error" in access) return access.error;
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
  const card = (await getCard(att.cardId))!;
  const access = await boardForUser(c as never, card.boardId);
  if ("error" in access) return access.error;
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
const admin = new Hono<{ Variables: AuthVariables }>();
admin.use("*", requireAdmin);

admin.get("/users", async (c) => c.json(await listUsers()));
admin.post("/users", json(inviteUserSchema), async (c) => {
  const user = await inviteUser(c.req.valid("json"));
  await sendInvitation(user, c.get("user"));
  return c.json(user, 201);
});
admin.post("/users/:id/revoke", async (c) => {
  if (c.req.param("id") === c.get("user").id) return c.json({ error: "cannot revoke yourself" }, 400);
  await setUserStatus(c.req.param("id"), "revoked");
  return c.json({ ok: true });
});
admin.post("/users/:id/reinstate", async (c) => {
  if (await isRemoved(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
  await setUserStatus(c.req.param("id"), "invited");
  const user = await getUser(c.req.param("id"));
  if (user) await sendInvitation(user, c.get("user"));
  return c.json({ ok: true });
});
// The first invitation can be missed; an Admin can send it again without re-entering the address.
admin.post("/users/:id/resend-invitation", async (c) => {
  const user = await getUser(c.req.param("id"));
  if (!user || (await isRemoved(user.id))) return c.json({ error: "not_found" }, 404);
  return c.json({ sent: await sendInvitation(user, c.get("user")) });
});

// Only a revoked User, so removing someone is always the second of two steps.
admin.delete("/users/:id", async (c) => {
  if (c.req.param("id") === c.get("user").id) return c.json({ error: "You cannot remove yourself." }, 400);
  try {
    await removeUser(c.req.param("id"));
  } catch (err) {
    if (err instanceof RemoveRefused) return c.json({ error: err.message }, err.message === "not_found" ? 404 : 409);
    throw err;
  }
  return c.json({ ok: true });
});

admin.get("/boards", async (c) => {
  const boards = await listAllBoards();
  const withMembers = await Promise.all(boards.map(async (b) => ({ ...b, memberIds: (await listMembers(b.id)).filter((m) => m.role !== "admin").map((m) => m.id) })));
  return c.json(withMembers);
});
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
// Access tokens for the Admin's own agent, one Board each. The secret is in the creation response
// and nowhere else.
admin.get("/boards/:id/tokens", async (c) => {
  const board = await getBoardById(c.req.param("id"));
  if (!board) return c.json({ error: "not_found" }, 404);
  return c.json(await listAccessTokens(board.id));
});
admin.post("/boards/:id/tokens", json(createAccessTokenSchema), async (c) => {
  const board = await getBoardById(c.req.param("id"));
  if (!board) return c.json({ error: "not_found" }, 404);
  return c.json(await createAccessToken(board.id, c.req.valid("json").name, actorOf(c)), 201);
});
admin.delete("/boards/:id/tokens/:tokenId", async (c) => {
  const revoked = await revokeAccessToken(c.req.param("id"), c.req.param("tokenId"), actorOf(c));
  return revoked ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});
admin.put("/boards/:id/members", json(boardMembersSchema), async (c) => {
  await setMembers(c.req.param("id"), c.req.valid("json").userIds);
  return c.json({ ok: true });
});

admin.get("/settings", async (c) => c.json(await getSettings()));
admin.patch("/settings", json(settingsSchema), async (c) => c.json(await updateSettings(c.req.valid("json"))));

admin.get("/backups", (c) => c.json(backupsView()));
admin.post("/backups", async (c) => {
  const { snapshot } = await takeSnapshot();
  return c.json({ ...backupsView(), snapshot }, 201);
});

api.route("/admin", admin);
