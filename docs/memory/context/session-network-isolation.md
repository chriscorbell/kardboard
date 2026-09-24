# Session and Preview network isolation

Read when: changing which containers a Session may reach, adding a service to `kardboard_workload`,
naming a Docker bridge, or explaining why a Session failed with "could not create the session
network".
Status: verified
Scope: component, `packages/runner`, `deploy/compose.yaml`, minicore host firewall
Verified: 2026-09-24
Source: [network isolation runbook](../runbooks/network-isolation.md),
[packages/runner/src/networks.ts](../../../packages/runner/src/networks.ts)
Recheck when: the runner stops reading `kardboard_workload` membership to decide a Session's peers,
the `cbn` bridge prefix changes, or the `kardboard-lan-isolation` unit is removed from minicore

Two facts that are not visible from either file on its own.

**`kardboard_workload` is now a list, not a place.** No Session container joins it. The runner
inspects its membership at every start and connects those containers — the app and the egress
proxy — to a fresh `kardboard-session-<id>` bridge under the aliases they already answer to, then
starts the Session there. A service a Session should reach is still added by putting it on
`workload` in `deploy/compose.yaml` and nothing else, but a service put there expecting a Session
to *find* it must carry a compose service name or a network alias, because that alias is what gets
copied. The runner refuses the start rather than falling back to the shared network, so a
misconfigured `workload` fails every Session on the Board with a message on the Card.

**The `cbn` bridge prefix is a contract with the host firewall, not a label.** The runner sets
`com.docker.network.bridge.name` to `cbn<32-bit FNV-1a of the session id>` and `deploy/compose.yaml`
names the preview bridge `cbnprev`, because Linux allows fifteen characters for an interface name
and `deploy/network-isolation.sh` matches `-i cbn+` to drop LAN traffic. Renaming either breaks the
rule silently: containers keep working and regain the LAN. The rule is not part of the Compose
stack: on minicore a systemd unit, `kardboard-lan-isolation`, re-applies it whenever Docker starts,
and `kardboard-network-isolation check` shows what is installed. PR 13 merged on 2026-09-15 but the
rule and the `cbnprev` bridge only reached minicore on 2026-09-24, because Watchtower applies images
and never Compose or host changes.
