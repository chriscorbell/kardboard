---
status: accepted
date: 2026-09-13
---
# Only the runner service holds the Docker socket

Spawning disposable Session and Preview containers requires control of Docker on minicore, and whatever holds the socket is root-equivalent on the host. The public-facing app never mounts the socket. A separate runner service in the same compose stack owns it, listens only on the stack's internal network, and exposes a narrow API: create a Session or Preview container from an approved image with fixed resource limits, stream its logs, stop it, remove it. Session containers run as a non-root user with CPU, memory, pids, and wall-clock limits and never receive the socket themselves.

## Considered options

Mounting the socket into the app was rejected because a web-facing process becomes the host. A generic socket proxy was rejected because it filters endpoints, not intent; the runner's API can refuse anything that is not one of the two container shapes kardboard needs.
