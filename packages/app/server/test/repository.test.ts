import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRepoUrl, repositoryKey } from "../src/services/repository.js";

// A Board's repository, read out of its address: the forms `git remote get-url origin` prints, and what
// a person pastes from the browser. An agent names its Board this way, so each must read the same.

describe("reading a repository's address", () => {
  it("reads the owner and name from each form git or a person writes", () => {
    for (const url of [
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets.git",
      "https://github.com/acme/widgets/",
      "https://github.com/acme/widgets.git/",
      "http://github.com/acme/widgets",
      "https://www.github.com/acme/widgets",
      "git@github.com:acme/widgets.git",
      "git@github.com:acme/widgets",
      "ssh://git@github.com/acme/widgets.git",
      "ssh://git@github.com:22/acme/widgets.git",
      "https://chris:ghp_example@github.com/acme/widgets.git",
      "git://github.com/acme/widgets.git",
      "github.com/acme/widgets",
      "  https://github.com/acme/widgets\n",
    ]) {
      assert.deepEqual(parseRepoUrl(url), { owner: "acme", repo: "widgets" }, url);
    }
  });

  it("keeps the case it was written in, and a dot in the name that is not .git", () => {
    assert.deepEqual(parseRepoUrl("https://github.com/Acme/Widgets"), { owner: "Acme", repo: "Widgets" });
    assert.deepEqual(parseRepoUrl("git@github.com:acme/widgets.js.git"), { owner: "acme", repo: "widgets.js" });
  });

  it("reads nothing from an address that is not a GitHub repository", () => {
    for (const url of [
      null,
      "",
      "https://gitlab.com/acme/widgets",
      "https://github.com.example.net/acme/widgets",
      "https://notgithub.com/acme/widgets",
      "https://github.com/acme",
      "https://github.com/acme/widgets/pull/12",
      "acme/widgets",
    ]) {
      assert.equal(parseRepoUrl(url), null, String(url));
    }
  });
});

describe("comparing repository addresses", () => {
  it("gives every form of one repository the same key, in lowercase", () => {
    const keys = ["https://github.com/Acme/Widgets", "git@github.com:acme/widgets.git", "ssh://git@github.com/ACME/WIDGETS.git", "github.com/acme/widgets/"].map(repositoryKey);
    assert.deepEqual(new Set(keys), new Set(["acme/widgets"]));
  });

  it("has no key for an address it cannot read", () => {
    assert.equal(repositoryKey(null), null);
    assert.equal(repositoryKey("https://gitlab.com/acme/widgets"), null);
  });
});
