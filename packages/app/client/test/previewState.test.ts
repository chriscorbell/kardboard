import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Card, CardPreview } from "@kardboard/shared";
import { previewDisplay } from "../src/routes/board/previewState.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const at = "2026-09-24T10:00:00.000Z";
const card = (preview: CardPreview | null, prHeadSha: string | null = A, previewUrl: string | null = "https://k6u39mjg.kardboard.cc") =>
  ({ previewUrl, preview, prHeadSha }) as Pick<Card, "previewUrl" | "preview" | "prHeadSha">;

describe("what the card sheet says about a Preview", () => {
  it("says nothing when the card has no preview URL", () => {
    assert.equal(previewDisplay(card(null, A, null)), null);
  });

  it("is a plain link for an external preview, which has no build to report", () => {
    assert.deepEqual(previewDisplay(card(null)), { kind: "link", stale: false, note: null });
  });

  it("is a plain link to a running preview of the pull request's head", () => {
    assert.deepEqual(previewDisplay(card({ status: "running", error: null, sha: A, updatedAt: at })), { kind: "link", stale: false, note: "Built from aaaaaaa." });
  });

  it("marks a running preview of an older commit than the pull request's head", () => {
    const shown = previewDisplay(card({ status: "running", error: null, sha: A, updatedAt: at }, B));
    assert.equal(shown?.kind, "link");
    assert.equal(shown?.kind === "link" && shown.stale, true);
    assert.match(shown?.kind === "link" ? (shown.note ?? "") : "", /of aaaaaaa, an older commit than the pull request's bbbbbbb/);
  });

  it("does not call a preview stale when either commit is unknown", () => {
    assert.equal((previewDisplay(card({ status: "running", error: null, sha: null, updatedAt: at }, B)) as { stale: boolean }).stale, false);
    assert.equal((previewDisplay(card({ status: "running", error: null, sha: A, updatedAt: at }, null)) as { stale: boolean }).stale, false);
  });

  it("tells a first build from a rebuild that still serves the previous one", () => {
    assert.deepEqual(previewDisplay(card({ status: "building", error: null, sha: null, updatedAt: at })), {
      kind: "building",
      rebuilding: false,
      note: "The first build is running. The preview shows a holding page until it finishes.",
    });
    const rebuild = previewDisplay(card({ status: "building", error: null, sha: A, updatedAt: at }));
    assert.equal(rebuild?.kind === "building" && rebuild.rebuilding, true);
  });

  it("carries a failed build's error", () => {
    assert.deepEqual(previewDisplay(card({ status: "failed", error: "build failed: exit 1", sha: A, updatedAt: at })), { kind: "failed", error: "build failed: exit 1" });
    assert.match((previewDisplay(card({ status: "failed", error: null, sha: null, updatedAt: at })) as { error: string }).error, /did not say why/);
  });
});
