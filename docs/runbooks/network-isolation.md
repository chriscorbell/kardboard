# Network isolation for Sessions and Previews

Two separate mechanisms. The runner enforces the first on its own; the second is a host firewall
change an Admin applies on minicore.

## One network per Session

A Session container no longer joins `kardboard_workload`. The runner creates
`kardboard-session-<sessionId>` for each Session, connects everything currently on
`kardboard_workload` to it under the aliases those containers already answer to — `app` for MCP,
`egress` for the credential proxy — and starts the Session there. Docker's own
`DOCKER-ISOLATION-STAGE-*` chains keep one bridge away from another, so a Session can no longer
reach a concurrent Session's ports, and the runner remains on `control` only.

The peers are connected with `GwPriority: -1`. Docker gives a container on several networks the
default gateway of the one with the highest priority and breaks ties by network name, and
`kardboard-session-<id>` sorts before `kardboard_control`. At the default priority of 0 the app's
default route, and with it the endpoint behind its published port, moved onto a test Session's
bridge as soon as it was connected on 2026-09-24. At -1 a Session network is never a peer's gateway.
`GwPriority` needs Docker API 1.48 (Engine 28); minicore runs 29.8. One gap is unverified: when
Watchtower recreates the app or the egress proxy mid-Session it reconnects every network the old
container had, with endpoint settings its own Docker client understands, and a client older than
API 1.48 would drop the priority until that Session ends. The check under "Verifying it" shows it.

`kardboard_workload` still exists and is still the definition of "a Session may reach this": the
runner reads its membership at every start. Adding a service a Session should reach means putting
it on `workload` in `deploy/compose.yaml`, nothing else.

The network is removed when the container exits, when a Session is cancelled, and at runner boot
for any Session whose container is already gone. `KARDBOARD_SESSION_NETWORK=shared` in the runner's
environment puts Sessions back on `workload` together; it exists to back the change out in a hurry
and should otherwise stay at `per-session`.

If the runner cannot create the network or connect the peers it refuses to start the Session with
`could not create the session network: …` rather than fall back to the shared network. A Session
that quietly lands next to its neighbours is the thing this prevents.

## One network per Preview

Previews used to share `kardboard_preview`, so one Board's branch code could reach every other
Board's Preview directly. The runner now creates `kardboard_preview_<previewId>` for each Preview,
bridged as `cbnp<hash of the preview id>`, connects whatever sits on `kardboard_preview` — the
preview router, and never an older Preview still attached there — at `GwPriority: -1`, and builds
and runs the Preview on it. `kardboard_preview` is now only where the router lives and the list of
what a Preview's network is peered with.

The name uses underscores, unlike a Session network, so it sorts after `kardboard_control`: even a
reconnect that lost the priority, such as Watchtower recreating the router after a merge, leaves the
router's gateway and published port on `control`.

The network is created before the build, so the build's `RUN` steps use it too. It is removed with
the Preview, after a first build that failed, and at runner boot for any Preview whose container is
gone. A failed rebuild keeps it, because the previous container is still serving there. A Preview
started before this change stays on `kardboard_preview` until its next rebuild moves it.

If the router is not on `kardboard_preview`, the build fails with
`no preview router on kardboard_preview to reach the Preview`.

## Keeping both kinds of container off the LAN

[ADR 0003](../adr/0003-unrestricted-agent-egress-in-v1.md) accepts that a Session reaches the public
internet. It does not accept that a Session reaches 10.0.0.0/24 or another stack's bridge, which
Docker's NAT otherwise allows. Docker has no per-network egress filter, so the rule is in the host
firewall.

Every bridge kardboard creates is named with the `cbn` prefix: the runner sets
`com.docker.network.bridge.name` to `cbn<hash of the session id>` (eleven characters, inside the
fifteen Linux allows for an interface) or `cbnp<hash of the preview id>`, and `deploy/compose.yaml`
names the router's preview bridge `cbnprev`. One `-i cbn+` match therefore covers every Session,
every Preview, and every Preview build, and needs no update when either starts.

On minicore the script is installed as `/usr/local/sbin/kardboard-network-isolation`, and
[`deploy/kardboard-lan-isolation.service`](../../deploy/kardboard-lan-isolation.service) runs it
whenever Docker starts, so the rules come back after a reboot or a `systemctl restart docker`. To
install or update both, from a checkout of this repository, as root:

```bash
install -m 755 deploy/network-isolation.sh /usr/local/sbin/kardboard-network-isolation
install -m 644 deploy/kardboard-lan-isolation.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now kardboard-lan-isolation
```

By hand:

```bash
kardboard-network-isolation check     # what is installed now
kardboard-network-isolation apply     # insert the rules; idempotent
kardboard-network-isolation remove    # take them out again
```

It inserts, into `DOCKER-USER`, a drop for new connections arriving on a `cbn*` bridge and leaving
for 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 or 100.64.0.0/10 on anything that is
not another `cbn*` bridge — so a Session still reaches `app` and `egress` on its own bridge — plus
one `INPUT` drop for new connections from a `cbn*` bridge to any of the host's own addresses, which
covers sshd and every published port behind each bridge gateway.

Only new connections are dropped, because replies must pass. While a Session runs, the app and the
egress proxy are also on its bridge. The gateway priority above keeps their outbound traffic off it,
but before that change the app's default route moved to a test Session bridge on 2026-09-24, and a
rule that dropped every packet would then have dropped the app's replies to cloudflared, on another
private bridge, and taken kardboard.cc dark whenever a Session ran. Matching only new connections
keeps that failure impossible even if a peer is ever connected without the priority again.

Applying it needs the preview network recreated once, because a bridge name cannot be changed in
place: `docker compose down && docker compose up -d`. Session networks are created fresh by the
runner and need nothing.

### What it does not cover

- **A host without the systemd unit.** A reboot loses the rules; install the unit above rather
  than re-running `apply` by hand.
- **IPv6.** Docker's IPv6 is off on minicore, so only `iptables` is touched. Turning IPv6 on means
  mirroring these rules in `ip6tables`.

### Verifying it

From inside a running Session container, with `docker exec`:

```bash
# reachable: the services on this Session's own bridge
getent hosts app egress
# not reachable, with the rules applied
ping -c1 -W2 10.0.0.20 ; nc -z -w2 10.0.0.1 80
# not reachable, with or without them: another Session's container
getent hosts kardboard-session-<other id>
```

`docker network inspect kardboard-session-<id>` should list exactly three containers: the Session,
the app, and the egress proxy. While it runs, the app's default route must still leave through
`control`:

```bash
docker exec kardboard-app-1 ip route show default   # the gateway is on kardboard_control's subnet
docker inspect kardboard-app-1 --format '{{range $n, $e := .NetworkSettings.Networks}}{{$n}} {{$e.GwPriority}}{{println}}{{end}}'
```

The second command should show `-1` against every `kardboard-session-*` network. A Session network
created by a runner from before 2026-09-24 connected its peers at 0 and keeps doing so until that
Session ends. The same check against `kardboard-preview-router-1` should show `-1` against every
`kardboard_preview_*` network, and `docker network inspect kardboard_preview_<id>` should list the
Preview and the router and nothing else.

Last verified on minicore on 2026-09-24: the rules and the systemd unit were installed, the stack
was recreated so the preview bridge is `cbnprev`, and a throwaway container on a `cbn` bridge
resolved DNS and reached the internet and `app` by name, but not 10.0.0.1, the host's LAN address,
a published port on its own bridge gateway, or the tailnet resolver. kardboard.cc answered
throughout while the app was joined to that test bridge. A real Session then ran on its own `kardboard-session-<id>` network, and the public
preview host still answered through the router. The gateway priority and the per-Preview networks
came after that check and have not yet run on minicore.
