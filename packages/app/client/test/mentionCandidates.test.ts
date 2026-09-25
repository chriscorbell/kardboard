import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractMentionHandles } from "@kardboard/shared";
import { mentionCandidates } from "../src/routes/board/mentionCandidates.js";
import { splitMentions } from "../src/components/mentions.js";

const agent = { name: "Milo", avatarUrl: null };
const members = [
  { handle: "priya", name: "Priya Raghunathan", avatarUrl: null },
  { handle: "tomasz", name: "Tomasz Wierzbicki", avatarUrl: null },
];

describe("the @ list", () => {
  it("offers the Agent under its name as written, whatever case was typed", () => {
    for (const typed of ["Mi", "mi", "MILO", "milo"]) {
      assert.deepEqual(
        mentionCandidates(agent, members, typed).map((c) => c.handle),
        ["Milo"],
        typed,
      );
    }
  });

  it("puts the Agent first when what was typed also matches someone's name", () => {
    assert.deepEqual(
      mentionCandidates(agent, members, "M").map((c) => c.handle),
      ["Milo", "tomasz"],
    );
  });

  it("offers people by handle or by any part of their name", () => {
    assert.deepEqual(
      mentionCandidates(agent, members, "pri").map((c) => c.handle),
      ["priya"],
    );
    assert.deepEqual(
      mentionCandidates(agent, members, "wierz").map((c) => c.handle),
      ["tomasz"],
    );
    assert.equal(mentionCandidates(agent, members, "").length, 3);
  });

  it("inserts a mention that posts and renders the same as a lowercase one", () => {
    assert.deepEqual(extractMentionHandles("thanks @Milo"), ["milo"]);
    const handles = new Map([["milo", "Milo"]]);
    const [, link] = splitMentions("thanks @Milo", handles);
    assert.deepEqual(link?.children, [{ type: "text", value: "@Milo" }]);
  });
});
