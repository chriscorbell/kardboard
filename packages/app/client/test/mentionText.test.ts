import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractMentionHandles, mentionsAsNames } from "@kardboard/shared";
import { mentionInsert, mentionsForEditing, mentionsForPosting, nameBook } from "../src/routes/board/mentionText.js";

const people = [
  { handle: "Milo", name: "Milo" },
  { handle: "priya", name: "Priya Raghunathan" },
  { handle: "ann", name: "Ann" },
  { handle: "annlee", name: "Ann Lee" },
];
const book = nameBook(people);

describe("mentions in the composer", () => {
  it("complete as the person's name", () => {
    assert.equal(mentionInsert(people[1]!, book), "Priya Raghunathan");
    assert.equal(mentionInsert(people[0]!, book), "Milo");
  });

  it("post as handles, whatever case the name was typed in", () => {
    assert.equal(mentionsForPosting("@Priya Raghunathan and @milo, have a look", book), "@priya and @Milo, have a look");
    assert.equal(mentionsForPosting("thanks @priya raghunathan!", book), "thanks @priya!");
    assert.deepEqual(extractMentionHandles(mentionsForPosting("@Priya Raghunathan", book)), ["priya"]);
  });

  it("read the longest name first, so one name inside another is not cut short", () => {
    assert.equal(mentionsForPosting("@Ann Lee and @Ann", book), "@annlee and @ann");
  });

  it("leave a name that only starts a longer word alone", () => {
    assert.equal(mentionsForPosting("@Annie", book), "@Annie");
  });

  it("leave code as written, both ways", () => {
    const code = "run `@Priya Raghunathan` and\n```\n@priya\n```";
    assert.equal(mentionsForPosting(code, book), code);
    assert.equal(mentionsForEditing(code, book), code);
  });

  it("show a stored Comment by name for editing, and post it back unchanged", () => {
    const stored = "@priya can you check with @annlee? cc @Milo and @someone-else";
    const shown = mentionsForEditing(stored, book);
    assert.equal(shown, "@Priya Raghunathan can you check with @Ann Lee? cc @Milo and @someone-else");
    assert.equal(mentionsForPosting(shown, book), stored);
  });

  it("keep a name two people share as a handle both ways", () => {
    const twins = nameBook([
      { handle: "alex", name: "Alex Kim" },
      { handle: "alexk", name: "Alex Kim" },
    ]);
    assert.equal(mentionInsert({ handle: "alexk", name: "Alex Kim" }, twins), "alexk");
    assert.equal(mentionsForEditing("@alex and @alexk", twins), "@alex and @alexk");
    assert.equal(mentionsForPosting("@Alex Kim", twins), "@Alex Kim");
  });
});

describe("mentionsAsNames", () => {
  it("leaves an @ that is not a handle it knows as typed", () => {
    assert.equal(
      mentionsAsNames("email me@example.com or ask @unknown", () => undefined),
      "email me@example.com or ask @unknown",
    );
  });
});
