import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// The email module reaches the database at import time, so point it at a scratch directory first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kardboard-email-"));
process.env.KARDBOARD_DATA_DIR = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { renderEmailMarkdown } = await import("../src/services/email.js");

const BASE = "https://kardboard.test";

describe("renderEmailMarkdown", () => {
  it("renders emphasis, links, lists, and code with inline styles", () => {
    const html = renderEmailMarkdown("**Bold** and _soft_ with `npm test`.\n\n- one\n- two\n\n[the preview](https://preview.example.com)\n\n```\nconst a = 1;\n```", BASE);
    assert.match(html, /<strong>Bold<\/strong>/);
    assert.match(html, /<em>soft<\/em>/);
    assert.match(html, /<code style="[^"]*background[^"]*">npm test<\/code>/);
    assert.match(html, /<ul style="[^"]+">\s*<li style="[^"]+">one<\/li>/);
    assert.match(html, /<a style="[^"]+" href="https:\/\/preview\.example\.com">the preview<\/a>/);
    assert.match(html, /<pre style="[^"]+"><code style="[^"]+">const a = 1;/);
  });

  it("escapes raw HTML instead of passing it through", () => {
    const html = renderEmailMarkdown('<script>alert(1)</script> <img src=x onerror="alert(1)"> <a href="https://evil.example">x</a>', BASE);
    assert.equal(html.includes("<script"), false);
    assert.equal(html.includes("<img"), false);
    assert.equal(html.includes('<a href="https://evil.example"'), false);
    assert.match(html, /&lt;script&gt;/);
  });

  it("empties a link to a script", () => {
    const html = renderEmailMarkdown("[click](javascript:alert(1)) [data](data:text/html,hi)", BASE);
    assert.equal(/javascript:|data:/.test(html), false);
  });

  it("makes a link to a path on this site absolute", () => {
    const html = renderEmailMarkdown("[the card](/b/board/c/123) and [elsewhere](//other.example/x)", BASE);
    assert.match(html, /href="https:\/\/kardboard\.test\/b\/board\/c\/123"/);
    assert.match(html, /href="\/\/other\.example\/x"/);
  });

  it("keeps a plain sentence a paragraph and escapes its ampersands", () => {
    assert.equal(renderEmailMarkdown("Inbox → Review & more", BASE), '<p style="margin:0 0 12px">Inbox → Review &amp; more</p>');
  });
});
