import { mentionsAsNames, outsideCode } from "@kardboard/shared";

// A Comment is stored with @handles, which is what a Mention is and what the Agent reads and writes.
// The composer shows people by name instead: a stored body is turned into names for editing, and
// names back into handles when it is posted. A name two people share stays a handle both ways, so
// nobody's Mention lands on the wrong person.

export type Named = { handle: string; name: string };

export type NameBook = {
  /** Handle, lowercased, to the name the composer shows for it. */
  byHandle: Map<string, string>;
  /** Name, lowercased, to the handle it stands for. */
  byName: Map<string, string>;
};

/** Everyone the composer can name: the Agent, whose handle is its name, then the Board's people. */
export function nameBook(people: Named[]): NameBook {
  const seen = new Map<string, Named>();
  for (const p of people) if (p.name.trim() && !seen.has(p.handle.toLowerCase())) seen.set(p.handle.toLowerCase(), p);
  const count = new Map<string, number>();
  for (const p of seen.values()) count.set(p.name.toLowerCase(), (count.get(p.name.toLowerCase()) ?? 0) + 1);
  const unique = [...seen.values()].filter((p) => count.get(p.name.toLowerCase()) === 1);
  return {
    byHandle: new Map(unique.map((p) => [p.handle.toLowerCase(), p.name])),
    byName: new Map(unique.map((p) => [p.name.toLowerCase(), p.handle])),
  };
}

/** What completing a Mention inserts, after the @: the name, unless it is shared. */
export function mentionInsert(person: Named, book: NameBook): string {
  return book.byName.get(person.name.toLowerCase()) === person.handle ? person.name : person.handle;
}

/** A stored body as the composer shows it for editing. */
export function mentionsForEditing(body: string, book: NameBook): string {
  return mentionsAsNames(body, (handle) => book.byHandle.get(handle));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What the composer posts: each @Name it knows, in any case, back to that person's @handle. Longer
 * names are tried first, so "@Ann Lee" is not read as "@Ann" followed by " Lee".
 */
export function mentionsForPosting(body: string, book: NameBook): string {
  const names = [...book.byName.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) return body;
  const pattern = new RegExp(`(^|[^\\w@])@(${names.map(escape).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  return outsideCode(body, (part) => part.replace(pattern, (_all, before: string, name: string) => `${before}@${book.byName.get(name.toLowerCase())}`));
}
