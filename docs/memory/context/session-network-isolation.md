# Session and Preview network isolation

Read when: changing which containers a Session may reach, adding a service to `kardboard_workload`,
naming a Docker bridge, connecting a compose service to a runner-made network, or explaining why a
Session failed with "could not create the session network" or a Preview with "no preview router".
Status: verified
Scope: component, `packages/runner`, `deploy/compose.yaml`, minicore host firewall
Verified: 2026-09-24
Source: [network isolation runbook](../runbooks/network-isolation.md),
[packages/runner/src/networks.ts](../../../packages/runner/src/networks.ts)
Recheck when: the runner stops reading `kardboard_workload` membership to decide a Session's peers,
the `cbn` bridge prefix changes, the `kardboard-lan-isolation` unit is removed from minicore, or a
peer is connected to a runner-made network without `peerEndpoint`

Facts that are not visible from any one file on its own.

**`kardboard_workload` is now a list, not a place.** No Session container joins it. The runner
inspects its membership at every start and connects those containers — the app and the egress
proxy — to a fresh `kardboard-session-<id>` bridge under the aliases they already answer to, then
starts the Session there. A service a Session should reach is still added by putting it on
`workload` in `deploy/compose.yaml` and nothing else, but a service put there expecting a Session
to *find* it must carry a compose service name or a network alias, because that alias is what gets
copied. The runner refuses the start rather than falling back to the shared network, so a
misconfigured `workload` fails every Session on the Board with a message on the Card. Previews
work the same way against `kardboard_preview`: each gets `kardboard_preview_<id>` with the router
as its only peer, and a container labelled `kardboard.session` or `kardboard.preview` is never
copied as a peer.

**Joining a network can move a long-lived container's default gateway.** Docker picks a
multi-network container's gateway by `GwPriority`, then by network name, and
`kardboard-session-<id>` sorts before `kardboard_control`. Connected at the default priority, the
app's default route and published-port endpoint moved onto a test Session bridge on 2026-09-24.
The runner now connects every peer at `GwPriority: -1` (`peerEndpoint` in `networks.ts`); anything
that connects a compose service to a runner-made network must do the same. Watchtower reconnects
every network when it recreates a container, possibly without the priority, which is why Preview
networks use underscores and sort after `kardboard_control`; Session networks do not yet.

**The `cbn` bridge prefix is a contract with the host firewall, not a label.** The runner sets
`com.docker.network.bridge.name` to `cbn<32-bit FNV-1a of the session id>` or `cbnp<same of the
preview id>` and `deploy/compose.yaml` names the router's preview bridge `cbnprev`, because Linux allows fifteen characters for an interface name
and `deploy/network-isolation.sh` matches `-i cbn+` to drop LAN traffic. Renaming either breaks the
rule silently: containers keep working and regain the LAN. The rule is not part of the Compose
stack: on minicore a systemd unit, `kardboard-lan-isolation`, re-applies it whenever Docker starts,
and `kardboard-network-isolation check` shows what is installed. PR 13 merged on 2026-09-15 but the
rule and the `cbnprev` bridge only reached minicore on 2026-09-24, because Watchtower applies images
and never Compose or host changes.
