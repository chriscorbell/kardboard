# The Claude GitHub workflows

Read when: editing `.github/workflows/claude-code-review.yml` or `.github/workflows/claude.yml`, changing the model or effort a Claude review runs at, or when a Claude review check on a pull request did nothing.

Status: verified
Scope: the two Claude workflows in this repository
Verified: 2026-09-25
Source: [`claude-code-review.yml`](../../../.github/workflows/claude-code-review.yml); `anthropics/claude-code-action` at tag `v1` (`src/entrypoints/run.ts`, `src/github/token.ts`, `base-action/src/setup-claude-code-settings.ts`); [Claude Code subagent docs](https://code.claude.com/docs/en/sub-agents)
Recheck when: the action's `v1` tag moves to a new pinned Claude Code version, or the review stops using the `code-review` plugin.

The review workflow runs the `code-review` plugin, fetched from `anthropics/claude-code` on every run rather than vendored here. The plugin asks for haiku, sonnet, and opus subagents by alias. Every agent is pinned to `claude-opus-5-5` at `xhigh`: `--model` and `--effort` in `claude_args` set the main agent, subagents inherit the session's effort, and `CLAUDE_CODE_SUBAGENT_MODEL` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` in the `settings` input overrides the model each subagent asks for. The force variable needs Claude Code 2.1.257 or later; action `v1` installs 2.1.283. The action merges the `settings` input into `~/.claude/settings.json`, so its `env` reaches the CLI.

A pull request that changes a Claude workflow file cannot exercise the change. The action's OIDC token exchange refuses a workflow whose content differs from the default branch, and the action logs a warning and skips rather than failing. The first review under a changed workflow is on the next pull request after the merge.
