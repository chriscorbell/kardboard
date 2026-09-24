# A Session's branch can conflict with `main` without the Session noticing

Read when: finishing a card, resuming one whose pull request is already open, or finding that no GitHub Actions run appears on a pull request head.

Status: verified
Scope: every kardboard board
Verified: 2026-09-24
Source: pull request #2 on this repository, observed `"mergeable": "CONFLICTING"` before the merge commit `d67f5c8`; run list and `git merge-tree` checks described below, both run 2026-09-14. Applied again on 2026-09-15 for pull request #8: `main` had moved four commits during the Session and conflicted in four files, and after resolving, `gh pr view` reported `MERGEABLE` with `BLOCKED` exactly as described below.
Recheck when: Sessions stop cloning a fresh workspace per Session, or gain a fetch of the default branch at start

Symptom: a card is reported ready and moved to Review, and pressing Approve would fail. The Session sees nothing wrong: its workspace is a clone made when the Session started, its `origin/main` never moves during the Session, and `git status` is clean.

Cause: `main` advances between Sessions, and a card's branch is often several Sessions old. Pull request #2's branch was cut from the commit before a documentation reconcile on `main`, so it conflicted in three memory index files — exactly the files a documentation-maintaining Session is most likely to touch, which makes this common rather than rare for memory and index edits.

Correction, before reporting and before promising anything about a merge:

```bash
gh pr view <n> --json mergeable,mergeStateStatus --jq '{mergeable, mergeStateStatus}'
```

`CONFLICTING` means resolve it now: `git fetch origin main && git merge origin/main`, resolve, re-run the acceptance command, push. `MERGEABLE` with `mergeStateStatus: BLOCKED` is the normal state for a board repository — the ruleset is waiting for the Approval, not for the Session.

Note that a Session's clone fetches only `refs/heads/main` into `origin/main`. Fetching a card's own branch, or a fresh `main`, needs an explicit `git fetch origin <branch>`.

## A conflicting pull request gets no Actions run at all

Second symptom, worth knowing before escalating: while the pull request conflicts, GitHub creates no `pull_request` workflow run for any head pushed to it, and the head carries no GitHub Actions check suite — not a failed one, not a queued one, nothing. A `pull_request` run builds `refs/pull/<n>/merge`, which cannot be computed while the merge conflicts, so there is nothing to run. Closing and reopening the pull request does not help; only resolving the conflict does. Pushes to `main` keep running normally throughout, because a `push` run needs no merge ref.

This looks exactly like Actions being switched off at the repository, and it was misread that way on this board on 2026-09-14, in the card "GitHub Actions stopped creating runs" — a high-priority card asking the Admin to check Settings → Actions, when nothing was wrong with the settings. The timeline, from `/actions/runs`:

- `main` reached `94ad542` at 18:47Z, the commit that put the branch into conflict. That is where the runs appeared to stop.
- Pull request #2's heads `96cc8d0` (18:57Z) and `d1f6780` (19:08Z) produced no run. Both conflict with `94ad542`, confirmed after the fact with `git merge-tree --write-tree 94ad542 <head>`, which reports conflicts in the three memory index files.
- `d67f5c8` (19:13Z) merged `main` in and resolved the conflict; its run was created immediately, and `fe0e2cc` (19:14Z) ran and passed.

Before concluding that Actions is broken, check `mergeable` as above. Distinguish the two cases: Actions disabled or out of spending affects every ref, so `push` runs on `main` stop too; a conflict affects only that pull request. `gh run list --branch main --limit 3` answers that in one command, and a Session cannot read `/actions/permissions` at all — it gets `403 Resource not accessible by integration`, which is a token limit and not evidence about the settings.
