import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Docker from "dockerode";
import {
  createSessionNetwork,
  PEER_GW_PRIORITY,
  peerAliases,
  pruneSessionNetworks,
  removeSessionNetwork,
  sessionBridgeName,
  sessionNetworkName,
  sessionNetworkSpec,
  workloadPeers,
} from "../src/networks.js";

const WORKLOAD = "kardboard_workload";

interface FakeContainer {
  Id: string;
  Name: string;
  labels?: Record<string, string>;
  aliases?: string[];
  running?: boolean;
}

interface FakeNetwork {
  Name: string;
  Labels?: Record<string, string>;
  containers: string[];
}

// Enough of dockerode to drive the network wiring: containers with their attachments, and networks
// with the endpoints on them. Every call the module makes is recorded so a test can assert on it.
function fakeDocker(containers: FakeContainer[], networks: FakeNetwork[]) {
  const calls: string[] = [];
  const byName = (name: string) => networks.find((n) => n.Name === name);
  const inspectContainer = (id: string) => {
    const c = containers.find((x) => x.Id === id || x.Name === id);
    if (!c) throw new Error(`no such container ${id}`);
    return {
      Id: c.Id,
      Name: `/${c.Name}`,
      Config: { Labels: c.labels ?? {} },
      NetworkSettings: { Networks: { [WORKLOAD]: { Aliases: c.aliases ?? [] } } },
    } as unknown as Docker.ContainerInspectInfo;
  };

  const docker = {
    calls,
    networks,
    getContainer: (id: string) => ({ inspect: async () => inspectContainer(id) }),
    getNetwork: (name: string) => ({
      inspect: async () => {
        const net = byName(name);
        if (!net) throw new Error(`no such network ${name}`);
        return { Name: net.Name, Labels: net.Labels ?? {}, Containers: Object.fromEntries(net.containers.map((id) => [id, { Name: id }])) };
      },
      connect: async (opts: { Container: string; EndpointConfig?: { Aliases?: string[]; GwPriority?: number } }) => {
        calls.push(`connect ${name} ${opts.Container} [${(opts.EndpointConfig?.Aliases ?? []).join(",")}] gw=${opts.EndpointConfig?.GwPriority ?? 0}`);
        byName(name)?.containers.push(opts.Container);
      },
      disconnect: async (opts: { Container: string }) => {
        calls.push(`disconnect ${name} ${opts.Container}`);
        const net = byName(name);
        if (net) net.containers = net.containers.filter((id) => id !== opts.Container);
      },
      remove: async () => {
        calls.push(`remove ${name}`);
        const net = byName(name);
        if (net && net.containers.length > 0) throw new Error("network has active endpoints");
        networks.splice(networks.findIndex((n) => n.Name === name), 1);
      },
    }),
    createNetwork: async (spec: Docker.NetworkCreateOptions) => {
      calls.push(`create ${spec.Name} bridge=${spec.Options?.["com.docker.network.bridge.name"]}`);
      networks.push({ Name: spec.Name!, Labels: spec.Labels as Record<string, string>, containers: [] });
    },
    listNetworks: async () => networks.filter((n) => n.Labels?.["kardboard.session"]),
    listContainers: async () => containers.filter((c) => c.running && c.labels?.["kardboard.session"]).map((c) => ({ Labels: c.labels })),
  };
  return docker as unknown as Docker & { calls: string[]; networks: FakeNetwork[] };
}

const stack = (): FakeContainer[] => [
  { Id: "a".repeat(64), Name: "kardboard-app-1", labels: { "com.docker.compose.service": "app" }, aliases: ["aaaaaaaaaaaa", "app"] },
  { Id: "e".repeat(64), Name: "kardboard-egress-1", labels: { "com.docker.compose.service": "egress" }, aliases: ["eeeeeeeeeeee"] },
];

describe("the name a Session's network and bridge get", () => {
  it("names the network after the session", () => {
    assert.equal(sessionNetworkName("nb7qq34ysajgpd"), "kardboard-session-nb7qq34ysajgpd");
  });

  it("keeps the bridge inside the 15-character interface limit and under the firewall's prefix", () => {
    const bridge = sessionBridgeName("nb7qq34ysajgpd");
    assert.ok(bridge.length <= 15, bridge);
    assert.match(bridge, /^cbn[0-9a-f]{8}$/);
  });

  it("gives the same session the same bridge and different sessions different ones", () => {
    assert.equal(sessionBridgeName("abc"), sessionBridgeName("abc"));
    assert.notEqual(sessionBridgeName("abc"), sessionBridgeName("abd"));
  });

  it("asks for a bridge that reaches the internet, since builds and pushes need it", () => {
    const spec = sessionNetworkSpec("s1", "kardboard");
    assert.equal(spec.Driver, "bridge");
    assert.equal(spec.Internal, false);
    assert.equal(spec.Labels?.["kardboard.session"], "s1");
    assert.equal(spec.Options?.["com.docker.network.bridge.name"], sessionBridgeName("s1"));
  });
});

describe("the peers a Session is allowed to reach", () => {
  it("takes the compose service name and drops the container id Docker adds", () => {
    const docker = fakeDocker(stack(), [{ Name: WORKLOAD, containers: ["a".repeat(64), "e".repeat(64)] }]);
    const info = docker.getContainer("a".repeat(64));
    return info.inspect().then((i) => assert.deepEqual(peerAliases(i, WORKLOAD), ["app"]));
  });

  it("falls back to the compose service name when Docker reports no alias", async () => {
    const docker = fakeDocker(stack(), [{ Name: WORKLOAD, containers: ["e".repeat(64)] }]);
    const info = await docker.getContainer("e".repeat(64)).inspect();
    assert.deepEqual(peerAliases(info, WORKLOAD), ["egress"]);
  });

  it("is whatever sits on the shared network, minus any Session still attached to it", async () => {
    const containers = [...stack(), { Id: "s".repeat(64), Name: "kardboard-session-old", labels: { "kardboard.session": "old" }, aliases: [] }];
    const docker = fakeDocker(containers, [{ Name: WORKLOAD, containers: containers.map((c) => c.Id) }]);
    const peers = await workloadPeers(docker, WORKLOAD);
    assert.deepEqual(peers.map((p) => p.name), ["kardboard-app-1", "kardboard-egress-1"]);
  });
});

describe("creating a Session's network", () => {
  it("creates the bridge and connects the peers under the aliases the Session resolves", async () => {
    const docker = fakeDocker(stack(), [{ Name: WORKLOAD, containers: stack().map((c) => c.Id) }]);
    const name = await createSessionNetwork(docker, "s1", "kardboard", WORKLOAD);
    assert.equal(name, "kardboard-session-s1");
    assert.deepEqual(docker.calls, [
      `create kardboard-session-s1 bridge=${sessionBridgeName("s1")}`,
      `connect kardboard-session-s1 ${"a".repeat(64)} [app] gw=-1`,
      `connect kardboard-session-s1 ${"e".repeat(64)} [egress] gw=-1`,
    ]);
  });

  it("never becomes a peer's default gateway, which would carry the app's own traffic and published port", async () => {
    const docker = fakeDocker(stack(), [{ Name: WORKLOAD, containers: stack().map((c) => c.Id) }]);
    await createSessionNetwork(docker, "s1", "kardboard", WORKLOAD);
    const connects = docker.calls.filter((c) => c.startsWith("connect "));
    assert.equal(connects.length, 2);
    assert.ok(connects.every((c) => c.endsWith(` gw=${PEER_GW_PRIORITY}`)), connects.join("\n"));
    assert.ok(PEER_GW_PRIORITY < 0, "below the default of 0 that every compose network gets");
  });

  it("reuses the network on a retried start instead of failing on the duplicate", async () => {
    const docker = fakeDocker(stack(), [
      { Name: WORKLOAD, containers: stack().map((c) => c.Id) },
      { Name: "kardboard-session-s1", Labels: { "kardboard.session": "s1" }, containers: ["a".repeat(64)] },
    ]);
    await createSessionNetwork(docker, "s1", "kardboard", WORKLOAD);
    assert.ok(!docker.calls.some((c) => c.startsWith("create ")));
  });

  it("refuses when nothing is on the shared network, rather than isolating a Session from MCP", async () => {
    const docker = fakeDocker(stack(), [{ Name: WORKLOAD, containers: [] }]);
    await assert.rejects(() => createSessionNetwork(docker, "s1", "kardboard", WORKLOAD), /no container on kardboard_workload/);
  });
});

describe("removing a Session's network", () => {
  it("disconnects the long-lived peers before removing the bridge", async () => {
    const docker = fakeDocker(stack(), [{ Name: "kardboard-session-s1", Labels: { "kardboard.session": "s1" }, containers: ["a".repeat(64), "e".repeat(64)] }]);
    assert.equal(await removeSessionNetwork(docker, "s1"), true);
    assert.deepEqual(docker.calls, [
      `disconnect kardboard-session-s1 ${"a".repeat(64)}`,
      `disconnect kardboard-session-s1 ${"e".repeat(64)}`,
      "remove kardboard-session-s1",
    ]);
    assert.deepEqual(docker.networks, []);
  });

  it("says so when the network is already gone", async () => {
    const docker = fakeDocker(stack(), []);
    assert.equal(await removeSessionNetwork(docker, "s1"), false);
  });

  it("sweeps the networks of Sessions that exited while the runner was down, and spares the live ones", async () => {
    const containers = [...stack(), { Id: "l".repeat(64), Name: "kardboard-session-live", labels: { "kardboard.session": "live" }, running: true }];
    const docker = fakeDocker(containers, [
      { Name: WORKLOAD, containers: [] },
      { Name: "kardboard-session-live", Labels: { "kardboard.session": "live" }, containers: ["l".repeat(64)] },
      { Name: "kardboard-session-gone", Labels: { "kardboard.session": "gone" }, containers: ["a".repeat(64)] },
    ]);
    assert.deepEqual(await pruneSessionNetworks(docker), ["gone"]);
    assert.deepEqual(docker.networks.map((n) => n.Name), [WORKLOAD, "kardboard-session-live"]);
  });
});
