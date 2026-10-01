# The Claude GitHub workflows

Read when: editing `.github/workflows/claude-code-review.yml` or `.github/workflows/claude.yml`, changing the model or effort a Claude review runs at, or when a Claude review check on a pull request did nothing.

Status: verified
Scope: the two Claude workflows in this repository
Verified: 2026-09-30
Source: [`claude-code-review.yml`](../../../.github/workflows/claude-code-review.yml); `anthropics/claude-code-action` v1.0.238, the commit both workflows pin since PR 66 (`src/entrypoints/run.ts`, `src/github/token.ts`, `base-action/src/setup-claude-code-settings.ts`); [Claude Code subagent docs](https://code.claude.com/docs/en/sub-agents)
Recheck when: the action's pinned commit changes (a Dependabot pull request moves it), or the review stops using the `code-review` plugin.

The review workflow runs the `code-review` plugin, fetched from `anthropics/claude-code` on every run rather than vendored here. The plugin asks for haiku, sonnet, and opus subagents by alias. Every agent is pinned to `claude-opus-5-5` at `xhigh`: `--model` and `--effort` in `claude_args` set the main agent, subagents inherit the session's effort, and `CLAUDE_CODE_SUBAGENT_MODEL` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` in the `settings` input overrides the model each subagent asks for. The force variable needs Claude Code 2.1.257 or later; the pinned v1.0.238 installs 2.1.286. Every action in the workflows is pinned to a commit, and Dependabot proposes minor and patch moves of those pins weekly, never a major; on a Dependabot pull request the action fails the check with "Workflow initiated by non-human actor" (seen on #79), so since 2026-09-30 the review job is skipped when `github.actor` is `dependabot[bot]`. The action merges the `settings` input into `~/.claude/settings.json`, so its `env` reaches the CLI.

A pull request that changes a Claude workflow file cannot exercise the change. The action's OIDC token exchange refuses a workflow whose content differs from the default branch, and the action logs a warning and skips rather than failing. The first review under a changed workflow is on the next pull request after the merge.
