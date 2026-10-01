# Parallel pull requests conflict in `docs/design.md` even when their changes do not overlap

Read when: several pull requests are being prepared at once, or a rebase stops on `docs/design.md`.

Status: verified
Scope: workspace, `docs/design.md`
Verified: 2026-09-30
Source: the security hardening pass of 2026-09-30, PRs 63 to 74: #65 conflicted with #63, and #70 with #72, each only in `docs/design.md`

Symptom: a pull request that was `MERGEABLE` turns `CONFLICTING` as soon as another one merges, though the two touch different code and say different things.

Cause: `docs/design.md` keeps each paragraph on a single line. Two pull requests that each add a sentence to the same paragraph change the same line, so git cannot merge them, however far apart the sentences are. The design paragraphs on Previews and on what a Session's token can do collect most security and Session changes, so work fanned out in parallel lands there together.

Correction: merge such pull requests one at a time. Rebase the next onto `main`, take `main`'s paragraph, and add the pull request's sentences back where they belong in it; a three-line script that asserts both versions' sentences are present before writing is safer than editing the conflict by hand. When code also merged during the rebase, rerun typecheck and the app tests before pushing, since the pull request's own CI ran against the old `main`. When planning parallel work, expect this and order the merges, rather than discovering it at the merge button.
