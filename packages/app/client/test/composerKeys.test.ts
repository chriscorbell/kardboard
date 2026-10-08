import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composerKeyAction, type ComposerKey } from "../src/routes/board/composerKeys.js";

function key(k: string, mods: Partial<ComposerKey> = {}): ComposerKey {
  return { key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...mods };
}

const plain = { canCancel: false };

describe("composerKeyAction", () => {
  it("posts on Enter and suppresses the line break", () => {
    assert.deepEqual(composerKeyAction(key("Enter"), plain), { action: { type: "submit" }, preventDefault: true });
  });

  it("leaves Shift+Enter to the textarea", () => {
    assert.equal(composerKeyAction(key("Enter", { shiftKey: true }), plain), null);
  });

  it("still posts on Cmd+Enter and Ctrl+Enter", () => {
    for (const mods of [{ metaKey: true }, { ctrlKey: true }]) {
      assert.deepEqual(composerKeyAction(key("Enter", mods), plain), { action: { type: "submit" }, preventDefault: true });
    }
  });

  it("leaves Alt+Enter alone, which some editors send for a line break", () => {
    assert.equal(composerKeyAction(key("Enter", { altKey: true }), plain), null);
  });

  it("does not post while an input method editor is composing", () => {
    assert.equal(composerKeyAction(key("Enter", { isComposing: true }), plain), null);
    assert.equal(composerKeyAction(key("Process"), plain), null);
  });

  it("passes ordinary keys through", () => {
    assert.equal(composerKeyAction(key("a"), plain), null);
    assert.equal(composerKeyAction(key("Tab"), plain), null);
    assert.equal(composerKeyAction(key("ArrowDown"), plain), null);
  });

  it("cancels on Escape only when there is something to cancel", () => {
    assert.equal(composerKeyAction(key("Escape"), plain), null);
    assert.deepEqual(composerKeyAction(key("Escape"), { canCancel: true }), { action: { type: "cancel" }, preventDefault: false });
  });

  describe("on a touch screen", () => {
    const touch = { canCancel: false, touch: true };

    it("leaves Enter to the textarea, so a phone can write a second paragraph", () => {
      assert.equal(composerKeyAction(key("Enter"), touch), null);
    });

    it("still posts on Cmd+Enter or Ctrl+Enter from an attached keyboard", () => {
      for (const mods of [{ metaKey: true }, { ctrlKey: true }]) {
        assert.deepEqual(composerKeyAction(key("Enter", mods), touch), { action: { type: "submit" }, preventDefault: true });
      }
    });

    it("posts on Enter as before when the pointer is not a touch screen", () => {
      assert.deepEqual(composerKeyAction(key("Enter"), { ...touch, touch: false }), { action: { type: "submit" }, preventDefault: true });
    });
  });
});
