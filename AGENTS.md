# AGENTS.md

This file is for non-obvious repo context only. It is a living document that you should keep up to date. If you lose time to a repo quirk that should have been documented, update this file with the smallest useful note.

## Context

- Lando Core v4 is a Bun workspace for `@lando/core`, `@lando/sdk`, and bundled reference plugins under `plugins/*`.

## Commands

- Use Bun, not Node/npm/yarn/pnpm: `bun install`, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.
- Run a focused test by path, e.g. `bun test core/test/unit/bootstrap.test.ts`.
- Root `typecheck` is `tsc -b`; it may create `dist/` and `.tsbuildinfo` despite older prose saying no emit. `bun run clean` removes generated package outputs.
- For a single workspace package, follow the repo's Bun filter style, e.g. `bun run --filter='@lando/core' typecheck`.

## Gotchas

- In non-interactive shells, Bun may be installed at `/home/aaron/.bun/bin/bun` but absent from `PATH`; prefix repo commands with `PATH=/home/aaron/.bun/bin:$PATH` if workspace scripts invoke `bun` internally.
- OCLIF fixture tests should pass `ignoreManifest: true` to `Config.load(...)`; otherwise a stale `core/oclif.manifest.json` can make OCLIF dispatch repo commands instead of fixture commands.
