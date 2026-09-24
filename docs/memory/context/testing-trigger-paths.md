# Testing server code that enqueues Triggers

Read when: writing a server test that calls `createCard`, `moveCard`, or anything else that reaches `enqueueTrigger`, or a test that has to run a Session through the orchestrator.

Status: verified
Scope: `packages/app/server`
Verified: 2026-09-24
Source: [children.test.ts](../../../packages/app/server/test/children.test.ts), [orchestrator.test.ts](../../../packages/app/server/test/orchestrator.test.ts), [orchestrator.ts](../../../packages/app/server/src/services/orchestrator.ts)
Recheck when: `scheduleDispatch` or `armWallClock` stops unref-ing its timer, or `runner` stops being a plain object whose methods a test can replace.

Every Trigger schedules a dispatch timer, so a test that writes one is a test that can start a Session. Two things keep that out of the way, and a test needs both:

- Set `KARDBOARD_TRIGGER_COALESCE_MS` high before importing the database module, along with `KARDBOARD_DATA_DIR`. The default is 60 s, which is long enough for a fast test but not for a slow one, and a fired dispatch under the noop runner inserts a Session row and schedules its own 20-second end.
- Assert on the `triggers` table rather than on Sessions when what the test is about is what a Card is owed. A row is what survives; running it is the orchestrator's job.

When a test is about the orchestrator itself, `orchestrator.test.ts` shows the pattern. Set `KARDBOARD_RUNNER_URL` to any URL before import, so the client is in http mode and no noop 20-second end is scheduled, then replace `runner.start`, `runner.stop`, and `runner.inventory` on the imported object. Set `KARDBOARD_BACKOFF_BASE_MS` to a few milliseconds so start and inventory retries do not take seconds. Start a dispatch with `scheduleDispatch(cardId, 0)` and poll the database for the outcome; to hold a dispatch open long enough to race another, point `KARDBOARD_EGRESS_URL` at a local server that answers `/limits` slowly.

Dispatch and wall-clock timers are unref'd, so a pending one never holds the test process open. That is deliberate in production too: the Trigger and the Session are rows, and `recoverOnBoot` reschedules the dispatch and re-arms the wall clock after a restart. Do not turn either into a plain timer without giving tests another way out.
