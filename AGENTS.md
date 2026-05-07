# AGENTS.md

This file is for non-obvious repo context only. If you lose time to a repo quirk that should have been documented, update this file with the smallest useful note.

## Context

- Lando Core v4 is a Bun workspace for `@lando/core`, `@lando/sdk`, and bundled reference plugins under `plugins/*`.
- The implementation is still scaffolding-heavy: many runtime/CLI/plugin paths intentionally throw `not implemented`; treat `spec/README.md` and its linked spec parts as the roadmap/source of truth.

## Commands

- Use Bun, not Node/npm/yarn/pnpm: `bun install`, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.
- Run a focused test by path, e.g. `bun test core/test/unit/bootstrap.test.ts`.
- Root `typecheck` is `tsc -b`; it may create `dist/` and `.tsbuildinfo` despite older prose saying no emit. `bun run clean` removes generated package outputs.
- For a single workspace package, follow the repo's Bun filter style, e.g. `bun run --filter='@lando/core' typecheck`.

## Gotchas

- `.github/workflows/*.yml` are stale OCLIF/Node scaffold workflows using `npm`; trust `package.json`, `README.md`, and Bun config instead.
- `@lando/sdk` is contracts only: schemas, service tags, tagged errors, and event payloads. Do not add Live implementations or Bun-specific APIs there.
- The default `@lando/core` entry must not import OCLIF; keep OCLIF usage inside `core/src/cli/oclif/` or the explicit CLI surfaces. New public `@lando/core` exports need library-boundary coverage under `core/test/library/`.
- The compiled binary cannot dynamically import bundled plugins; bundled plugin imports go through `core/src/plugins/bundled.ts`, currently a generated-file stub until the generator exists.
- Plugin manifests may reference modules that are not implemented yet; check package `src/index.ts` status comments before assuming a plugin surface exists.
