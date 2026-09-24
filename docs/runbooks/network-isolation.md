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

On minicore, as root:

```bash
cd /home/chris/docker/stacks/kardboard
./network-isolation.sh check     # what is installed now
./network-isolation.sh apply     # insert the rules; idempotent
./network-isolation.sh remove    # take them out again
```

It inserts, into `DOCKER-USER`, a drop for traffic arriving on a `cbn*` bridge and leaving for
10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 or 100.64.0.0/10 on anything that is not
another `cbn*` bridge — so a Session still reaches `app` and `egress` on its own bridge — plus one
`INPUT` drop for the host's own LAN address.

Applying it needs the preview network recreated once, because a bridge name cannot be changed in
place: `docker compose down && docker compose up -d`. Session networks are created fresh by the
runner and need nothing.

### What it does not cover

- **A host reboot or `systemctl restart docker`** rebuilds the chains and loses the rules. Re-run
  `apply`, or persist them with `iptables-persistent` or a systemd unit ordered after Docker.
- **Host ports published on the bridge gateway.** A container can still reach the host at its
  bridge gateway address, which reaches published ports 3070 and 3073 — the app and the preview
  router. Both are services a Session may already reach by name, so this is not new exposure, but
  it is not closed either.
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
