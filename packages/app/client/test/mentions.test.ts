import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { remarkMentions, splitMentions, type MdNode } from "../src/components/mentions.js";

const handles = new Map([
  ["chris", "Chris Corbell"],
  ["milo", "Milo"],
]);

function mention(handle: string, name: string): MdNode {
  return { type: "link", url: `mention:${handle}`, children: [{ type: "text", value: `@${name}` }] };
}

describe("splitMentions", () => {
  it("links known and unknown handles, keeping the text around them", () => {
    assert.deepEqual(splitMentions("Thanks @chris, and @someone.", handles), [
      { type: "text", value: "Thanks " },
      mention("chris", "Chris Corbell"),
      { type: "text", value: ", and " },
      mention("someone.", "someone."),
    ]);
  });

  it("leaves an email address alone", () => {
    assert.deepEqual(splitMentions("mail chris@example.com", handles), [{ type: "text", value: "mail chris@example.com" }]);
  });

  it("matches a handle at the very start", () => {
    assert.deepEqual(splitMentions("@Milo go", handles), [mention("Milo", "Milo"), { type: "text", value: " go" }]);
  });
});

describe("remarkMentions", () => {
  it("rewrites prose but not inline code, code blocks, or link text", () => {
    const tree: MdNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Ask @milo about " },
            { type: "inlineCode", value: "@tanstack/react-query" },
            { type: "link", url: "https://x.test", children: [{ type: "text", value: "@chris" }] },
          ],
        },
        { type: "code", value: "import x from '@milo/pkg'" },
      ],
    };
    remarkMentions(handles)(tree);
    assert.deepEqual(tree.children![0]!.children, [
      { type: "text", value: "Ask " },
      mention("milo", "Milo"),
      { type: "text", value: " about " },
      { type: "inlineCode", value: "@tanstack/react-query" },
      { type: "link", url: "https://x.test", children: [{ type: "text", value: "@chris" }] },
    ]);
    assert.deepEqual(tree.children![1], { type: "code", value: "import x from '@milo/pkg'" });
  });

  it("reaches text nested in emphasis and lists", () => {
    const tree: MdNode = { type: "root", children: [{ type: "list", children: [{ type: "listItem", children: [{ type: "emphasis", children: [{ type: "text", value: "@chris" }] }] }] }] };
    remarkMentions(handles)(tree);
    assert.deepEqual(tree.children![0]!.children![0]!.children![0]!.children, [mention("chris", "Chris Corbell")]);
  });
});
