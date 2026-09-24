import { Hono } from "hono";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { COLUMNS, COLUMN_LABELS, PRIORITIES } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { env } from "../env.js";
import { findSessionByToken, endSession, listBoardSessions } from "../services/orchestrator.js";
import { getBoardById, listMembers } from "../services/boards.js";
import { ConflictError, createCard, getCard, listCards, listChildren, moveCard, setCardWorkState, toSessionSummary, updateCard } from "../services/cards.js";
import { createComment, getAttachment, listComments } from "../services/comments.js";
import { getUsersByIds } from "../services/users.js";
import { recordEvent } from "../services/events.js";
import { publish } from "../services/realtime.js";
import { getPreviewForCard, previewLogTail, previewUrlFor, startPreview } from "../services/previews.js";
import { linkPullRequest, refreshPullRequestHead } from "../services/approvals.js";
import { githubConfigured, parseRepoUrl } from "../services/github.js";
import { refreshCardChecks } from "../services/checks.js";
import { childRefusal, countChildren, MAX_CHILDREN } from "../services/children.js";
import { attachmentContent } from "../services/attachment-content.js";

type SessionRow = typeof schema.sessions.$inferSelect;

// How much of a Card's past get_board and get_card send by default.
const DONE_SHOWN = 15;
const EARLIER_SESSIONS_SHOWN = 10;

// The agent-native interface. Every tool runs under a Session's identity; authorization is the
// Session's Board plus, for pull-request state, its own Card, and for card edits, the Cards that are
// its own (see `editRefusal`). Sweeps cannot touch work state or edit cards.
function buildServer(session: SessionRow): McpServer {
  const server = new McpServer({ name: "kardboard", version: "0.1.0" });
  const actor = { kind: "agent" as const, id: null, sessionId: session.id };

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

  // Done only grows, and every Session reads the Board, so by default it sends the newest few. The
  // members are who a Session may Mention: never their email, which a container has no use for.
  server.registerTool(
    "get_board",
    {
      description: `The board's settings, its members with their @handles and roles (the Admin included), and every card on it grouped by column, with creator names, parent cards, and each card's revision. Done lists only the ${DONE_SHOWN} most recently changed cards unless include_all_done is true; doneOmitted says how many were left out.`,
      inputSchema: { include_all_done: z.boolean().default(false) },
    },
    async ({ include_all_done }) => {
      const board = await getBoardById(session.boardId);
      const cards = await listCards(session.boardId);
      const users = await getUsersByIds(cards.map((c) => c.creatorId).filter((x): x is string => Boolean(x)));
      const members = (await listMembers(session.boardId)).filter((u) => u.status !== "revoked").map((u) => ({ id: u.id, name: u.name, handle: u.handle, role: u.role }));
      const summary = (c: (typeof cards)[number]) => ({ id: c.id, title: c.title, revision: c.revision, priority: c.priority, creator: c.creatorId ? users.get(c.creatorId)?.name : c.creatorKind, parentCardId: c.parentCardId, branch: c.branch, prUrl: c.prUrl, activeSession: c.activeSession?.id ?? null, updatedAt: c.updatedAt });
      const done = cards.filter((c) => c.column === "done").sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      const shownDone = include_all_done ? done : done.slice(0, DONE_SHOWN);
      const grouped = Object.fromEntries(COLUMNS.map((col) => [col, (col === "done" ? shownDone : cards.filter((c) => c.column === col)).map(summary)]));
      const out = { board: { name: board?.name, repoUrl: board?.repoUrl, previewMode: board?.previewMode }, columns: COLUMN_LABELS, members, cards: grouped, doneOmitted: done.length - shownDone.length };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    },
  );

  server.registerTool(
    "get_card",
    {
      description: "Full detail for one card: description, comments with author handles, attachments, work state and preview status, the revision to pass to move_card, its parent and child cards, live approvals, and the card's earlier sessions with how each ended. Read the earlier sessions before redoing work a previous run may have done. Omit card_id for your own card.",
      inputSchema: { card_id: z.string().optional() },
    },
    async ({ card_id }) => {
      const id = card_id ?? session.cardId;
      if (!id) throw new Error("card_id required for a sweep session");
      const card = await assertBoardCard(id);
      const comments = await listComments(id);
      const approvals = await db.select().from(schema.approvals).where(and(eq(schema.approvals.cardId, id), isNull(schema.approvals.invalidatedAt)));
      const users = await getUsersByIds([card.creatorId, ...comments.map((c) => c.authorId), ...approvals.map((a) => a.userId)].filter((x): x is string => Boolean(x)));
      // A name and handle to address someone by. The rest of a User record, email included, stays out.
      const person = (userId: string | null) => {
        const u = userId ? users.get(userId) : undefined;
        return u ? { name: u.name, handle: u.handle } : null;
      };
      const earlier = await db
        .select()
        .from(schema.sessions)
        .where(and(eq(schema.sessions.cardId, id), ne(schema.sessions.id, session.id)))
        .orderBy(desc(schema.sessions.createdAt))
        .limit(EARLIER_SESSIONS_SHOWN);
      const children = await listChildren(id);
      const out = {
        ...card,
        creator: person(card.creatorId),
        comments: comments.map((c) => ({ id: c.id, author: c.authorKind === "agent" ? "you" : c.authorKind === "system" ? "kardboard" : (users.get(c.authorId ?? "")?.name ?? "unknown"), authorHandle: users.get(c.authorId ?? "")?.handle ?? null, body: c.body, createdAt: c.createdAt, editedAt: c.editedAt, attachments: c.attachments })),
        approvals: approvals.map((a) => ({ approver: person(a.userId), prNumber: a.prNumber, headSha: a.headSha, createdAt: a.createdAt })),
        children: children.map((c) => ({ id: c.id, title: c.title, column: c.column, outcome: c.outcome })),
        earlierSessions: earlier.map((s) => ({ id: s.id, status: s.status, provider: s.provider, startedAt: s.startedAt, endedAt: s.endedAt, outcomeSummary: s.outcomeSummary })),
      };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    },
  );

  server.registerTool(
    "read_attachment",
    { description: "Fetch an attachment by id. PNG, JPEG, GIF, and WebP images come back as images and text files as text; any other file, such as a PDF, comes back as a one-line note of its name, type, and size.", inputSchema: { attachment_id: z.string() } },
    async ({ attachment_id }) => {
      const att = await getAttachment(attachment_id);
      if (!att) throw new Error("attachment not found");
      await assertBoardCard(att.cardId);
      const file = path.join(env.dataDir, "uploads", att.sha256.slice(0, 2), att.sha256);
      return { content: [attachmentContent(att, fs.readFileSync(file))] };
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

  // The revision is the one the agent read, not the Card's current one: a move decided on an old
  // view of the Card, such as a report on a Card a person has since closed, must be refused.
  server.registerTool(
    "move_card",
    {
      description: "Move a card to a column. Pass the revision from your latest get_card or get_board for that card: if the card has changed since, the move is refused, and you should read it again and decide whether the move still makes sense. Explain any move of someone else's card in a comment.",
      inputSchema: { card_id: z.string().optional(), column: z.enum(COLUMNS), revision: z.number().int().nonnegative() },
    },
    async ({ card_id, column, revision }) => {
      const id = card_id ?? session.cardId;
      if (!id) throw new Error("card_id required for a sweep session");
      const card = await assertBoardCard(id);
      let moved;
      try {
        moved = await moveCard(id, { column, position: card.position, revision, actor });
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        const now = (await getCard(id))!;
        throw new Error(`card ${id} changed after revision ${revision}: it is now at revision ${now.revision} in ${COLUMN_LABELS[now.column]}. Read it again with get_card before deciding whether to move it.`);
      }
      // Entering Review fixes the revision a member is shown; the Session hears if it cannot be approved.
      const note = column === "review" ? await refreshPullRequestHead(id).catch((err: Error) => `could not read the pull request from GitHub: ${err.message}`) : null;
      return { content: [{ type: "text", text: JSON.stringify({ column: moved.column, revision: moved.revision, ...(note ? { note } : {}) }) }] };
    },
  );

  // Which Cards a Session may rewrite. Its own, which it is working on and answers for, and the ones
  // it made, whose words are the Agent's. Not a Card someone else's Session holds, which that Session
  // is reading and may be rewriting too, and not a closed Card, whose text is the record of what was
  // asked. Nor anyone else's open Card, not even its title or priority: both are its author's call, a
  // Session with no Claim on it has heard nothing from the author to justify changing them, and a
  // Comment says the same thing without taking the author's words away.
  async function editRefusal(card: NonNullable<Awaited<ReturnType<typeof getCard>>>): Promise<string | null> {
    if (card.column === "done") return `card ${card.id} is in Done, and a closed card is not edited. Comment on it instead.`;
    if (card.activeSession && card.activeSession.id !== session.id) return `card ${card.id} is being worked on by session ${card.activeSession.id}. Leave it to that session, and comment if it needs to know something.`;
    if (card.id === session.cardId || (session.cardId && card.parentCardId === session.cardId)) return null;
    const created = await db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(and(eq(schema.events.cardId, card.id), eq(schema.events.type, "card.created"), eq(schema.events.actorKind, "agent"), sql`json_extract(${schema.events.payload}, '$.sessionId') = ${session.id}`))
      .get();
    if (created) return null;
    return `card ${card.id} is not yours to edit: you may edit your own card, its child cards, and cards you created. Comment on it instead.`;
  }

  // Tidying a card is not a request for work, so an edit here, unlike a person's, starts nothing.
  // What a field said before is kept on the card's history, so an edit never loses the author's words.
  server.registerTool(
    "update_card",
    {
      description: "Change the title, description, or priority of your own card, one of its child cards, or a card you created: during intake, to give a vague card a title that says what it asks for, set its priority, or lay out the description. Keep everything the author asked for; add and clarify, never drop. Cards in Done, cards another session is working on, and other people's cards are refused: comment on those instead. Pass the revision from your latest get_card or get_board: if the card has changed since, the edit is refused and you should read it again. Omit card_id for your own card. Editing a card starts no session.",
      inputSchema: {
        card_id: z.string().optional(),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(20_000).optional(),
        priority: z.enum(PRIORITIES).optional(),
        revision: z.number().int().nonnegative(),
      },
    },
    async ({ card_id, title, description, priority, revision }) => {
      // A sweep corrects which column a card is in. What a card says is its author's.
      if (session.kind !== "card" || !session.cardId) throw new Error("a hygiene sweep does not edit cards: move a card that drifted, and explain the move in a comment.");
      const id = card_id ?? session.cardId;
      const current = await assertBoardCard(id);
      if (title === undefined && description === undefined && priority === undefined) throw new Error("nothing to change: pass a title, a description, or a priority");
      const refusal = await editRefusal(current);
      if (refusal) throw new Error(refusal);
      let card;
      try {
        card = await updateCard(id, { title, description, priority, revision, actor });
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        const now = (await getCard(id))!;
        throw new Error(`card ${id} changed after revision ${revision}: it is now at revision ${now.revision}. Read it again with get_card before deciding whether the edit still makes sense.`);
      }
      return { content: [{ type: "text", text: JSON.stringify({ cardId: card.id, revision: card.revision, title: card.title, priority: card.priority }) }] };
    },
  );

  // A split is one level deep, of the Session's own Card only, and bounded: see `childRefusal`.
  server.registerTool(
    "create_card",
    { description: `Create a card in any column except Inbox, which is reserved for humans. Set parent_card_id to your own card when splitting it: a child card left in Ready starts its own session immediately, and your card wakes once every child reaches Done. Only your own card can be a parent, a card that is itself a child cannot be split again, and one card has at most ${MAX_CHILDREN} children. A card with no parent starts nothing and waits in Ready for a person.`, inputSchema: { title: z.string().min(1).max(200), description: z.string().max(20_000).default(""), column: z.enum(COLUMNS.filter((c) => c !== "inbox") as [string, ...string[]]).default("ready"), priority: z.enum(PRIORITIES).default("none"), parent_card_id: z.string().optional() } },
    async ({ title, description, column, priority, parent_card_id }) => {
      if (parent_card_id) {
        if (parent_card_id !== session.cardId) {
          throw new Error(session.cardId ? `parent_card_id must be your own card, ${session.cardId}: a session splits only the request it is working on.` : "a sweep session has no card of its own, so it cannot create child cards.");
        }
        const parent = await assertBoardCard(parent_card_id);
        const refusal = childRefusal(parent, await countChildren(parent.id));
        if (refusal) throw new Error(refusal);
      }
      const card = await createCard({ boardId: session.boardId, title, description, priority, column: column as (typeof COLUMNS)[number], actor, parentCardId: parent_card_id ?? null });
      return { content: [{ type: "text", text: JSON.stringify({ cardId: card.id }) }] };
    },
  );

  // A reported pull request is checked on GitHub before it is recorded: it has to come from this
  // Card's own branch, because Approval merges whatever the Card points at with the merge App.
  server.registerTool(
    "set_work_state",
    {
      description: "Record the pull request and preview for your own card. The pull request must be the one opened from this card's branch in the board's repository; kardboard checks that on GitHub and records its current head, which is the revision a member approves. Call it again after pushing more commits.",
      inputSchema: { pr_url: z.string().url().optional(), pr_number: z.number().int().optional(), preview_url: z.string().url().optional() },
    },
    async ({ pr_url, pr_number, preview_url }) => {
      if (session.kind !== "card" || !session.cardId) throw new Error("only card sessions can set work state");
      if (pr_number !== undefined || pr_url !== undefined) await linkPullRequest(session.cardId, { number: pr_number, url: pr_url });
      if (preview_url !== undefined) await setCardWorkState(session.cardId, { previewUrl: preview_url });
      const card = (await getCard(session.cardId))!;
      return { content: [{ type: "text", text: JSON.stringify({ prNumber: card.prNumber, prUrl: card.prUrl, headSha: card.prHeadSha, previewUrl: card.previewUrl }) }] };
    },
  );

  // CI for the head the Card records, read with the merge App's token, which a Session does not
  // hold: the Sessions token is kept to three permissions, so `gh pr checks` may be refused on a
  // private repository while this still answers.
  server.registerTool(
    "get_checks",
    {
      description:
        "CI on your card's pull request: every check run and commit status on its current head, and one state for all of them: passing, failing, pending (still running), none (nothing ran), or unknown (kardboard cannot read them here). Call it after pushing and reporting the pull request, and fix failures before moving the card to Review.",
      inputSchema: {},
    },
    async () => {
      if (session.kind !== "card" || !session.cardId) throw new Error("only card sessions have a pull request to check");
      const board = await getBoardById(session.boardId);
      const repo = parseRepoUrl(board?.repoUrl ?? null);
      if (!repo || !githubConfigured("merge")) {
        const out = { state: "unknown", checks: [], note: "kardboard has no GitHub merge app for this board, so it cannot read checks; try gh pr checks" };
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      // Your latest push is what you want checked, so the head is read from GitHub first, as
      // move_card does on entering Review.
      const note = await refreshPullRequestHead(session.cardId).catch((err: Error) => `could not read the pull request from GitHub: ${err.message}`);
      const card = (await getCard(session.cardId))!;
      if (!card.prHeadSha) throw new Error(note ?? "no pull request is recorded for this card yet; open it and report it with set_work_state first");
      const read = await refreshCardChecks(card.id, repo, card.prHeadSha);
      const out = { state: read.state, prNumber: card.prNumber, sha: card.prHeadSha, checks: read.checks, ...(note ? { note } : {}) };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
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
            text: `Building ${preview.branch} from its Dockerfile. The preview will answer at ${url} once the build finishes; until then it shows a holding page, or the previous build if there is one. The URL is already recorded on the card. Check preview_status until it is no longer building.`,
          },
        ],
      };
    },
  );

  // Separate from get_card, which also carries the status, because a Session polls this while a build
  // runs, and get_card's comments and history would be read again on every poll. It adds what fixing
  // a failed build needs: the end of the build log.
  server.registerTool(
    "preview_status",
    {
      description: "Your own card's runner preview: building, running, or failed; the error, the commit that failed, and the end of the build log when it failed; a note when a rebuild was interrupted and the previous build still serves; and the commit of the last build that ran beside the pull request head kardboard last recorded. Call it after request_preview, about once a minute while it is building, and before reporting.",
      inputSchema: {},
    },
    async () => {
      if (session.kind !== "card" || !session.cardId) throw new Error("only card sessions have a preview");
      const card = (await getCard(session.cardId))!;
      const board = await getBoardById(session.boardId);
      if (board?.previewMode !== "runner") {
        return { content: [{ type: "text", text: JSON.stringify({ status: "external", note: "This board is in external preview mode: kardboard builds nothing, and the preview comes from the project's own CI." }) }] };
      }
      const row = await getPreviewForCard(session.cardId);
      if (!row) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "none", note: "No preview has been requested for this card. Push the branch, then call request_preview." }) }] };
      }
      const failed = row.status === "failed";
      const out = {
        status: row.status,
        url: previewUrlFor(row.host),
        // On a running preview, the note that a rebuild was interrupted and the previous build serves.
        error: row.error,
        // The last build that ran, which a building preview still serves. A failed build is failedSha.
        builtFromSha: row.sha,
        ...(failed ? { failedSha: row.failedSha } : {}),
        pullRequestHeadSha: card.prHeadSha,
        // Only a yes or no when both are known. A building preview is still serving its previous build.
        isOfPullRequestHead: row.sha && card.prHeadSha ? row.sha === card.prHeadSha : null,
        updatedAt: row.updatedAt,
        // A build the runner refused never ran, and the log the runner has is an earlier build's, which
        // would send the Session after an error it has already fixed. The error says why instead.
        ...(failed && row.buildId ? { buildLogTail: await previewLogTail(row.id) } : {}),
      };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    },
  );

  server.registerTool(
    "finish",
    {
      description: "End this session with a one-sentence outcome summary. Always call it last, including when the trigger batch turned out to be noise: a session that exits without calling it or commenting is recorded as failed, and its card's people are told it stopped.",
      inputSchema: { summary: z.string().min(1).max(500), outcome: z.enum(["succeeded", "failed"]).default("succeeded") },
    },
    async ({ summary, outcome }) => {
      // The outcome is on record before the tool answers, so a container exit that beats the end
      // below still ends the Session the way it reported.
      await recordEvent({ boardId: session.boardId, cardId: session.cardId, actor, type: "session.reported", payload: { sessionId: session.id, summary, outcome } });
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
