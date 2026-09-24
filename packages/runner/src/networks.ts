import type Docker from "dockerode";

// A Session used to join the shared `workload` network, where every other running Session was a
// hostname away. Each Session now gets a network of its own instead, and the containers a Session
// is meant to reach — whatever sits on `workload`, today the app and the egress proxy — are
// connected to it under the same aliases they answer to there. Docker's own inter-network isolation
// then keeps one Session's bridge away from another's, and the runner stays off all of them.
//
// The bridge is named rather than left to Docker so a host firewall rule can match every Session
// and Preview bridge by prefix; see `deploy/network-isolation.sh`.

export const SESSION_BRIDGE_PREFIX = "cbn";

export const sessionNetworkName = (sessionId: string) => `kardboard-session-${sessionId}`;

// Linux caps an interface name at 15 characters, so the bridge carries a 32-bit FNV-1a hash of the
// session id rather than the id itself. Eleven characters, and stable for a given Session.
export function sessionBridgeName(sessionId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${SESSION_BRIDGE_PREFIX}${hash.toString(16).padStart(8, "0")}`;
}

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
// compose puts on `workload` is what gets connected to each Session's own network. A Session
// container left over from before this change is skipped, so one Session never gains another.
export async function workloadPeers(docker: Docker, workloadNetwork: string): Promise<SessionPeer[]> {
  const network = await docker.getNetwork(workloadNetwork).inspect();
  const peers: SessionPeer[] = [];
  for (const id of Object.keys(network.Containers ?? {})) {
    const info = await docker.getContainer(id).inspect().catch(() => null);
    if (!info || info.Config?.Labels?.["kardboard.session"]) continue;
    peers.push({ id: info.Id, name: info.Name.replace(/^\//, ""), aliases: peerAliases(info, workloadNetwork) });
  }
  return peers;
}

// Creating the network is idempotent, so a retried start reuses it, and so is each connect: Docker
// reports an existing endpoint as an error and there is nothing to undo about it.
export async function createSessionNetwork(docker: Docker, sessionId: string, boardSlug: string, workloadNetwork: string): Promise<string> {
  const name = sessionNetworkName(sessionId);
  const existing = await docker.getNetwork(name).inspect().catch(() => null);
  if (!existing) await docker.createNetwork(sessionNetworkSpec(sessionId, boardSlug));
  const network = docker.getNetwork(name);

  const peers = await workloadPeers(docker, workloadNetwork);
  if (peers.length === 0) throw new Error(`no container on ${workloadNetwork} for a Session to reach`);
  for (const peer of peers) {
    await network.connect({ Container: peer.id, EndpointConfig: { Aliases: peer.aliases } }).catch((err: Error) => {
      if (!/already exists|already attached/i.test(err.message)) throw err;
    });
  }
  return name;
}

// Docker refuses to remove a network with endpoints on it, and the peers are long-lived services
// that must survive, so each is disconnected first.
export async function removeSessionNetwork(docker: Docker, sessionId: string): Promise<boolean> {
  const network = docker.getNetwork(sessionNetworkName(sessionId));
  const info = await network.inspect().catch(() => null);
  if (!info) return false;
  for (const id of Object.keys(info.Containers ?? {})) {
    await network.disconnect({ Container: id, Force: true }).catch(() => {});
  }
  await network.remove().catch((err: Error) => console.warn(`[runner] could not remove ${sessionNetworkName(sessionId)}`, err.message));
  return true;
}

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
