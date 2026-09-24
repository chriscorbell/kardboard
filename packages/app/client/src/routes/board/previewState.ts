import type { Card } from "@kardboard/shared";

// What the card sheet says about a Card's Preview. A runner Preview carries its build status, the
// commit it serves, and the commit a failed build failed on; an external one is only a URL the
// project's CI published.

export type PreviewDisplay =
  | { kind: "link"; warning: string | null; note: string | null }
  | { kind: "building"; rebuilding: boolean; note: string }
  | { kind: "failed"; error: string; note: string | null };

const short = (sha: string) => sha.slice(0, 7);

export function previewDisplay(card: Pick<Card, "previewUrl" | "preview" | "prHeadSha">): PreviewDisplay | null {
  if (!card.previewUrl) return null;
  const preview = card.preview;
  if (!preview) return { kind: "link", warning: null, note: null };
  if (preview.status === "failed") {
    return {
      kind: "failed",
      error: preview.error ?? "The build failed and the runner did not say why.",
      note: preview.failedSha ? `The build of ${short(preview.failedSha)} failed.` : null,
    };
  }
  if (preview.status === "building") {
    // A rebuild keeps the previous build up until the new one replaces it.
    return preview.sha
      ? { kind: "building", rebuilding: true, note: `A new build is running. Until it finishes, the preview shows the build of ${short(preview.sha)}.` }
      : { kind: "building", rebuilding: false, note: "A build is running. The preview shows a holding page until it finishes." };
  }
  // A running Preview with an error is one whose rebuild was lost, so the previous build still serves.
  if (preview.error) {
    return {
      kind: "link",
      warning: "Rebuild interrupted",
      note: preview.sha ? `A rebuild was interrupted, so this is still the build of ${short(preview.sha)}.` : "A rebuild was interrupted, so this is still the previous build.",
    };
  }
  const stale = Boolean(preview.sha && card.prHeadSha && preview.sha !== card.prHeadSha);
  return {
    kind: "link",
    warning: stale ? "Older commit" : null,
    note: stale ? `This preview is of ${short(preview.sha!)}, an older commit than the pull request's ${short(card.prHeadSha!)}.` : preview.sha ? `Built from ${short(preview.sha)}.` : null,
  };
}
