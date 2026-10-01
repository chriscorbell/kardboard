# Two runner tests fail on agent-pc whatever the change

Read when: `pnpm -r test` fails in `packages/runner` on "the entrypoint's choice of CLI" with an extra `/.local/bin` in the expected PATH.

Status: provisional
Scope: environment (agent-pc), `packages/runner/test/clis-script.test.ts`
Verified: 2026-09-30
Source: observed on branch `sessions-opt-in-per-board`, which does not touch `packages/runner` or `images/`; observed again on 2026-09-30 on every branch of the security hardening pass, the same two tests and no others, and on unchanged `origin/main`
Recheck when: the test starts bash with `--norc --noprofile`, or agent-pc's shell setup changes

Symptom: "runs the checked current version" and "falls back to the image's own CLI" fail because the PATH that `use_cli` prints starts with `/.local/bin`. The test spawns `bash -c` from Node with only `PATH` and `KARDBOARD_CLIS_DIR` set. On agent-pc that bash reads a startup file that prepends `$HOME/.local/bin`, and with `HOME` unset that is `/.local/bin`. Spawned with `--norc --noprofile` the PATH is clean, and `env -i PATH=/usr/bin:/bin bash -c 'echo $PATH'` from the shell is clean too; which file is read, and why only under Node, is unconfirmed.

Action: treat these two failures as the machine's, not the change's, when the diff leaves the runner alone. Because `pnpm -r test` stops at the first failing package, run `pnpm --filter @kardboard/app test` and the build separately to see the rest. CI runs the suite on a clean runner.
