import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Card, CardPreview } from "@kardboard/shared";
import { previewDisplay } from "../src/routes/board/previewState.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const at = "2026-09-24T10:00:00.000Z";
const card = (preview: CardPreview | null, prHeadSha: string | null = A, previewUrl: string | null = "https://k6u39mjg.kardboard.cc") =>
  ({ previewUrl, preview, prHeadSha }) as Pick<Card, "previewUrl" | "preview" | "prHeadSha">;
const preview = (p: Partial<CardPreview>): CardPreview => ({ status: "running", error: null, sha: null, failedSha: null, updatedAt: at, ...p });

describe("what the card sheet says about a Preview", () => {
  it("says nothing when the card has no preview URL", () => {
    assert.equal(previewDisplay(card(null, A, null)), null);
  });

  it("is a plain link for an external preview, which has no build to report", () => {
    assert.deepEqual(previewDisplay(card(null)), { kind: "link", warning: null, note: null });
  });

  it("is a plain link to a running preview of the pull request's head", () => {
    assert.deepEqual(previewDisplay(card(preview({ sha: A }))), { kind: "link", warning: null, note: "Built from aaaaaaa." });
  });

  it("marks a running preview of an older commit than the pull request's head", () => {
    const shown = previewDisplay(card(preview({ sha: A }), B));
    assert.equal(shown?.kind === "link" && shown.warning, "Older commit");
    assert.match(shown?.kind === "link" ? (shown.note ?? "") : "", /of aaaaaaa, an older commit than the pull request's bbbbbbb/);
  });

  it("does not call a preview stale when either commit is unknown", () => {
    assert.equal((previewDisplay(card(preview({ sha: null }), B)) as { warning: string | null }).warning, null);
    assert.equal((previewDisplay(card(preview({ sha: A }), null)) as { warning: string | null }).warning, null);
  });

  it("says a rebuild was interrupted and names the build still being served", () => {
    assert.deepEqual(previewDisplay(card(preview({ sha: A, error: "The rebuild was interrupted before it finished." }))), {
      kind: "link",
      warning: "Rebuild interrupted",
      note: "A rebuild was interrupted, so this is still the build of aaaaaaa.",
    });
  });

  it("tells a build with nothing to serve from a rebuild that still serves the previous one", () => {
    assert.deepEqual(previewDisplay(card(preview({ status: "building" }))), {
      kind: "building",
      rebuilding: false,
      note: "A build is running. The preview shows a holding page until it finishes.",
    });
    const rebuild = previewDisplay(card(preview({ status: "building", sha: A })));
    assert.equal(rebuild?.kind === "building" && rebuild.rebuilding, true);
    assert.match(rebuild?.kind === "building" ? rebuild.note : "", /shows the build of aaaaaaa/);
  });

  it("names the build a rebuild falls back on by what is served, not by what last failed", () => {
    // A failed first build has nothing serving, so the next build is not a rebuild of it.
    const shown = previewDisplay(card(preview({ status: "building", sha: null, failedSha: B })));
    assert.equal(shown?.kind === "building" && shown.rebuilding, false);
  });

  it("carries a failed build's error and the commit it failed on", () => {
    assert.deepEqual(previewDisplay(card(preview({ status: "failed", error: "build failed: exit 1", sha: A, failedSha: B }))), {
      kind: "failed",
      error: "build failed: exit 1",
      note: "The build of bbbbbbb failed.",
    });
    const unknown = previewDisplay(card(preview({ status: "failed" })));
    assert.match((unknown as { error: string }).error, /did not say why/);
    assert.equal((unknown as { note: string | null }).note, null);
  });
});
