import { COLUMNS, type Card, type Column, type OverviewView } from "@kardboard/shared";
import { listAllBoards } from "./boards.js";
import { listOpenCards } from "./cards.js";
import { backupProblem } from "./backup.js";

// How many of the newest Backlog Cards the Overview shows. The rest are counted, and wait on their
// Boards.
export const OVERVIEW_BACKLOG_SHOWN = 8;

type OpenColumn = Exclude<Column, "done">;
const OPEN_COLUMNS = COLUMNS.filter((c): c is OpenColumn => c !== "done");

/** Whether a Card waits on the User: the Agent's question in Blocked, or a pull request in Review. */
export function needsYou(card: Pick<Card, "column" | "awaitingReply">): boolean {
  return (card.column === "blocked" && card.awaitingReply) || card.column === "review";
}

const newestFirst = (by: (c: Card) => string) => (a: Card, b: Card) => by(b).localeCompare(by(a));

export async function overview(): Promise<OverviewView> {
  const boards = await listAllBoards();
  const cards = await listOpenCards();
  const backlog = cards.filter((c) => c.column === "inbox").sort(newestFirst((c) => c.createdAt));
  return {
    boards: boards.map((board) => {
      const own = cards.filter((c) => c.boardId === board.id);
      return {
        board,
        open: Object.fromEntries(OPEN_COLUMNS.map((col) => [col, own.filter((c) => c.column === col).length])) as Record<OpenColumn, number>,
        needsYou: own.filter(needsYou).length,
      };
    }),
    needsYou: cards.filter(needsYou).sort(newestFirst((c) => c.updatedAt)),
    inProgress: cards.filter((c) => c.column === "in_progress").sort(newestFirst((c) => c.updatedAt)),
    backlog: backlog.slice(0, OVERVIEW_BACKLOG_SHOWN),
    backlogTotal: backlog.length,
    backupProblem: backupProblem(),
  };
}
