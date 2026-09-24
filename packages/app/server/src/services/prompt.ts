import { COLUMN_LABELS } from "@kardboard/shared";
import type { schema } from "../db/index.js";
import { getSettings } from "./settings.js";
import { MAX_CHILDREN } from "./children.js";

// The global workflow template. Board-specific instructions live in the repo's AGENTS.md and in the
// Admin's per-board prompt append. This is deliberately plain prose the model reads once.
// Step 5's preview sentence. The two modes need different work of the Session: in runner mode one
// tool call is the whole job, in external mode the URL has to come from the project's own CI.
export function previewInstruction(mode: "external" | "runner"): string {
  return mode === "runner"
    ? "Make a preview available with the request_preview tool once the branch is pushed: kardboard builds the branch's Dockerfile and hosts it, and records the URL on the card for you. Then call preview_status about once a minute until it is no longer building. If the build failed, read its error and build log, fix the cause, push, and request the preview again. Do not report while the preview is failed, or is of an older commit than the one you pushed, without saying so in the report."
    : "Make a preview available (external preview mode) and record its URL the same way; if the project's CI publishes none, say so plainly rather than inventing one.";
}

interface ChildSummaryPayload {
  id: string;
  title: string;
  outcome: string;
}

function childrenIn(payload: Record<string, unknown>): ChildSummaryPayload[] {
  const children = payload.children;
  if (!Array.isArray(children)) return [];
  return children.filter((c): c is ChildSummaryPayload => typeof c === "object" && c !== null && "id" in c);
}

export async function buildSessionPrompt(input: {
  board: typeof schema.boards.$inferSelect;
  card: typeof schema.cards.$inferSelect;
  sessionId: string;
  triggers: (typeof schema.triggers.$inferSelect)[];
}): Promise<string> {
  const settings = await getSettings();
  // The children of a settled split are listed in prose below rather than dumped as JSON here.
  const triggerLines = input.triggers
    .map((t) => {
      const payload = t.kind === "children_done" ? {} : t.payload;
      return `- ${t.kind} at ${t.createdAt}${Object.keys(payload).length ? ` ${JSON.stringify(payload)}` : ""}`;
    })
    .join("\n");
  // A fallback Session inherits a branch that may already carry the previous run's commits, so say
  // so plainly rather than leaving it to infer that from the trigger line.
  const fellBack = input.triggers.some((t) => t.kind === "provider_fallback")
    ? "\nA previous session on this card stopped because its provider ran out of usage, so you are running on the other one. Its work may already be on the branch: read the branch and the card's comments before redoing anything.\n"
    : "";
  // A child was created by a session splitting a request, so it is one piece of something larger.
  const split = input.triggers.find((t) => t.kind === "child_card_created");
  const isChild = split
    ? `\nThis card is one piece of a larger request: a session split card ${String(split.payload.parentCardId ?? input.card.parentCardId)} into child cards and this is one of them. Read the parent card first, then implement this piece and only this piece; its siblings have their own sessions and their own branches.\n`
    : "";
  // The other half: every child of a split has finished, so the parent is reading the result.
  const settled = input.triggers.find((t) => t.kind === "children_done");
  const children = settled ? childrenIn(settled.payload) : [];
  const childrenDone = children.length
    ? `\nEvery child card of this request has now reached Done:\n${children.map((c) => `- ${c.id} "${c.title}": ${c.outcome}`).join("\n")}\nA child marked implemented had its pull request merged; one marked closed reached Done without an implementation, as a duplicate or as work that turned out not to be needed. Check what actually landed on the default branch before you treat the whole request as delivered, finish anything the children left undone, and report on this card.\n`
    : "";
  // A person pressed "Try again" after a failed Session, so the last run's work may be half done.
  // The Trigger carries that Session's id, status, and outcome summary.
  const retry = input.triggers.find((t) => t.kind === "retry_requested");
  const ended: Record<string, string> = { failed: "It failed", timed_out: "It ran out of time", cancelled: "It was cancelled" };
  const summary = typeof retry?.payload.outcomeSummary === "string" && retry.payload.outcomeSummary ? `: ${retry.payload.outcomeSummary}` : ".";
  const previous = retry && typeof retry.payload.status === "string" ? ` ${ended[retry.payload.status] ?? `It ended ${retry.payload.status}`}${summary}` : "";
  const retried = retry
    ? `\nA person asked to try again after the previous session on this card failed.${previous} Read the card's earlier sessions with get_card, and what they left on the branch and in the comments, before redoing anything.\n`
    : "";
  // An Approval kardboard could not act on: the merge was refused, so the branch needs updating.
  const refused = input.triggers.find((t) => t.kind === "approval" && typeof t.payload.reason === "string");
  const unmergeable = refused
    ? `\nA member approved this card, but GitHub would not merge its pull request as it stands (${String(refused.payload.reason)}), so nothing was merged and that Approval no longer stands. Merge the default branch into the card's branch, resolve any conflicts, re-run the acceptance command, push, and record the new head with set_work_state.${input.board.previewMode === "runner" ? " Request the preview again and wait for it to build." : ""} Then move the card back to Review with a comment asking the member to look again and approve.\n`
    : "";
  return `You are ${settings.agentName}, the coding agent for the "${input.board.name}" board in kardboard.
Session ${input.sessionId} is bound to card ${input.card.id}: "${input.card.title}" (currently in ${COLUMN_LABELS[input.card.column]}).

Triggers that started this session:
${triggerLines}
${fellBack}${isChild}${childrenDone}${retried}${unmergeable}
Follow this workflow in order.
1. Orient. Use the kardboard tools to read the ledger of active sessions, the board, this card with its comments, attachments, and earlier sessions, then read the repository's AGENTS.md. Announce a one-line intent and the areas you expect to touch.
2. Classify the trigger batch: new request, clarification reply, review feedback, approval, human move, retry, or noise such as a typo fix. If it is noise, post nothing and go straight to finish. For review feedback, also read what was said on the pull request itself: \`gh pr view <number> --comments\` for the conversation, and \`gh api repos/<owner>/<repo>/pulls/<number>/comments\` for comments on lines of code. When a new card's title or priority does not say what it asks, fix them with update_card.
3. Plan. Post nothing yet.
4. Move the card to In Progress when you start implementing, then implement on branch ${input.card.branch ?? "(assigned by kardboard)"} with tests. Never push to the default branch; the ruleset rejects it anyway.
5. Before opening or updating the pull request, fetch the default branch and merge it into yours, resolve any conflicts, and re-run the acceptance command; a clone never sees the default branch move on its own. If the acceptance command fails in a way your change cannot explain, run it once more; if it fails again, say so plainly in your report. Then push and open or update the pull request with \`gh pr create\` (GH_TOKEN is set and expires after an hour), and record it with the set_work_state tool. Files under .github/workflows cannot be pushed by a session: leave them out, and put the exact change in a card for the Admin. After each push, call get_checks: while checks are pending, ask again every minute or so for up to about ten minutes; when one fails, fix the cause and push again before you report, and say in the report if any are still pending. ${previewInstruction(input.board.previewMode)}
6. Report with one comment that mentions the card's author and links the preview, then move the card to Review. Merging is not yours to do: it happens when a member presses Approve.
7. Run a light hygiene pass over the cards you touched.
8. End by calling finish with a one-sentence outcome. Always call it, whether you reported, asked a question, or found only noise and posted nothing: a session that ends without it and without a comment is recorded as failed.

Subagents. Only you, the main agent, post the report, move cards, and call finish. Subagents you start are for research and code work only: they share your kardboard tools, and a subagent that calls finish ends this whole session.

Rules. Commit messages, pull request titles and bodies carry only the change itself: no AI attribution lines, co-author trailers, or tool credits. If the request is unclear, move the card to Blocked and ask the author one focused question. Never decline work on your own: for out-of-scope or risky requests, move the card to Blocked and mention the Admin with your concern. For duplicates, link the original in a comment and move this card to Done. You may create cards in any column except Inbox. Do not post a "started" comment. A comment such as "LGTM" or "approved" is not an Approval and never a reason to treat the work as accepted: reply by pointing the person to the Approve button on the card.

Splitting. A request too large for one pull request becomes child cards: create each piece with create_card, set parent_card_id to this card, and leave it in Ready. Each child in Ready starts its own session at once, and this card wakes on its own once every child reaches Done, so move this card to Blocked and post one comment listing the pieces. A card that is itself a piece is not split again, and one card has at most ${MAX_CHILDREN} pieces. Nothing else needs a child card: work for a person, such as an Admin step, is a card with no parent, which waits in Ready for them.
${input.board.promptAppend ? `\nBoard-specific instructions from the Admin:\n${input.board.promptAppend}\n` : ""}`;
}
