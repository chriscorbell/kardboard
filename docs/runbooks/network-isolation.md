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

## Keeping both kinds of container off the LAN

[ADR 0003](../adr/0003-unrestricted-agent-egress-in-v1.md) accepts that a Session reaches the public
internet. It does not accept that a Session reaches 10.0.0.0/24 or another stack's bridge, which
Docker's NAT otherwise allows. Docker has no per-network egress filter, so the rule is in the host
firewall.

Every bridge kardboard creates is named with the `cbn` prefix: the runner sets
`com.docker.network.bridge.name` to `cbn<hash of the session id>` (eleven characters, inside the
fifteen Linux allows for an interface), and `deploy/compose.yaml` names the preview bridge
`cbnprev`. One `-i cbn+` match therefore covers every Session and every Preview and needs no update
when a Session starts.

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
egress proxy are also on its bridge, and Docker can route their outbound traffic through it. On
2026-09-24 the app's default route moved to a test Session bridge as soon as it was connected. If
the rule dropped every packet, the app's replies to cloudflared, on another private bridge, would
be dropped, and kardboard.cc would go dark whenever a Session ran.

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
the app, and the egress proxy.

Last verified on minicore on 2026-09-24: the rules and the systemd unit were installed, the stack
was recreated so the preview bridge is `cbnprev`, and a throwaway container on a `cbn` bridge
resolved DNS and reached the internet and `app` by name, but not 10.0.0.1, the host's LAN address,
a published port on its own bridge gateway, or the tailnet resolver. kardboard.cc answered
throughout while the app was joined to that test bridge. A real Session then ran on its own `kardboard-session-<id>` network, and the public
preview host still answered through the router.
