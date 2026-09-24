import type Docker from "dockerode";

// A Session used to join the shared `workload` network, where every other running Session was a
// hostname away. Each Session now gets a network of its own instead, and the containers a Session
// is meant to reach — whatever sits on `workload`, today the app and the egress proxy — are
// connected to it under the same aliases they answer to there. Docker's own inter-network isolation
// then keeps one Session's bridge away from another's, and the runner stays off all of them.
//
// A Preview gets the same arrangement with the preview router as its only peer, so branch code on
// one Board cannot reach another Board's Preview directly the way it could on the shared `preview`
// network, which is now only where the router lives.
//
// The bridge is named rather than left to Docker so a host firewall rule can match every Session
// and Preview bridge by prefix; see `deploy/network-isolation.sh`. The Session container itself
// has only its own network, so that bridge is its gateway and it needs no priority of its own.

export const BRIDGE_PREFIX = "cbn";

export const sessionNetworkName = (sessionId: string) => `kardboard-session-${sessionId}`;

// An underscore, unlike the Session name, so the name sorts after `kardboard_control`: the router
// keeps its gateway on `control` even if something reconnects it without `peerEndpoint`'s priority.
// Watchtower reconnects every network when it recreates the router, which is every merge to main.
export const previewNetworkName = (previewId: string) => `kardboard_preview_${previewId}`;

// Linux caps an interface name at 15 characters, so the bridge carries a 32-bit FNV-1a hash of the
// id rather than the id itself: `cbn` and eight hex digits for a Session, `cbnp` and eight for a
// Preview, so the two can never collide. Stable for a given id.
function fnv1a(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export const sessionBridgeName = (sessionId: string) => `${BRIDGE_PREFIX}${fnv1a(sessionId)}`;
export const previewBridgeName = (previewId: string) => `${BRIDGE_PREFIX}p${fnv1a(previewId)}`;

export function sessionNetworkSpec(sessionId: string, boardSlug: string): Docker.NetworkCreateOptions {
  return {
    Name: sessionNetworkName(sessionId),
    Driver: "bridge",
    // Not internal: a Session still needs GitHub and package registries, per ADR 0003.
    Internal: false,
    Attachable: false,
    Labels: {
      "kardboard.session": sessionId,
      "kardboard.board": boardSlug,
    },
    Options: { "com.docker.network.bridge.name": sessionBridgeName(sessionId) },
  };
}

export function previewNetworkSpec(previewId: string, boardSlug: string): Docker.NetworkCreateOptions {
  return {
    Name: previewNetworkName(previewId),
    Driver: "bridge",
    // Not internal: a Preview's build installs packages and its app may call public APIs.
    Internal: false,
    Attachable: false,
    Labels: {
      "kardboard.preview": previewId,
      "kardboard.board": boardSlug,
    },
    Options: { "com.docker.network.bridge.name": previewBridgeName(previewId) },
  };
}

export interface SessionPeer {
  id: string;
  name: string;
  aliases: string[];
}

// The names a peer answers to on the shared network. Docker puts the short container id in
// `Aliases` alongside the compose service name, and a Session resolves `app` and `egress`, so the
// id is dropped and the compose service name is added when Docker did not report it.
export function peerAliases(info: Docker.ContainerInspectInfo, network: string): string[] {
  const attachment = info.NetworkSettings?.Networks?.[network];
  const service = info.Config?.Labels?.["com.docker.compose.service"];
  const aliases = ((attachment?.Aliases ?? []) as string[]).filter((alias) => alias && !info.Id.startsWith(alias));
  if (service && !aliases.includes(service)) aliases.push(service);
  return aliases;
}

// Membership of the shared network is the definition of "a Session may reach this": whatever
// compose puts on `workload` is what gets connected to each Session's own network, and whatever is
// on `preview` to each Preview's. A Session or Preview container still on a shared network from
// before it had one of its own is skipped, so one never gains another.
export async function workloadPeers(docker: Docker, workloadNetwork: string): Promise<SessionPeer[]> {
  const network = await docker.getNetwork(workloadNetwork).inspect();
  const peers: SessionPeer[] = [];
  for (const id of Object.keys(network.Containers ?? {})) {
    const info = await docker.getContainer(id).inspect().catch(() => null);
    const labels = info?.Config?.Labels ?? {};
    if (!info || labels["kardboard.session"] || labels["kardboard.preview"]) continue;
    peers.push({ id: info.Id, name: info.Name.replace(/^\//, ""), aliases: peerAliases(info, workloadNetwork) });
  }
  return peers;
}

// Docker gives a container with several networks the default gateway of the one with the highest
// `GwPriority`, breaking ties by network name, and `kardboard-session-*` sorts before
// `kardboard_control`. Connected at the default priority, a peer's outbound traffic and its
// published port moved onto whichever Session bridge it joined last; that was seen on minicore on
// 2026-09-24. Below the default, a runner-made network is never a peer's gateway. Needs API 1.48.
export const PEER_GW_PRIORITY = -1;

export function peerEndpoint(aliases: string[]): Docker.EndpointSettings & { GwPriority: number } {
  return { Aliases: aliases, GwPriority: PEER_GW_PRIORITY };
}

// Creating the network is idempotent, so a retried start reuses it, and so is each connect: Docker
// reports an existing endpoint as an error and there is nothing to undo about it.
async function createPeeredNetwork(docker: Docker, spec: Docker.NetworkCreateOptions, peerNetwork: string, noPeers: string): Promise<string> {
  const name = spec.Name!;
  const existing = await docker.getNetwork(name).inspect().catch(() => null);
  if (!existing) await docker.createNetwork(spec);
  const network = docker.getNetwork(name);

  const peers = await workloadPeers(docker, peerNetwork);
  if (peers.length === 0) throw new Error(noPeers);
  for (const peer of peers) {
    await network.connect({ Container: peer.id, EndpointConfig: peerEndpoint(peer.aliases) }).catch((err: Error) => {
      if (!/already exists|already attached/i.test(err.message)) throw err;
    });
  }
  return name;
}

export function createSessionNetwork(docker: Docker, sessionId: string, boardSlug: string, workloadNetwork: string): Promise<string> {
  return createPeeredNetwork(docker, sessionNetworkSpec(sessionId, boardSlug), workloadNetwork, `no container on ${workloadNetwork} for a Session to reach`);
}

// The router is a Preview's only peer. Without it the Preview would build and then be unreachable.
export function createPreviewNetwork(docker: Docker, previewId: string, boardSlug: string, routerNetwork: string): Promise<string> {
  return createPeeredNetwork(docker, previewNetworkSpec(previewId, boardSlug), routerNetwork, `no preview router on ${routerNetwork} to reach the Preview`);
}

// Docker refuses to remove a network with endpoints on it, and the peers are long-lived services
// that must survive, so each is disconnected first.
async function removeNetwork(docker: Docker, name: string): Promise<boolean> {
  const network = docker.getNetwork(name);
  const info = await network.inspect().catch(() => null);
  if (!info) return false;
  for (const id of Object.keys(info.Containers ?? {})) {
    await network.disconnect({ Container: id, Force: true }).catch(() => {});
  }
  await network.remove().catch((err: Error) => console.warn(`[runner] could not remove ${name}`, err.message));
  return true;
}

export const removeSessionNetwork = (docker: Docker, sessionId: string) => removeNetwork(docker, sessionNetworkName(sessionId));
export const removePreviewNetwork = (docker: Docker, previewId: string) => removeNetwork(docker, previewNetworkName(previewId));

// A Session whose container is gone leaves its network behind if the runner was down when it
// exited. Networks are cheap but they hold the peers' endpoints open, so they are swept at boot.
export async function pruneSessionNetworks(docker: Docker): Promise<string[]> {
  const networks = await docker.listNetworks({ filters: { label: ["kardboard.session"] } });
  const containers = await docker.listContainers({ filters: { label: ["kardboard.session"] } });
  const live = new Set(containers.map((c) => c.Labels["kardboard.session"]));
  const removed: string[] = [];
  for (const network of networks) {
    const sessionId = network.Labels?.["kardboard.session"];
    if (!sessionId || live.has(sessionId)) continue;
    await removeSessionNetwork(docker, sessionId);
    removed.push(sessionId);
  }
  return removed;
}

// A Preview's network outlives a failed rebuild, since the previous container still serves on it,
// but not the Preview itself. One whose container is gone is swept at boot, when no build can be
// in flight; a stopped container keeps its network, because Docker may yet restart it.
export async function prunePreviewNetworks(docker: Docker): Promise<string[]> {
  const networks = await docker.listNetworks({ filters: { label: ["kardboard.preview"] } });
  const containers = await docker.listContainers({ all: true, filters: { label: ["kardboard.preview"] } });
  const kept = new Set(containers.map((c) => c.Labels["kardboard.preview"]));
  const removed: string[] = [];
  for (const network of networks) {
    const previewId = network.Labels?.["kardboard.preview"];
    if (!previewId || kept.has(previewId)) continue;
    await removePreviewNetwork(docker, previewId);
    removed.push(previewId);
  }
  return removed;
}
