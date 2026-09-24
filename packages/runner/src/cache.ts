import type Docker from "dockerode";

// Every Session starts from a fresh container, so without this each one downloaded the same
// packages again: npm, pnpm, Bun, Go, uv, and pip all spent the first minutes of a run on it. Each
// Board gets one named volume at /cache, shared by its Sessions and kept between them, and the
// agent image points each tool's cache there. Previews never get it: they are branch-controlled
// code with no host state at all.
//
// It is shared at the trust level a Session already has. Any Session on the Board can write what
// the next one installs from, as it can already push code to the Board's repository; it cannot
// reach another Board's cache. An Admin clears one with `docker volume rm kardboard-cache-<boardId>`
// while no Session on that Board is running.

export const CACHE_TARGET = "/cache";

export const cacheVolumeName = (boardId: string) => `kardboard-cache-${boardId}`;

// Docker creates the volume on first use and, because it is empty, seeds it from the image's own
// /cache, which the agent image creates owned by its non-root user. The labels are set only then.
export function cacheMounts(boardId: string | null, boardSlug: string): Docker.MountSettings[] {
  if (!boardId) return [];
  return [
    {
      Type: "volume",
      Source: cacheVolumeName(boardId),
      Target: CACHE_TARGET,
      ReadOnly: false,
      // The Engine API makes DriverConfig optional and leaving it out means the default driver; the
      // dockerode types mark it required.
      VolumeOptions: { NoCopy: false, Labels: { "kardboard.cache": boardId, "kardboard.board": boardSlug } } as unknown as Docker.MountSettings["VolumeOptions"],
    },
  ];
}
