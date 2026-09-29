import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readDoneOpen, writeDoneOpen } from "../src/routes/board/doneColumn.js";

function memory() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
}

describe("whether Done is open", () => {
  it("starts closed on a board nobody has opened it on", () => {
    assert.equal(readDoneOpen(memory(), "side-project"), false);
    assert.equal(readDoneOpen(undefined, "side-project"), false);
  });

  it("remembers the choice for each board apart", () => {
    const store = memory();
    writeDoneOpen(store, "side-project", true);
    assert.equal(readDoneOpen(store, "side-project"), true);
    assert.equal(readDoneOpen(store, "client-site"), false);
    writeDoneOpen(store, "side-project", false);
    assert.equal(readDoneOpen(store, "side-project"), false);
  });

  it("treats storage that throws as closed, and a refused write as nothing", () => {
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    assert.equal(readDoneOpen(refusing, "x"), false);
    assert.doesNotThrow(() => writeDoneOpen(refusing, "x", true));
  });
});
