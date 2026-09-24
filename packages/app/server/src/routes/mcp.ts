import { Hono } from "hono";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { COLUMNS, COLUMN_LABELS, PRIORITIES } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { findSessionByToken, endSession, listBoardSessions } from "../services/orchestrator.js";
import { getBoardById } from "../services/boards.js";
import { createCard, getCard, listCards, moveCard, setCardWorkState, toSessionSummary } from "../services/cards.js";
import { createComment, getAttachment, listComments } from "../services/comments.js";
import { getUsersByIds } from "../services/users.js";
import { recordEvent } from "../services/events.js";
import { publish } from "../services/realtime.js";
import { previewUrlFor, startPreview } from "../services/previews.js";

type SessionRow = typeof schema.sessions.$inferSelect;

// The agent-native interface. Every tool runs under a Session's identity; authorization is the
// Session's Board plus, for pull-request state, its own Card. Sweeps cannot touch work state.
function buildServer(session: SessionRow): McpServer {
  const server = new McpServer({ name: "kardboard", version: "0.1.0" });
  const actor = { kind: "agent" as const, id: null };

  async function assertBoardCard(cardId: string) {
    const card = await getCard(cardId);
    if (!card || card.boardId !== session.boardId) throw new Error("card not on this session's board");
    return card;
  }

  server.registerTool(
    "get_ledger",
    { description: "List the sessions active on this board right now, with their card, branch, and announced intent. Read this first.", inputSchema: {} },
    async () => {
      const sessions = (await listBoardSessions(session.boardId, 50)).filter((s) => s.status === "running" || s.status === "starting" || s.status === "queued");
      return { content: [{ type: "text", text: JSON.stringify({ you: session.id, sessions }, null, 2) }] };
    },
  );

  server.registerTool(
    "announce_intent",
    { description: "Publish a one-line intent and the code areas you expect to touch, so other sessions can avoid you.", inputSchema: { intent: z.string().min(1).max(300) } },
    async ({ intent }) => {
      await db.update(schema.sessions).set({ intent }).where(eq(schema.sessions.id, session.id));
      const row = (await db.select().from(schema.sessions).where(eq(schema.sessions.id, session.id)).get())!;
      publish(session.boardId, { type: "session.updated", session: toSessionSummary(row) });
      if (session.cardId) publish(session.boardId, { type: "card.upserted", card: (await getCard(session.cardId))! });
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  server.registerTool(
    "get_board",
    { description: "The board's settings and every card on it, grouped by column, with creator names.", inputSchema: {} },
    async () => {
      const board = await getBoardById(session.boardId);
      const cards = await listCards(session.boardId);
      const users = await getUsersByIds(cards.map((c) => c.creatorId).filter((x): x is string => Boolean(x)));
      const grouped = Object.fromEntries(COLUMNS.map((col) => [col, cards.filter((c) => c.column === col).map((c) => ({ id: c.id, title: c.title, priority: c.priority, creator: c.creatorId ? users.get(c.creatorId)?.name : c.creatorKind, branch: c.branch, prUrl: c.prUrl, activeSession: c.activeSession?.id ?? null, updatedAt: c.updatedAt }))]));
      return { content: [{ type: "text", text: JSON.stringify({ board: { name: board?.name, repoUrl: board?.repoUrl, previewMode: board?.previewMode }, columns: COLUMN_LABELS, cards: grouped }, null, 2) }] };
    },
  );

  server.registerTool(
    "get_card",
    { description: "Full detail for one card: description, comments with author handles, attachments, and work state. Omit card_id for your own card.", inputSchema: { card_id: z.string().optional() } },
    async ({ card_id }) => {
      const id = card_id ?? session.cardId;
      if (!id) throw new Error("card_id required for a sweep session");
      const card = await assertBoardCard(id);
      const comments = await listComments(id);
      const users = await getUsersByIds([card.creatorId, ...comments.map((c) => c.authorId)].filter((x): x is string => Boolean(x)));
      const out = {
        ...card,
        creator: card.creatorId ? users.get(card.creatorId) : null,
        comments: comments.map((c) => ({ id: c.id, author: c.authorKind === "agent" ? "you" : (users.get(c.authorId ?? "")?.name ?? "unknown"), authorHandle: users.get(c.authorId ?? "")?.handle ?? null, body: c.body, createdAt: c.createdAt, editedAt: c.editedAt, attachments: c.attachments })),
      };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    },
  );

  server.registerTool(
    "read_attachment",
    { description: "Fetch an attachment by id. Images come back as image content; other files as text when small.", inputSchema: { attachment_id: z.string() } },
    async ({ attachment_id }) => {
      const att = await getAttachment(attachment_id);
      if (!att) throw new Error("attachment not found");
      await assertBoardCard(att.cardId);
      const file = path.join(env.dataDir, "uploads", att.sha256.slice(0, 2), att.sha256);
      const bytes = fs.readFileSync(file);
      if (att.mime.startsWith("image/")) return { content: [{ type: "image", data: bytes.toString("base64"), mimeType: att.mime }] };
      if (bytes.length > 200_000) return { content: [{ type: "text", text: `(${att.filename}: ${bytes.length} bytes, too large to inline)` }] };
      return { content: [{ type: "text", text: bytes.toString("utf8") }] };
    },
  );

  server.registerTool(
    "post_comment",
    { description: "Post a comment as the agent. Mention people with @handle. Keep it to what the reader needs.", inputSchema: { card_id: z.string().optional(), body: z.string().min(1).max(20_000) } },
    async ({ card_id, body }) => {
      const id = card_id ?? session.cardId;
      if (!id) throw new Error("card_id required for a sweep session");
      await assertBoardCard(id);
      const comment = await createComment({ cardId: id, body, actor, sessionId: session.id });
      return { content: [{ type: "text", text: JSON.stringify({ commentId: comment.id }) }] };
    },
  );

  server.registerTool(
    "move_card",
    { description: "Move a card to a column. Explain any move of someone else's card in a comment.", inputSchema: { card_id: z.string().optional(), column: z.enum(COLUMNS) } },
    async ({ card_id, column }) => {
      const id = card_id ?? session.cardId;
      if (!id) throw new Error("card_id required for a sweep session");
      const card = await assertBoardCard(id);
      await moveCard(id, { column, position: card.position, revision: card.revision, actor });
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  server.registerTool(
    "create_card",
    { description: "Create a card in any column except Inbox, which is reserved for humans. Set parent_card_id when splitting a request: a child card left in Ready starts its own session immediately, and the parent wakes once every child reaches Done. A card with no parent starts nothing and waits in Ready for a person.", inputSchema: { title: z.string().min(1).max(200), description: z.string().max(20_000).default(""), column: z.enum(COLUMNS.filter((c) => c !== "inbox") as [string, ...string[]]).default("ready"), priority: z.enum(PRIORITIES).default("none"), parent_card_id: z.string().optional() } },
    async ({ title, description, column, priority, parent_card_id }) => {
      if (parent_card_id) await assertBoardCard(parent_card_id);
      const card = await createCard({ boardId: session.boardId, title, description, priority, column: column as (typeof COLUMNS)[number], actor, parentCardId: parent_card_id ?? null });
      return { content: [{ type: "text", text: JSON.stringify({ cardId: card.id }) }] };
    },
  );

  server.registerTool(
    "set_work_state",
    { description: "Record the pull request and preview for your own card.", inputSchema: { pr_url: z.string().url().optional(), pr_number: z.number().int().optional(), preview_url: z.string().url().optional() } },
    async ({ pr_url, pr_number, preview_url }) => {
      if (session.kind !== "card" || !session.cardId) throw new Error("only card sessions can set work state");
      await setCardWorkState(session.cardId, { prUrl: pr_url, prNumber: pr_number, previewUrl: preview_url });
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  server.registerTool(
    "request_preview",
    {
      description: "Build this card's branch and host it as a preview (runner preview mode only). Returns the URL at once; the build finishes in the background. Push the branch first.",
      inputSchema: {},
    },
    async () => {
      if (session.kind !== "card" || !session.cardId) throw new Error("only card sessions can request a preview");
      const preview = await startPreview(session.cardId);
      const url = previewUrlFor(preview.host);
      await setCardWorkState(session.cardId, { previewUrl: url });
      await recordEvent({ boardId: session.boardId, cardId: session.cardId, actor, type: "preview.requested", payload: { previewId: preview.id, host: preview.host } });
      return {
        content: [
          {
            type: "text",
            text: `Building ${preview.branch} from its Dockerfile. The preview will answer at ${url} once the build finishes; until then it shows a holding page. The URL is already recorded on the card.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "finish",
    { description: "End this session with a one-sentence outcome summary. Call it last.", inputSchema: { summary: z.string().min(1).max(500), outcome: z.enum(["succeeded", "failed"]).default("succeeded") } },
    async ({ summary, outcome }) => {
      await recordEvent({ boardId: session.boardId, cardId: session.cardId, actor, type: "session.reported", payload: { sessionId: session.id, summary } });
      setTimeout(() => void endSession(session.id, outcome, summary), 500);
      return { content: [{ type: "text", text: "ok, goodbye" }] };
    },
  );

  return server;
}

export const mcp = new Hono<{ Bindings: { incoming: IncomingMessage; outgoing: ServerResponse } }>();

mcp.all("/", async (c) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = token ? await findSessionByToken(token) : null;
  if (!session) return c.json({ error: "unauthorized" }, 401);
  // Stateless transport: one server per request keeps the session identity bound to the token.
  const server = buildServer(session);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  const body = c.req.method === "POST" ? await c.req.json().catch(() => undefined) : undefined;
  await transport.handleRequest(c.env.incoming, c.env.outgoing, body);
  return RESPONSE_ALREADY_SENT;
});
