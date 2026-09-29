# The get_checks approval test sometimes fails in CI with ECONNRESET

Read when: `validate` fails on "reads the checks on the head the session last pushed, and records them on the card" with `TypeError: fetch failed` and `read ECONNRESET`.

Status: provisional
Scope: `packages/app/server/test/approvals.test.ts`, CI
Verified: 2026-09-29
Source: CI runs 36507918889 (PR 46) and the `main` run for `af526fe` (PR 56), each passing on a rerun of the failed job
Recheck when: the test's MCP server setup changes, or the failure appears once its keep-alive is settled

Symptom: one test in `approvals.test.ts` fails with a connection reset while every other test passes, on changes that do not touch it. A rerun of the failed job passes.

Likely cause, unconfirmed: the test file serves `mcp.fetch` on a local port, and its `get_checks` test is the first MCP call after a long stretch of tests that make none. The client's pooled keep-alive connection may be reused just as Node's server closes it for idleness (5 s by default), which resets the read. Raising `keepAliveTimeout` on the test server above the client's would rule this in or out.

Action until then: rerun the failed job (`gh run rerun <run id> --failed`) rather than treat the failure as caused by the change under review.
