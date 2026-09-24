import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cloneUrl, previewContainerName, previewContainerSpec, previewImageTag, redact, type PreviewRequest } from "../src/previews.js";

const req: PreviewRequest = {
  previewId: "pv1",
  boardSlug: "kardboard",
  cardId: "k6u39mjgb5j2w8",
  host: "k6u39mjg.preview.xode.cc",
  repoUrl: "https://github.com/chriscorbell/kardboard",
  branch: "kardboard/k6u39mjg-runner-hosted-previews",
  githubToken: "ghs_secret",
  dockerfile: "Dockerfile",
  port: 3000,
  env: { KARDBOARD_PREVIEW: "1" },
};

const limits = { network: "kardboard_preview", memoryBytes: 1024, nanoCpus: 1000, pidsLimit: 16 };

describe("cloning a branch for a Preview", () => {
  it("puts the installation token in the clone URL", () => {
    assert.equal(cloneUrl(req.repoUrl, "ghs_secret"), "https://x-access-token:ghs_secret@github.com/chriscorbell/kardboard");
  });

  it("leaves a public repository URL alone when there is no token", () => {
    assert.equal(cloneUrl(req.repoUrl, null), req.repoUrl);
  });

  it("keeps the token out of anything it reports", () => {
    assert.equal(redact("fatal: https://x-access-token:ghs_secret@github.com/x", "ghs_secret"), "fatal: https://x-access-token:***@github.com/x");
    assert.equal(redact("nothing to hide", null), "nothing to hide");
  });
});

describe("the Preview container", () => {
  const spec = previewContainerSpec(req, limits);

  it("is named and tagged from the preview id", () => {
    assert.equal(previewContainerName("pv1"), "kardboard-preview-pv1");
    assert.equal(previewImageTag("pv1"), "kardboard-preview-pv1:latest");
    assert.equal(spec.name, "kardboard-preview-pv1");
    assert.equal(spec.Image, "kardboard-preview-pv1:latest");
  });

  it("joins the preview network only, so branch code cannot reach the runner or the app", () => {
    assert.equal(spec.HostConfig?.NetworkMode, "kardboard_preview");
  });

  it("carries no host path and no credential", () => {
    assert.deepEqual(spec.HostConfig?.Binds, []);
    const envNames = (spec.Env ?? []).map((e) => e.split("=")[0]);
    assert.deepEqual(envNames.sort(), ["KARDBOARD_PREVIEW", "NODE_ENV", "PORT"]);
    assert.ok((spec.Env ?? []).includes("PORT=3000"));
  });

  it("is labelled for cleanup and opted out of Watchtower", () => {
    assert.equal(spec.Labels?.["kardboard.preview"], "pv1");
    assert.equal(spec.Labels?.["kardboard.preview.host"], req.host);
    assert.equal(spec.Labels?.["com.centurylinklabs.watchtower.enable"], "false");
  });

  it("runs under the same limits a Session does", () => {
    assert.equal(spec.HostConfig?.Memory, 1024);
    assert.equal(spec.HostConfig?.NanoCpus, 1000);
    assert.equal(spec.HostConfig?.PidsLimit, 16);
    assert.deepEqual(spec.HostConfig?.CapDrop, ["ALL"]);
    assert.deepEqual(spec.HostConfig?.SecurityOpt, ["no-new-privileges:true"]);
  });
});
