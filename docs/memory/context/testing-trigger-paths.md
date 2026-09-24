# Testing server code that enqueues Triggers

Read when: writing a server test that calls `createCard`, `moveCard`, or anything else that reaches `enqueueTrigger`.

Status: verified
Scope: `packages/app/server`
Verified: 2026-09-15
Source: [children.test.ts](../../../packages/app/server/test/children.test.ts), [orchestrator.ts](../../../packages/app/server/src/services/orchestrator.ts)
Recheck when: `scheduleDispatch` stops unref-ing its timer, or the runner gains a test double.

Every Trigger schedules a dispatch timer, so a test that writes one is a test that can start a Session. Two things keep that out of the way, and a test needs both:

- Set `KARDBOARD_TRIGGER_COALESCE_MS` high before importing the database module, along with `KARDBOARD_DATA_DIR`. The default is 60 s, which is long enough for a fast test but not for a slow one, and a fired dispatch under the noop runner inserts a Session row and schedules its own 20-second end.
- Assert on the `triggers` table rather than on Sessions. What a Card is owed is a row; what runs it is the orchestrator, and there is no runner double to run it against.

The dispatch timer is unref'd, so a pending one never holds the test process open. That is deliberate in production too: the Trigger is a row, and `recoverOnBoot` reschedules it after a restart. Do not turn it into a plain timer without giving tests another way out.
