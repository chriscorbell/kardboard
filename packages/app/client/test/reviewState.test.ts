import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Approval, Card, ChecksSummary, SessionSummary } from "@kardboard/shared";
import { approveGate, checksPageUrl, closeStatement, currentChecks, mergeStatement, reviewGuidance, reviewStage, sentence, showChecks } from "../src/routes/board/reviewState.js";

const HEAD = "a".repeat(40);
const card = { id: "card-1", prNumber: 41, prUrl: "https://github.com/acme/widgets/pull/41", prHeadSha: HEAD, prBaseRef: "main", previewUrl: null, activeSession: null, checks: null } as unknown as Card;
const approval = (fields: Partial<Approval> = {}): Approval => ({ id: "a1", cardId: "card-1", userId: "ada", prNumber: 41, headSha: HEAD, createdAt: "2026-09-24T10:00:00.000Z", invalidatedAt: null, mergeError: null, ...fields });
const checks = (fields: Partial<ChecksSummary>): ChecksSummary => ({ state: "passing", total: 3, failed: 0, pending: 0, sha: HEAD, updatedAt: "2026-09-24T10:00:00.000Z", ...fields });

describe("the review stage", () => {
  it("offers a retry for a refused merge before anything else", () => {
    const refused = approval({ mergeError: "405 Repository rule violations found" });
    assert.deepEqual(reviewStage({ ...card, activeSession: {} as SessionSummary }, [refused]), { kind: "refused", approval: refused });
  });

  it("says a standing approval is being merged", () => {
    assert.equal(reviewStage(card, [approval()]).kind, "approved");
  });

  it("holds Approve while a session works, and when there is nothing to merge", () => {
    assert.equal(reviewStage({ ...card, activeSession: {} as SessionSummary }, []).kind, "working");
    assert.equal(reviewStage({ ...card, prNumber: null, prUrl: null }, []).kind, "no_pr");
    assert.equal(reviewStage(card, [approval({ invalidatedAt: "2026-09-24T10:05:00.000Z" })]).kind, "ready", "a voided approval asks for a fresh one");
  });
});

describe("the checks shown", () => {
  it("are only those read for the head the card shows", () => {
    assert.equal(currentChecks({ ...card, checks: checks({}) })?.state, "passing");
    assert.equal(currentChecks({ ...card, checks: checks({ sha: "b".repeat(40) }) }), null);
  });

  it("leave out an unknown state for members, who can do nothing about it", () => {
    assert.equal(showChecks(checks({ state: "unknown" }), false), false);
    assert.equal(showChecks(checks({ state: "unknown" }), true), true);
    assert.equal(showChecks(checks({ state: "none" }), false), true);
    assert.equal(showChecks(null, true), false);
  });

  it("link to the pull request's checks page", () => {
    assert.equal(checksPageUrl("https://github.com/acme/widgets/pull/41"), "https://github.com/acme/widgets/pull/41/checks");
    assert.equal(checksPageUrl("https://github.com/acme/widgets/pull/41/"), "https://github.com/acme/widgets/pull/41/checks");
    assert.equal(checksPageUrl("https://gitlab.example.com/merge/3"), "https://gitlab.example.com/merge/3");
    assert.equal(checksPageUrl(null), null);
  });
});

describe("what the checks let Approve do", () => {
  it("holds a member back while checks fail", () => {
    const gate = approveGate(checks({ state: "failing", failed: 1 }), false);
    assert.equal(gate.blocked, true);
    assert.equal(gate.override, false);
    assert.match(gate.reason ?? "", /have to pass/);
  });

  it("lets the Admin merge anyway, with a warning that says so", () => {
    const gate = approveGate(checks({ state: "failing", failed: 1 }), true);
    assert.deepEqual([gate.blocked, gate.override], [false, true]);
    assert.equal(gate.warning, "1 of 3 checks failed. As the Admin you can merge it anyway.");
  });

  it("warns, without holding anyone back, while checks are running", () => {
    const gate = approveGate(checks({ state: "pending", pending: 2 }), false);
    assert.deepEqual([gate.blocked, gate.override], [false, false]);
    assert.equal(gate.warning, "2 of 3 checks are still running. Approving now merges without waiting for them.");
  });

  it("says nothing when checks pass, ran not at all, or cannot be read", () => {
    for (const state of ["passing", "none", "unknown"] as const) assert.deepEqual(approveGate(checks({ state }), false), { blocked: false, override: false, reason: null, warning: null });
    assert.equal(approveGate(null, false).blocked, false);
  });
});

describe("what the confirmations say", () => {
  it("names the pull request, the commit, and where it lands", () => {
    assert.equal(mergeStatement(card), "This merges pull request #41 at aaaaaaa into main and moves the card to Done. The project's deploy runs from there.");
    assert.equal(mergeStatement({ ...card, prBaseRef: null, prHeadSha: null }), "This merges pull request #41 into its base branch and moves the card to Done. The project's deploy runs from there.");
  });

  it("says what closing does and does not do", () => {
    assert.equal(closeStatement(card, "Milo"), "The card moves to Done without merging anything. Pull request #41 stays open on GitHub.");
    assert.equal(
      closeStatement({ ...card, previewUrl: "https://card-1.kardboard.cc", activeSession: {} as SessionSummary }, "Milo"),
      "The card moves to Done without merging anything. Milo stops working on it. Its preview is taken down. Pull request #41 stays open on GitHub.",
    );
  });
});

describe("the guidance", () => {
  it("asks for the preview only when there is one", () => {
    assert.match(reviewGuidance({ previewUrl: null }), /^Look over the pull request/);
    assert.match(reviewGuidance({ previewUrl: "https://card-1.kardboard.cc" }), /^Try the preview/);
  });

  it("follows the preview's build when the card carries it", () => {
    assert.match(reviewGuidance({ previewUrl: "https://card-1.kardboard.cc", preview: { status: "building" } }), /still building/);
    assert.match(reviewGuidance({ previewUrl: "https://card-1.kardboard.cc", preview: { status: "failed" } }), /didn't build/);
  });

  it("reads GitHub's fragments as sentences", () => {
    assert.equal(sentence("405 Repository rule violations found"), "405 Repository rule violations found.");
    assert.equal(sentence("GitHub was still checking."), "GitHub was still checking.");
  });
});
