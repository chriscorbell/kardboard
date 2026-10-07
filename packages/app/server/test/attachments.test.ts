import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type { Attachment, Card, Comment } from "@kardboard/shared";

// How an Attachment's type is stored and served. The uploader's browser names the type, so a Member
// can name an SVG or an HTML page anything; only the raster images may be shown in place. Dev
// authentication signs the tests in, and `X-Dev-User` picks the caller by email.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-attachments-"));
process.env.KARDBOARD_DATA_DIR = root;
process.env.KARDBOARD_AUTH = "dev";

const { db, schema, runMigrations } = await import("../src/db/index.js");
const { api } = await import("../src/routes/api.js");

await runMigrations();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOARD = "board-1";
const MEMBER = "ada@example.com";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

beforeEach(async () => {
  for (const t of [schema.events, schema.comments, schema.cards, schema.boardMembers, schema.users, schema.boards]) await db.delete(t);
  await db.insert(schema.boards).values({ id: BOARD, slug: "board-one", name: "Board one" });
  await db.insert(schema.users).values({ id: "ada", email: MEMBER, handle: "ada", name: "Ada", role: "member", status: "active" });
  await db.insert(schema.boardMembers).values({ boardId: BOARD, userId: "ada" });
});

function call(method: string, url: string, body?: unknown) {
  return api.request(url, {
    method,
    headers: { "x-dev-user": MEMBER, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function newComment(): Promise<Comment> {
  const card = (await (await call("POST", "/boards/board-one/cards", { title: "A card" })).json()) as Card;
  const res = await call("POST", `/cards/${card.id}/comments`, { body: "see attached" });
  assert.equal(res.status, 201);
  return (await res.json()) as Comment;
}

// The multipart body is written out by hand, so the part's Content-Type reaches the server exactly
// as a hostile client could send it.
async function upload(commentId: string, filename: string, type: string, bytes: string | Buffer): Promise<Attachment> {
  const boundary = "kardboard-test-boundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await api.request(`/comments/${commentId}/attachments`, {
    method: "POST",
    headers: { "x-dev-user": MEMBER, "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.equal(res.status, 201);
  return (await res.json()) as Attachment;
}

async function storedMime(id: string): Promise<string> {
  return (await db.select().from(schema.attachments).where(eq(schema.attachments.id, id)).get())!.mime;
}

// A row as one written before uploads were normalised, with its type exactly as the browser sent it.
async function insertOld(commentId: string, mime: string, bytes: string | Buffer): Promise<string> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  fs.mkdirSync(path.join(root, "uploads", sha256.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(root, "uploads", sha256.slice(0, 2), sha256), bytes);
  const id = `old-${sha256.slice(0, 8)}`;
  await db.insert(schema.attachments).values({ id, commentId, filename: "old", mime, size: Buffer.byteLength(bytes), sha256 });
  return id;
}

// Reads the body too: the file is streamed, and a stream left unread opens after the test is over.
async function download(id: string): Promise<Response> {
  const res = await call("GET", `/attachments/${id}`);
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return res;
}

const disposition = (res: Response) => res.headers.get("content-disposition")!.split(";")[0];

describe("uploading an attachment", () => {
  it("stores the type without its parameters or capitals", async () => {
    const comment = await newComment();
    const att = await upload(comment.id, "logo.svg", "Image/SVG+XML; charset=utf-8", SVG);
    assert.equal(att.mime, "image/svg+xml");
    assert.equal(await storedMime(att.id), "image/svg+xml");
  });

  it("stores a type that is not shaped like one as application/octet-stream", async () => {
    const comment = await newComment();
    assert.equal(await storedMime((await upload(comment.id, "a.bin", "png", "x")).id), "application/octet-stream");
  });
});

describe("downloading an attachment", () => {
  it("shows a PNG in place", async () => {
    const comment = await newComment();
    const res = await download((await upload(comment.id, "shot.png", "image/png", PNG)).id);
    assert.equal(disposition(res), "inline");
    assert.equal(res.headers.get("content-type"), "image/png");
  });

  it("sends an SVG, however its type is written, as a file to save", async () => {
    const comment = await newComment();
    for (const type of ["image/svg+xml", "image/svg+xml; charset=utf-8"]) {
      const res = await download((await upload(comment.id, "logo.svg", type, `${SVG}<!-- ${type} -->`)).id);
      assert.equal(disposition(res), "attachment", type);
      assert.equal(res.headers.get("content-type"), "image/svg+xml", type);
    }
  });

  it("sends an HTML page as a file to save", async () => {
    const comment = await newComment();
    const res = await download((await upload(comment.id, "page.html", "text/html", "<script>alert(1)</script>")).id);
    assert.equal(disposition(res), "attachment");
  });

  it("reads a type stored before uploads were normalised the same way", async () => {
    const comment = await newComment();
    const svg = await download(await insertOld(comment.id, "IMAGE/SVG+XML; charset=utf-8", SVG));
    assert.equal(disposition(svg), "attachment");
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    const png = await download(await insertOld(comment.id, "Image/PNG; x=1", PNG));
    assert.equal(disposition(png), "inline");
    assert.equal(png.headers.get("content-type"), "image/png");
  });

  it("keeps the browser from sniffing, running, or handing it to another origin", async () => {
    const comment = await newComment();
    const res = await download((await upload(comment.id, "shot.png", "image/png", PNG)).id);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy")!, /^sandbox;/);
    assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
  });
});
