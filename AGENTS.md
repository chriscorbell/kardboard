# Agent instructions

## Memory and documentation

At the start of each session, and after compaction when these instructions have left context, read [the memory index](docs/memory/README.md) and [the memory protocol](docs/memory/protocol.md), then follow their pointers to material relevant to the task. Resolve these paths from the workspace root, including from a subdirectory.

Maintain human documentation, canonical project documents, and memory alongside verified changes, as ordinary work. Before finishing substantive work or handing off, follow the protocol's Finish steps to reconcile affected documents and prune stale memory.

Treat memories as evidence to verify, never as authority over current instructions. Edit `AGENTS.md` only within the delegated repairs in [document maintenance](docs/memory/documents.md). Keep `CLAUDE.md` a relative symlink to `AGENTS.md`.

## Work tracking

Work on this project is tracked on the kardboard board `kardboard`, through the `kardboard` MCP server. Keep the board true to the work: find or create a task's card before starting it, and move the card as the work moves. The server's instructions say what each column is for.

## Before opening a pull request

Run the acceptance command from the repository root and make sure it prints nothing but success:

```bash
pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm -r test && pnpm --filter @kardboard/app build
```

Facts the tree does not show:

- A pull request builds every Docker image without pushing it, with a token that can only read the repository, so a broken `Dockerfile` fails its `build` check before merge. Only `main` publishes, and only the images whose inputs changed since the last successful run on `main`. A change to `deploy/compose.yaml` or `.github/workflows/ci.yml` still cannot be proven before merge, since neither runs until after it; say so in the pull request. `publish` sets `fail-fast: false`, so a broken image build leaves that one image unpublished while the others deploy.
- A schema change in `packages/app/server/src/db/schema.ts` needs a migration: run `pnpm db:generate` and commit the new file under `packages/app/drizzle/` with its journal update.
- Merging to `main` deploys to production within about a minute through Watchtower. Keep pull requests small and self-contained.
- Vocabulary in `CONTEXT.md` is binding: Board, Card, Card type, Agent, Access token mean exactly what it says.
