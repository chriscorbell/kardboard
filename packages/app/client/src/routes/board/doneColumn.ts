// Done holds finished work, so it starts as a narrow strip and opens when asked. Whether it is open is
// remembered per Board in this browser, and anything unreadable counts as closed.
type Store = Pick<Storage, "getItem" | "setItem">;

const key = (slug: string) => `kardboard:done-open:${slug}`;

export function readDoneOpen(store: Store | undefined, slug: string): boolean {
  try {
    return store?.getItem(key(slug)) === "1";
  } catch {
    return false;
  }
}

export function writeDoneOpen(store: Store | undefined, slug: string, open: boolean): void {
  try {
    store?.setItem(key(slug), open ? "1" : "0");
  } catch {
    // Storage refused, as in a private window: the choice lasts until the page is left.
  }
}
