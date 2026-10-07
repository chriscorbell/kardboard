import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { inArray, sql } from "drizzle-orm";
import { COLUMNS, COLUMN_LABELS, PRIORITIES } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { getBoardById, listMembers } from "../services/boards.js";
import { ConflictError, createCard, edgePosition, getCard, listCards, listChildren, moveCard, setCardWorkState, updateCard } from "../services/cards.js";
import { createComment, getAttachment, listComments } from "../services/comments.js";
import { getUsersByIds } from "../services/users.js";
import { recordEvent } from "../services/events.js";
import { parseRepoUrl } from "../services/repository.js";
import { attachmentContent } from "../services/attachment-content.js";
import { ACCESS_TOKEN_PREFIX, findAccessToken } from "../services/access-tokens.js";
import { deleteCard } from "../services/card-deletion.js";
import type { AccessToken, Board } from "@kardboard/shared";

// How many of the Done Column's Cards get_board sends by default.
const DONE_SHOWN = 15;

// What get_board sends. Done only grows, and every agent reads the Board, so by default it sends the
// newest few. The members are who an agent may Mention: never their email, which it has no use for.
async function boardSnapshot(boardId: string, includeAllDone: boolean) {
  const board = await getBoardById(boardId);
  const cards = await listCards(boardId);
  const waiting = await repliesWaiting(cards.map((c) => c.id));
  const users = await getUsersByIds(cards.map((c) => c.creatorId).filter((x): x is string => Boolean(x)));
  const members = (await listMembers(boardId)).filter((u) => u.status !== "revoked").map((u) => ({ id: u.id, name: u.name, handle: u.handle, role: u.role }));
  const summary = (c: (typeof cards)[number]) => ({ id: c.id, title: c.title, revision: c.revision, priority: c.priority, creator: c.creatorId ? users.get(c.creatorId)?.name : c.creatorKind, parentCardId: c.parentCardId, branch: c.branch, prUrl: c.prUrl, replyWaiting: waiting.has(c.id), updatedAt: c.updatedAt });
  const done = cards.filter((c) => c.column === "done").sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const shownDone = includeAllDone ? done : done.slice(0, DONE_SHOWN);
  const grouped = Object.fromEntries(COLUMNS.map((col) => [col, (col === "done" ? shownDone : cards.filter((c) => c.column === col)).map(summary)]));
  return { board: { name: board?.name, repoUrl: board?.repoUrl }, columns: COLUMN_LABELS, members, cards: grouped, doneOmitted: done.length - shownDone.length };
}

// The Cards where a person has commented since the Agent last did: an answer to its question, or more
// to go on. People see the Agent's unanswered questions on the Board; this is the same fact turned
// round, for an agent that works the Board only when asked and has to find what changed meanwhile.
async function repliesWaiting(cardIds: string[]): Promise<Set<string>> {
  if (cardIds.length === 0) return new Set();
  const rows = await db
    .select({
      cardId: schema.comments.cardId,
      lastAgent: sql<string | null>`max(case when ${schema.comments.authorKind} = 'agent' then ${schema.comments.createdAt} end)`,
      lastPerson: sql<string | null>`max(case when ${schema.comments.authorKind} = 'user' then ${schema.comments.createdAt} end)`,
    })
    .from(schema.comments)
    .where(inArray(schema.comments.cardId, cardIds))
    .groupBy(schema.comments.cardId);
  return new Set(rows.filter((r) => r.lastAgent && r.lastPerson && r.lastPerson > r.lastAgent).map((r) => r.cardId));
}

// What get_card sends.
async function cardSnapshot(id: string) {
  const card = (await getCard(id))!;
  const comments = await listComments(id);
  const users = await getUsersByIds([card.creatorId, ...comments.map((c) => c.authorId)].filter((x): x is string => Boolean(x)));
  // A name and handle to address someone by. The rest of a User record, email included, stays out.
  const person = (userId: string | null) => {
    const u = userId ? users.get(userId) : undefined;
    return u ? { name: u.name, handle: u.handle } : null;
  };
  const children = await listChildren(id);
  return {
    ...card,
    creator: person(card.creatorId),
    comments: comments.map((c) => ({ id: c.id, author: c.authorKind === "agent" ? "you" : c.authorKind === "system" ? "kardboard" : (users.get(c.authorId ?? "")?.name ?? "unknown"), authorHandle: users.get(c.authorId ?? "")?.handle ?? null, body: c.body, createdAt: c.createdAt, editedAt: c.editedAt, attachments: c.attachments })),
    children: children.map((c) => ({ id: c.id, title: c.title, column: c.column, outcome: c.outcome })),
  };
}

async function attachmentOnBoard(boardId: string, attachmentId: string) {
  const att = await getAttachment(attachmentId);
  if (!att) throw new Error("attachment not found");
  const card = await getCard(att.cardId);
  if (!card || card.boardId !== boardId) throw new Error("attachment not on this board");
  const file = path.join(env.dataDir, "uploads", att.sha256.slice(0, 2), att.sha256);
  return attachmentContent(att, fs.readFileSync(file));
}

// The agent-native interface, for the Admin's own coding agent holding an Access token (ADR 0010).
// Whoever holds the token answers to the Admin, so it may edit and move any Card on its Board.
// kardboard reads none of its pull requests; the agent merges them itself and says so when it closes
// the Card.
const TOKEN_INSTRUCTIONS = `This is a kardboard board: the shared record of work on one project, which you and the people on it read and change. You act on it as its agent. Nothing on this board starts on its own. You work it when the person running you asks, and people move cards by hand.

Read get_board first, and read every card it marks replyWaiting: a person has commented there since you last did, often answering your question. The columns: Backlog, column inbox, holds new requests not yet looked at. Blocked holds cards waiting on a person's answer. Ready holds understood cards nobody has started. In Progress holds cards being worked on. Review holds cards whose pull request is open for a look. Done holds merged, closed, or duplicate cards.

Keep the board true to the work. Move a card to In Progress when you start it. If you need a person's answer, ask in a comment that mentions them by @handle and move the card to Blocked. Once its pull request is open, record it with link_pull_request and move the card to Review. When you have merged the pull request, move the card to Done with merged set. Every edit and move takes the revision you last read: if the card changed since, read it again before deciding.`;

function buildTokenServer(board: Board, token: AccessToken): McpServer {
  const server = new McpServer({ name: "kardboard", version: "0.1.0" }, { instructions: TOKEN_INSTRUCTIONS });
  const actor = { kind: "agent" as const, id: null, accessTokenId: token.id };

  async function assertBoardCard(cardId: string) {
    const card = await getCard(cardId);
    if (!card || card.boardId !== board.id) throw new Error(`card ${cardId} is not on this board`);
    return card;
  }

  async function conflict(id: string, revision: number): Promise<Error> {
    const now = (await getCard(id))!;
    return new Error(`card ${id} changed after revision ${revision}: it is now at revision ${now.revision} in ${COLUMN_LABELS[now.column]}. Read it again with get_card before deciding whether the change still makes sense.`);
  }

  server.registerTool(
    "get_board",
    {
      description: `The board's name and repository, its members with their @handles and roles, and every card on it grouped by column, with creator names and each card's revision. replyWaiting marks a card where a person has commented since you last did: read it with get_card. Done lists only the ${DONE_SHOWN} most recently changed cards unless include_all_done is true; doneOmitted says how many were left out.`,
      inputSchema: { include_all_done: z.boolean().default(false) },
    },
    async ({ include_all_done }) => ({ content: [{ type: "text", text: JSON.stringify(await boardSnapshot(board.id, include_all_done), null, 2) }] }),
  );

  server.registerTool(
    "get_card",
    {
      description: "Full detail for one card: description, comments with author handles (yours are marked you), attachments, its branch and pull request, its parent and child cards, and the revision to pass to update_card and move_card.",
      inputSchema: { card_id: z.string() },
    },
    async ({ card_id }) => {
      await assertBoardCard(card_id);
      return { content: [{ type: "text", text: JSON.stringify(await cardSnapshot(card_id), null, 2) }] };
    },
  );

  server.registerTool(
    "read_attachment",
    { description: "Fetch an attachment by id. PNG, JPEG, GIF, and WebP images up to 3.75 MB come back as images and text files as text; any other file, such as a PDF or a larger image, comes back as a one-line note of its name, type, and size.", inputSchema: { attachment_id: z.string() } },
    async ({ attachment_id }) => ({ content: [await attachmentOnBoard(board.id, attachment_id)] }),
  );

  server.registerTool(
    "create_card",
    {
      description: "Create a card. A new request goes in Backlog, column inbox; one already understood well enough to start goes in Ready. Give it a title that says what it asks for, and a description with what someone picking it up needs. A column reads top down, so position top puts the card first, as what to take next; it goes to the bottom otherwise.",
      inputSchema: { title: z.string().trim().min(1).max(200), description: z.string().max(20_000).default(""), column: z.enum(COLUMNS).default("inbox"), priority: z.enum(PRIORITIES).default("none"), position: z.enum(["top", "bottom"]).default("bottom") },
    },
    async ({ title, description, column, priority, position }) => {
      const card = await createCard({ boardId: board.id, title, description, priority, column, actor, at: position });
      return { content: [{ type: "text", text: JSON.stringify({ cardId: card.id, revision: card.revision }) }] };
    },
  );

  // Every edit keeps the words it replaced in the Card's history, so rewriting a Card loses nothing.
  server.registerTool(
    "update_card",
    {
      description: "Change a card's title, description, or priority. When you rewrite a card someone else wrote, keep everything they asked for, and say what you changed in a comment. Pass the revision from your latest get_card or get_board: if the card has changed since, the edit is refused and you should read it again.",
      inputSchema: {
        card_id: z.string(),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(20_000).optional(),
        priority: z.enum(PRIORITIES).optional(),
        revision: z.number().int().nonnegative(),
      },
    },
    async ({ card_id, title, description, priority, revision }) => {
      await assertBoardCard(card_id);
      if (title === undefined && description === undefined && priority === undefined) throw new Error("nothing to change: pass a title, a description, or a priority");
      let card;
      try {
        card = await updateCard(card_id, { title, description, priority, revision, actor });
      } catch (err) {
        if (err instanceof ConflictError) throw await conflict(card_id, revision);
        throw err;
      }
      return { content: [{ type: "text", text: JSON.stringify({ cardId: card.id, revision: card.revision, title: card.title, priority: card.priority }) }] };
    },
  );

  server.registerTool(
    "move_card",
    {
      description:
        "Move a card to a column: In Progress when you start it, Blocked with a comment when you need a person's answer, Review once its pull request is open and recorded with link_pull_request, Done when it is finished. Set merged when you merged the card's pull request yourself and are moving it to Done: the card records the merge and closes as implemented, not merely closed. A column reads top down: a card moved to another column goes to its bottom unless position is top, and position with the card's own column reorders it there. Pass the revision from your latest get_card or get_board: if the card has changed since, the move is refused and you should read it again.",
      inputSchema: { card_id: z.string(), column: z.enum(COLUMNS), revision: z.number().int().nonnegative(), merged: z.boolean().default(false), position: z.enum(["top", "bottom"]).optional() },
    },
    async ({ card_id, column, revision, merged, position }) => {
      const card = await assertBoardCard(card_id);
      if (merged && column !== "done") throw new Error("merged goes with a move to Done: it says you merged the card's pull request and are closing the card.");
      if (column === card.column && !position) throw new Error(`card ${card_id} is already in ${COLUMN_LABELS[column]}: pass position top or bottom to reorder it there.`);
      let moved;
      try {
        moved = await moveCard(card_id, { column, position: await edgePosition(board.id, column, position ?? "bottom"), revision, actor, merged });
      } catch (err) {
        if (err instanceof ConflictError) throw await conflict(card_id, revision);
        throw err;
      }
      return { content: [{ type: "text", text: JSON.stringify({ column: moved.column, revision: moved.revision, ...(moved.outcome ? { outcome: moved.outcome } : {}) }) }] };
    },
  );

  // Only the Agent's own Cards: a person's words are theirs to withdraw, and Done is how the Agent
  // closes one of theirs.
  server.registerTool(
    "delete_card",
    {
      description: "Delete a card the agent created, with its comments and attachments, for good: a duplicate, or a card made by mistake. A card a person created is refused; move it to Done instead. Pass the revision from your latest get_card or get_board: if the card has changed since, the delete is refused and you should read it again.",
      inputSchema: { card_id: z.string(), revision: z.number().int().nonnegative() },
    },
    async ({ card_id, revision }) => {
      const card = await assertBoardCard(card_id);
      if (card.creatorKind !== "agent") throw new Error(`card ${card_id} was created by a person, and only a card the agent created can be deleted here. Move it to Done instead.`);
      if (card.revision !== revision) throw await conflict(card_id, revision);
      await deleteCard(card_id, actor);
      return { content: [{ type: "text", text: JSON.stringify({ deleted: card_id }) }] };
    },
  );

  server.registerTool(
    "post_comment",
    { description: "Post a comment on a card as the agent. Mention people with @handle, which notifies them. Keep it to what the reader needs.", inputSchema: { card_id: z.string(), body: z.string().min(1).max(20_000) } },
    async ({ card_id, body }) => {
      await assertBoardCard(card_id);
      const comment = await createComment({ cardId: card_id, body, actor });
      return { content: [{ type: "text", text: JSON.stringify({ commentId: comment.id }) }] };
    },
  );

  // Recorded as given: kardboard asks GitHub nothing. It only checks the pull request is in the
  // Board's repository.
  server.registerTool(
    "link_pull_request",
    {
      description: "Record a card's pull request, and the branch it comes from, so the card links to both. Call it once the pull request is open. kardboard does not read or merge it; you do.",
      inputSchema: { card_id: z.string(), pr_url: z.string().url(), branch: z.string().trim().min(1).max(200).optional() },
    },
    async ({ card_id, pr_url, branch }) => {
      await assertBoardCard(card_id);
      const pr = parsePullRequestUrl(pr_url);
      if (!pr) throw new Error(`${pr_url} is not a GitHub pull request URL, such as https://github.com/owner/repo/pull/12`);
      const repo = parseRepoUrl(board.repoUrl);
      if (repo && (repo.owner.toLowerCase() !== pr.owner.toLowerCase() || repo.repo.toLowerCase() !== pr.repo.toLowerCase())) {
        throw new Error(`that pull request is in ${pr.owner}/${pr.repo}, but this board's repository is ${repo.owner}/${repo.repo}`);
      }
      const card = await setCardWorkState(card_id, { prUrl: pr_url, prNumber: pr.number, ...(branch ? { branch } : {}) });
      await recordEvent({ boardId: board.id, cardId: card_id, actor, type: "card.pr_linked", payload: { prNumber: pr.number, prUrl: pr_url } });
      return { content: [{ type: "text", text: JSON.stringify({ cardId: card.id, prUrl: card.prUrl, prNumber: card.prNumber, branch: card.branch }) }] };
    },
  );

  return server;
}

function parsePullRequestUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url);
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}

export const mcp = new Hono<{ Bindings: { incoming: IncomingMessage; outgoing: ServerResponse } }>();

// The body is parsed in memory, so it is refused as it streams in once it passes 1 MB. No tool takes
// file bytes; the largest call, a Card's 20,000-character description, is a small fraction of that.
const requestLimit = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "request body exceeds 1 MB" }, 413) });

mcp.all("/", requestLimit, async (c) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const access = token.startsWith(ACCESS_TOKEN_PREFIX) ? await findAccessToken(token) : null;
  const board = access ? await getBoardById(access.boardId) : null;
  if (!access || !board) return c.json({ error: "unauthorized" }, 401);
  const server = buildTokenServer(board, access);
  // Stateless transport: one server per request keeps the identity bound to the token.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  const body = c.req.method === "POST" ? await c.req.json().catch(() => undefined) : undefined;
  await transport.handleRequest(c.env.incoming, c.env.outgoing, body);
  return RESPONSE_ALREADY_SENT;
});
