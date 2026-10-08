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
import { COLUMNS, COLUMN_LABELS, PRIORITIES, slugify, upsertBoardSchema, type AccessToken, type Board, type Card } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { createBoard, findBoard, getBoardById, getBoardBySlug, listAllBoards } from "../services/boards.js";
import { ConflictError, createCard, edgePosition, getCard, listCards, listChildren, moveCard, setCardWorkState, updateCard } from "../services/cards.js";
import { createComment, getAttachment, listComments } from "../services/comments.js";
import { getUsersByIds } from "../services/users.js";
import { recordEvent } from "../services/events.js";
import { parseRepoUrl, repositoryKey } from "../services/repository.js";
import { attachmentContent } from "../services/attachment-content.js";
import { ACCESS_TOKEN_PREFIX, findAccessToken } from "../services/access-tokens.js";
import { deleteCard } from "../services/card-deletion.js";

// How many of the Done Column's Cards get_board sends by default.
const DONE_SHOWN = 15;

// What get_board sends. Done only grows, and every agent reads the Board, so by default it sends the
// newest few.
async function boardSnapshot(board: Board, includeAllDone: boolean) {
  const cards = await listCards(board.id);
  const waiting = await repliesWaiting(cards.map((c) => c.id));
  const users = await getUsersByIds(cards.map((c) => c.creatorId).filter((x): x is string => Boolean(x)));
  const summary = (c: (typeof cards)[number]) => ({ id: c.id, title: c.title, revision: c.revision, priority: c.priority, creator: c.creatorId ? users.get(c.creatorId)?.name : c.creatorKind, parentCardId: c.parentCardId, branch: c.branch, prUrl: c.prUrl, replyWaiting: waiting.has(c.id), updatedAt: c.updatedAt });
  const done = cards.filter((c) => c.column === "done").sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const shownDone = includeAllDone ? done : done.slice(0, DONE_SHOWN);
  const grouped = Object.fromEntries(COLUMNS.map((col) => [col, (col === "done" ? shownDone : cards.filter((c) => c.column === col)).map(summary)]));
  return { board: { slug: board.slug, name: board.name, repoUrl: board.repoUrl }, columns: COLUMN_LABELS, cards: grouped, doneOmitted: done.length - shownDone.length };
}

// What list_boards sends: every Board with how much is open on it and how many answers wait there, so
// an agent can see where it is needed without reading each one.
async function boardsSnapshot() {
  const boards = await listAllBoards();
  const out = [];
  for (const board of boards) {
    const cards = await listCards(board.id);
    const open = Object.fromEntries(COLUMNS.filter((col) => col !== "done").map((col) => [col, cards.filter((c) => c.column === col).length]));
    const waiting = await repliesWaiting(cards.filter((c) => c.column !== "done").map((c) => c.id));
    out.push({ slug: board.slug, name: board.name, repoUrl: board.repoUrl, open, replyWaiting: waiting.size });
  }
  return { boards: out };
}

// The Cards where the User has commented since the Agent last did: an answer to its question, or more
// to go on. The User sees the Agent's unanswered questions on the Board; this is the same fact turned
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

// What get_card sends, with the Board it is on.
async function cardSnapshot(card: Card) {
  const board = await getBoardById(card.boardId);
  const comments = await listComments(card.id);
  const users = await getUsersByIds([card.creatorId, ...comments.map((c) => c.authorId)].filter((x): x is string => Boolean(x)));
  // A name to call someone by. The rest of a User record, email included, stays out.
  const person = (userId: string | null) => {
    const u = userId ? users.get(userId) : undefined;
    return u ? { name: u.name } : null;
  };
  const children = await listChildren(card.id);
  return {
    ...card,
    board: board ? { slug: board.slug, name: board.name } : null,
    creator: person(card.creatorId),
    comments: comments.map((c) => ({ id: c.id, author: c.authorKind === "agent" ? "you" : c.authorKind === "system" ? "kardboard" : (users.get(c.authorId ?? "")?.name ?? "unknown"), body: c.body, createdAt: c.createdAt, editedAt: c.editedAt, attachments: c.attachments })),
    children: children.map((c) => ({ id: c.id, title: c.title, column: c.column, outcome: c.outcome })),
  };
}

async function attachmentById(attachmentId: string) {
  const att = await getAttachment(attachmentId);
  if (!att) throw new Error("attachment not found");
  const file = path.join(env.dataDir, "uploads", att.sha256.slice(0, 2), att.sha256);
  return attachmentContent(att, fs.readFileSync(file));
}

// The agent-native interface, for the User's own coding agents, each holding an Access token that
// reaches every Board (ADR 0012). Whoever holds one answers to the User, so it may edit and move any
// Card. kardboard reads none of its pull requests; the agent merges them itself and says so when it
// closes the Card.
const TOKEN_INSTRUCTIONS = `This is kardboard: a kanban board for every project of the person running you, which they and their coding agents keep up to date. You act on it as their agent. Nothing on it starts on its own: you work a card when the person asks you to.

Find the board for the repository you are working in: pass the output of \`git remote get-url origin\` as board to get_board, and kardboard matches it to a board's repository. list_boards shows every board. When no board matches, ask the person whether to create one with create_board, named after the project and with its repository.

Read get_board when you start, and read every card it marks replyWaiting: the person has commented there since you last did, often answering your question. The columns: Backlog, column inbox, holds new cards not yet looked at. Blocked holds cards waiting on the person's answer. Ready holds understood cards nobody has started. In Progress holds cards being worked on. Review holds cards whose pull request is open for a look. Done holds merged, closed, or duplicate cards.

Keep the board true to the work. Find or create the card for what you are asked to do before starting it, and move it to In Progress. If you need the person's answer, ask in a comment and move the card to Blocked. Once its pull request is open, record it with link_pull_request and move the card to Review. When you have merged the pull request, move the card to Done with merged set. Every edit and move takes the revision you last read: if the card changed since, read it again before deciding.

File side-findings without asking. When you notice something worth doing that is outside the task at hand, such as a bug, a cleanup, or an idea, create a card for it in Backlog on the board it belongs to, and say so in one line of your reply, like "Filed on kardboard: <title>". Give it a title that says what it asks for, and a description someone can act on without this conversation: where you found it, the files involved, and the card you were working on. Do not file what you are about to fix as part of the current task, and do not file the same thing twice: check the board first.`;

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

function buildTokenServer(token: AccessToken): McpServer {
  const server = new McpServer({ name: "kardboard", version: "0.2.0" }, { instructions: TOKEN_INSTRUCTIONS });
  const actor = { kind: "agent" as const, id: null, accessTokenId: token.id };

  async function boardNamed(ref: string): Promise<Board> {
    const board = await findBoard(ref);
    if (!board) throw new Error(`no board matches ${JSON.stringify(ref)}. list_boards shows every board with its slug and repository; create_board makes one for a project that has none.`);
    return board;
  }

  async function cardNamed(cardId: string): Promise<Card> {
    const card = await getCard(cardId);
    if (!card) throw new Error(`card ${cardId} not found`);
    return card;
  }

  async function conflict(id: string, revision: number): Promise<Error> {
    const now = (await getCard(id))!;
    return new Error(`card ${id} changed after revision ${revision}: it is now at revision ${now.revision} in ${COLUMN_LABELS[now.column]}. Read it again with get_card before deciding whether the change still makes sense.`);
  }

  const boardRef = z.string().trim().min(1).describe("The board's slug, or the repository's address as `git remote get-url origin` prints it.");

  server.registerTool(
    "list_boards",
    { description: "Every board, with its slug, name, and repository, how many cards are open in each column, and how many of its cards have a reply from the person waiting for you.", inputSchema: {} },
    async () => text(await boardsSnapshot()),
  );

  server.registerTool(
    "create_board",
    {
      description: "Create a board for a project that has none. Ask the person first. Name it after the project, and give its GitHub repository so agents find it from a checkout; the slug, for its URL, comes from the name unless you give one.",
      inputSchema: { name: z.string().trim().min(1).max(120), repo_url: z.string().trim().min(1).optional(), slug: z.string().trim().min(1).max(48).optional() },
    },
    async ({ name, repo_url, slug }) => {
      const repo = repo_url ? parseRepoUrl(repo_url) : null;
      if (repo_url && !repo) throw new Error(`${repo_url} is not a GitHub repository address, such as https://github.com/owner/repo`);
      const repoUrl = repo ? `https://github.com/${repo.owner}/${repo.repo}` : null;
      if (repoUrl) {
        const taken = (await listAllBoards()).find((b) => repositoryKey(b.repoUrl) === repositoryKey(repoUrl));
        if (taken) throw new Error(`board ${taken.slug} already has ${repoUrl}: use it rather than making another`);
      }
      const parsed = upsertBoardSchema.safeParse({ name, slug: slugify(slug ?? name), repoUrl });
      if (!parsed.success) throw new Error(`that board is not valid: ${parsed.error.issues[0]?.message ?? "check the name and slug"}`);
      if (await getBoardBySlug(parsed.data.slug)) throw new Error(`the slug ${parsed.data.slug} is taken: pass another as slug`);
      const board = await createBoard(parsed.data);
      await recordEvent({ boardId: board.id, actor, type: "board.created", payload: { name: board.name, slug: board.slug } });
      return text({ slug: board.slug, name: board.name, repoUrl: board.repoUrl });
    },
  );

  server.registerTool(
    "get_board",
    {
      description: `A board's name and repository, and every card on it grouped by column, with creator names and each card's revision. replyWaiting marks a card where the person has commented since you last did: read it with get_card. Done lists only the ${DONE_SHOWN} most recently changed cards unless include_all_done is true; doneOmitted says how many were left out.`,
      inputSchema: { board: boardRef, include_all_done: z.boolean().default(false) },
    },
    async ({ board, include_all_done }) => text(await boardSnapshot(await boardNamed(board), include_all_done)),
  );

  server.registerTool(
    "get_card",
    {
      description: "Full detail for one card, on any board: the board it is on, its description, comments with their authors (yours are marked you), attachments, its branch and pull request, its parent and child cards, and the revision to pass to update_card and move_card.",
      inputSchema: { card_id: z.string() },
    },
    async ({ card_id }) => text(await cardSnapshot(await cardNamed(card_id))),
  );

  server.registerTool(
    "read_attachment",
    { description: "Fetch an attachment by id. PNG, JPEG, GIF, and WebP images up to 3.75 MB come back as images and text files as text; any other file, such as a PDF or a larger image, comes back as a one-line note of its name, type, and size.", inputSchema: { attachment_id: z.string() } },
    async ({ attachment_id }) => ({ content: [await attachmentById(attachment_id)] }),
  );

  server.registerTool(
    "create_card",
    {
      description: "Create a card on a board. A new request or a side-finding goes in Backlog, column inbox; one already understood well enough to start goes in Ready. Give it a title that says what it asks for, and a description with what someone picking it up needs. A column reads top down, so position top puts the card first, as what to take next; it goes to the bottom otherwise.",
      inputSchema: { board: boardRef, title: z.string().trim().min(1).max(200), description: z.string().max(20_000).default(""), column: z.enum(COLUMNS).default("inbox"), priority: z.enum(PRIORITIES).default("none"), position: z.enum(["top", "bottom"]).default("bottom") },
    },
    async ({ board, title, description, column, priority, position }) => {
      const target = await boardNamed(board);
      const card = await createCard({ boardId: target.id, title, description, priority, column, actor, at: position });
      return text({ cardId: card.id, board: target.slug, revision: card.revision });
    },
  );

  // Every edit keeps the words it replaced in the Card's history, so rewriting a Card loses nothing.
  server.registerTool(
    "update_card",
    {
      description: "Change a card's title, description, or priority. When you rewrite a card the person wrote, keep everything they asked for, and say what you changed in a comment. Pass the revision from your latest get_card or get_board: if the card has changed since, the edit is refused and you should read it again.",
      inputSchema: {
        card_id: z.string(),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(20_000).optional(),
        priority: z.enum(PRIORITIES).optional(),
        revision: z.number().int().nonnegative(),
      },
    },
    async ({ card_id, title, description, priority, revision }) => {
      await cardNamed(card_id);
      if (title === undefined && description === undefined && priority === undefined) throw new Error("nothing to change: pass a title, a description, or a priority");
      let card;
      try {
        card = await updateCard(card_id, { title, description, priority, revision, actor });
      } catch (err) {
        if (err instanceof ConflictError) throw await conflict(card_id, revision);
        throw err;
      }
      return text({ cardId: card.id, revision: card.revision, title: card.title, priority: card.priority });
    },
  );

  server.registerTool(
    "move_card",
    {
      description:
        "Move a card to a column: In Progress when you start it, Blocked with a comment when you need the person's answer, Review once its pull request is open and recorded with link_pull_request, Done when it is finished. Set merged when you merged the card's pull request yourself and are moving it to Done: the card records the merge and closes as implemented, not merely closed. A column reads top down: a card moved to another column goes to its bottom unless position is top, and position with the card's own column reorders it there. Pass the revision from your latest get_card or get_board: if the card has changed since, the move is refused and you should read it again.",
      inputSchema: { card_id: z.string(), column: z.enum(COLUMNS), revision: z.number().int().nonnegative(), merged: z.boolean().default(false), position: z.enum(["top", "bottom"]).optional() },
    },
    async ({ card_id, column, revision, merged, position }) => {
      const card = await cardNamed(card_id);
      if (merged && column !== "done") throw new Error("merged goes with a move to Done: it says you merged the card's pull request and are closing the card.");
      if (column === card.column && !position) throw new Error(`card ${card_id} is already in ${COLUMN_LABELS[column]}: pass position top or bottom to reorder it there.`);
      let moved;
      try {
        moved = await moveCard(card_id, { column, position: await edgePosition(card.boardId, column, position ?? "bottom"), revision, actor, merged });
      } catch (err) {
        if (err instanceof ConflictError) throw await conflict(card_id, revision);
        throw err;
      }
      return text({ column: moved.column, revision: moved.revision, ...(moved.outcome ? { outcome: moved.outcome } : {}) });
    },
  );

  // Only the Agent's own Cards: the User's words are theirs to withdraw, and Done is how the Agent
  // closes one of theirs.
  server.registerTool(
    "delete_card",
    {
      description: "Delete a card the agent created, with its comments and attachments, for good: a duplicate, or a card made by mistake. A card the person created is refused; move it to Done instead. Pass the revision from your latest get_card or get_board: if the card has changed since, the delete is refused and you should read it again.",
      inputSchema: { card_id: z.string(), revision: z.number().int().nonnegative() },
    },
    async ({ card_id, revision }) => {
      const card = await cardNamed(card_id);
      if (card.creatorKind !== "agent") throw new Error(`card ${card_id} was created by the person, and only a card the agent created can be deleted here. Move it to Done instead.`);
      if (card.revision !== revision) throw await conflict(card_id, revision);
      await deleteCard(card_id, actor);
      return text({ deleted: card_id });
    },
  );

  server.registerTool(
    "post_comment",
    { description: "Post a comment on a card as the agent. Keep it to what the reader needs.", inputSchema: { card_id: z.string(), body: z.string().min(1).max(20_000) } },
    async ({ card_id, body }) => {
      await cardNamed(card_id);
      const comment = await createComment({ cardId: card_id, body, actor });
      return text({ commentId: comment.id });
    },
  );

  // Recorded as given: kardboard asks GitHub nothing. It only checks the pull request is in the
  // repository of the Card's Board.
  server.registerTool(
    "link_pull_request",
    {
      description: "Record a card's pull request, and the branch it comes from, so the card links to both. Call it once the pull request is open. kardboard does not read or merge it; you do.",
      inputSchema: { card_id: z.string(), pr_url: z.string().url(), branch: z.string().trim().min(1).max(200).optional() },
    },
    async ({ card_id, pr_url, branch }) => {
      const current = await cardNamed(card_id);
      const pr = parsePullRequestUrl(pr_url);
      if (!pr) throw new Error(`${pr_url} is not a GitHub pull request URL, such as https://github.com/owner/repo/pull/12`);
      const board = await getBoardById(current.boardId);
      const repo = parseRepoUrl(board?.repoUrl ?? null);
      if (repo && (repo.owner.toLowerCase() !== pr.owner.toLowerCase() || repo.repo.toLowerCase() !== pr.repo.toLowerCase())) {
        throw new Error(`that pull request is in ${pr.owner}/${pr.repo}, but this card's board, ${board!.slug}, has ${repo.owner}/${repo.repo}`);
      }
      const card = await setCardWorkState(card_id, { prUrl: pr_url, prNumber: pr.number, ...(branch ? { branch } : {}) });
      await recordEvent({ boardId: card.boardId, cardId: card_id, actor, type: "card.pr_linked", payload: { prNumber: pr.number, prUrl: pr_url } });
      return text({ cardId: card.id, prUrl: card.prUrl, prNumber: card.prNumber, branch: card.branch });
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
  if (!access) return c.json({ error: "unauthorized" }, 401);
  const server = buildTokenServer(access);
  // Stateless transport: one server per request keeps the identity bound to the token.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  const body = c.req.method === "POST" ? await c.req.json().catch(() => undefined) : undefined;
  await transport.handleRequest(c.env.incoming, c.env.outgoing, body);
  return RESPONSE_ALREADY_SENT;
});
