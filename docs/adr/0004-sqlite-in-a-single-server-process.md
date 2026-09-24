---
status: accepted
date: 2026-09-13
---
# SQLite in WAL mode behind a single server process

Nothing on minicore offers a shared Postgres, and kardboard's writers are a handful of humans and at most a few Sessions at a time. We run web, API, MCP, and the Session orchestrator in one Node process over SQLite in WAL mode on the stack's data bind mount, which matches the fleet's precedent for small apps. A snapshot is taken with `VACUUM INTO` a dated file on the data bind mount, never by copying the live database and its WAL. Postgres becomes worth its operational cost only if a second writer process appears; the runner, egress proxy, and preview router never touch the database and talk to the app over HTTP.
