import type { Card } from "@kardboard/shared";

// What the card sheet says about a Card's Preview. A runner Preview carries its build status and
// the commit it was built from; an external one is only a URL the project's CI published.

export type PreviewDisplay =
  | { kind: "link"; stale: boolean; note: string | null }
  | { kind: "building"; rebuilding: boolean; note: string }
  | { kind: "failed"; error: string };

const short = (sha: string) => sha.slice(0, 7);

export function previewDisplay(card: Pick<Card, "previewUrl" | "preview" | "prHeadSha">): PreviewDisplay | null {
  if (!card.previewUrl) return null;
  const preview = card.preview;
  if (!preview) return { kind: "link", stale: false, note: null };
  if (preview.status === "failed") return { kind: "failed", error: preview.error ?? "The build failed and the runner did not say why." };
  if (preview.status === "building") {
    // A rebuild keeps the previous build up until the new one replaces it.
    return preview.sha
      ? { kind: "building", rebuilding: true, note: `A new build is running. Until it finishes, the preview shows the build of ${short(preview.sha)}.` }
      : { kind: "building", rebuilding: false, note: "The first build is running. The preview shows a holding page until it finishes." };
  }
  const stale = Boolean(preview.sha && card.prHeadSha && preview.sha !== card.prHeadSha);
  return {
    kind: "link",
    stale,
    note: stale ? `This preview is of ${short(preview.sha!)}, an older commit than the pull request's ${short(card.prHeadSha!)}.` : preview.sha ? `Built from ${short(preview.sha)}.` : null,
  };
}
