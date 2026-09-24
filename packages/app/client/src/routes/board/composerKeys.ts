// The Composer's keyboard rules, kept apart from the component so they can be tested directly.
// Enter posts; Shift+Enter breaks the line. While the @mention list is open, Enter picks instead.
// On a touch screen Enter breaks the line and the Post button posts: a phone keyboard has no
// Shift+Enter, so otherwise nobody on a phone could write a second paragraph.

export type ComposerKey = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  // True while an input method editor is composing, when Enter commits a candidate rather than a comment.
  isComposing: boolean;
};

export type ComposerAction = { type: "mention-move"; delta: 1 | -1 } | { type: "mention-pick" } | { type: "mention-close" } | { type: "submit" } | { type: "cancel" };

// The action to take, and whether the textarea's own handling of the key should be suppressed.
// Null means the key belongs to the textarea: a plain character, or Shift+Enter's line break.
export type ComposerKeyResult = { action: ComposerAction; preventDefault: boolean } | null;

export function composerKeyAction(e: ComposerKey, state: { mentionOpen: boolean; canCancel: boolean; touch?: boolean }): ComposerKeyResult {
  // Let the input method editor have every key it is composing with, including Enter.
  if (e.isComposing || e.key === "Process") return null;

  if (state.mentionOpen) {
    if (e.key === "ArrowDown") return { action: { type: "mention-move", delta: 1 }, preventDefault: true };
    if (e.key === "ArrowUp") return { action: { type: "mention-move", delta: -1 }, preventDefault: true };
    // Shift leaves the list alone: Shift+Enter still breaks the line, Shift+Tab still moves focus.
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) return { action: { type: "mention-pick" }, preventDefault: true };
    if (e.key === "Escape") return { action: { type: "mention-close" }, preventDefault: false };
  }

  if (e.key === "Enter") {
    if (e.shiftKey || e.altKey) return null;
    // A tablet with a keyboard attached still posts on Cmd+Enter or Ctrl+Enter.
    if (state.touch && !e.metaKey && !e.ctrlKey) return null;
    return { action: { type: "submit" }, preventDefault: true };
  }

  if (e.key === "Escape" && state.canCancel) return { action: { type: "cancel" }, preventDefault: false };

  return null;
}
