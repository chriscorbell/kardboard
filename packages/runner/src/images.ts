import type Docker from "dockerode";

// Pulling `:latest` over the agent image leaves the previous one untagged on the host, and nothing
// else removes it: no service runs the agent image, so Watchtower never manages it. Only dangling
// images from the same source repository are pruned, so another stack's images are left alone, and
// Docker never prunes an image a container still uses, so a running Session keeps its own.

export const SOURCE_LABEL = "org.opencontainers.image.source";

export function supersededImageFilters(labels: Record<string, string> | undefined): Record<string, string[]> | null {
  const source = labels?.[SOURCE_LABEL];
  return source ? { dangling: ["true"], label: [`${SOURCE_LABEL}=${source}`] } : null;
}

export async function pruneSupersededImages(docker: Docker, image: string): Promise<number> {
  const info = await docker.getImage(image).inspect();
  const filters = supersededImageFilters(info.Config?.Labels);
  if (!filters) return 0;
  const res = await docker.pruneImages({ filters });
  return res.ImagesDeleted?.length ?? 0;
}
