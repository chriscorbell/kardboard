import { CARD_TYPES, PRIORITIES, type Card, type CardType, type Priority } from "@kardboard/shared";

// The board toolbar's search and filters. They narrow the Cards already loaded, and live in the URL
// query so a reload, a shared link, or opening and closing a Card keeps them.
export type BoardFilter = {
  q: string;
  /** Cards the User wrote, rather than the Agent. */
  mine: boolean;
  /** Cards waiting on the User: a question for them, or a change to review. */
  needsMe: boolean;
  type: CardType | null;
  priority: Priority | null;
};

export const NO_FILTER: BoardFilter = { q: "", mine: false, needsMe: false, type: null, priority: null };

const KEYS = { q: "q", mine: "mine", needsMe: "needs", type: "type", priority: "priority" } as const;

export function readFilter(params: URLSearchParams): BoardFilter {
  const priority = params.get(KEYS.priority);
  const type = params.get(KEYS.type);
  return {
    q: params.get(KEYS.q) ?? "",
    mine: params.get(KEYS.mine) === "1",
    needsMe: params.get(KEYS.needsMe) === "1",
    type: (CARD_TYPES as readonly string[]).includes(type ?? "") ? (type as CardType) : null,
    priority: (PRIORITIES as readonly string[]).includes(priority ?? "") ? (priority as Priority) : null,
  };
}

// The same query with the filter's keys set or removed; anything else in it is left as it was.
export function writeFilter(filter: BoardFilter, params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, value: string | null) => (value ? next.set(key, value) : next.delete(key));
  set(KEYS.q, filter.q);
  set(KEYS.mine, filter.mine ? "1" : null);
  set(KEYS.needsMe, filter.needsMe ? "1" : null);
  set(KEYS.type, filter.type);
  set(KEYS.priority, filter.priority);
  return next;
}

export function filterActive(filter: BoardFilter): boolean {
  return filter.q.trim() !== "" || filter.mine || filter.needsMe || filter.type !== null || filter.priority !== null;
}

export type Viewer = { id: string };

// Waiting on the User: the Agent's question in Blocked, or a pull request in Review to look at.
export function waitsOn(card: Card): boolean {
  return (card.column === "blocked" && card.awaitingReply) || card.column === "review";
}

// Every word must appear in the title or the details, or start the Card's id (as the sheet shows it).
export function matchesQuery(card: Card, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${card.title}\n${card.description}`.toLowerCase();
  const id = card.id.toLowerCase();
  return words.every((w) => text.includes(w) || id.startsWith(w.replace(/^#/, "")));
}

export function matchesFilter(card: Card, filter: BoardFilter, viewer: Viewer): boolean {
  if (filter.mine && !(card.creatorKind === "user" && card.creatorId === viewer.id)) return false;
  if (filter.needsMe && !waitsOn(card)) return false;
  if (filter.type && card.type !== filter.type) return false;
  if (filter.priority && card.priority !== filter.priority) return false;
  return matchesQuery(card, filter.q);
}

// Done keeps growing, so it shows the Cards that got there most recently and folds the rest away.
export const DONE_SHOWN = 10;

// `cards` is the column in display order, which is kept; `hidden` is how many were folded away.
export function foldDone(cards: readonly Card[], limit = DONE_SHOWN): { shown: Card[]; hidden: number } {
  if (cards.length <= limit) return { shown: [...cards], hidden: 0 };
  const recent = new Set(
    [...cards]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((c) => c.id),
  );
  return { shown: cards.filter((c) => recent.has(c.id)), hidden: cards.length - limit };
}
