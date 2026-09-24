import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { postComment, UploadFailed, type CommentRequests, type PostProgress } from "../src/lib/commentPost.js";

type File = { name: string };

function fakeApi(failing: Set<string> = new Set()) {
  const calls: string[] = [];
  const api: CommentRequests<File> = {
    create: async (body) => {
      calls.push(`create ${body}`);
      return { id: `c${calls.length}` };
    },
    edit: async (id, body) => {
      calls.push(`edit ${id} ${body}`);
    },
    upload: async (id, file) => {
      calls.push(`upload ${id} ${file.name}`);
      if (failing.has(file.name)) throw new Error(`${file.name} is broken`);
    },
  };
  return { api, calls, failing };
}

describe("postComment", () => {
  it("posts the comment, then each file", async () => {
    const { api, calls } = fakeApi();
    const a = { name: "a.png" };
    const b = { name: "b.pdf" };
    const id = await postComment(api, "hello", [a, b], null, () => {});
    assert.equal(id, "c1");
    assert.deepEqual(calls, ["create hello", "upload c1 a.png", "upload c1 b.pdf"]);
  });

  it("retries a failed upload on the same comment instead of posting another", async () => {
    const { api, calls, failing } = fakeApi(new Set(["b.pdf"]));
    const a = { name: "a.png" };
    const b = { name: "b.pdf" };
    let progress: PostProgress<File> | null = null;
    const save = (p: PostProgress<File>) => (progress = p);

    await assert.rejects(postComment(api, "hello", [a, b], progress, save), (err) => err instanceof UploadFailed && err.file === b);
    failing.clear();
    await postComment(api, "hello", [a, b], progress, save);

    assert.deepEqual(calls, ["create hello", "upload c1 a.png", "upload c1 b.pdf", "upload c1 b.pdf"]);
  });

  it("saves a body changed between attempts as an edit", async () => {
    const { api, calls } = fakeApi();
    const progress: PostProgress<File> = { commentId: "c9", body: "helo", uploaded: [] };
    await postComment(api, "hello", [], progress, () => {});
    assert.deepEqual(calls, ["edit c9 hello"]);
  });

  it("skips a file the person removed before retrying", async () => {
    const { api, calls } = fakeApi();
    const a = { name: "a.png" };
    const progress: PostProgress<File> = { commentId: "c9", body: "hello", uploaded: [a] };
    await postComment(api, "hello", [a], progress, () => {});
    assert.deepEqual(calls, []);
  });
});
