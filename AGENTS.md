# AGENTS.md

This file holds non-obvious repo context. Keep it current. When you find a repo quirk worth noting, add the smallest useful note.

## Context

- Lando Core v4 is a Bun workspace for `@lando/core`, `@lando/sdk`, and bundled reference plugins under `plugins/*`.

## Commands

- Use Bun, not Node/npm/yarn/pnpm: `bun install`, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.
- Run a focused test by path, e.g. `bun test core/test/unit/bootstrap.test.ts`.
- Root `typecheck` is `tsc -b`; it may create `dist/` and `.tsbuildinfo` even though older prose says no emit. `bun run clean` removes generated package outputs.
- For a single workspace package, follow the repo's Bun filter style, e.g. `bun run --filter='@lando/core' typecheck`.
- After adding a new `plugins/*` workspace package, run `bun install` so root `node_modules` gets the workspace symlink before testing imports from the repo root.

## Gotchas

- **CLI fast path:** `core/src/cli/index.ts` must not statically import OCLIF, Effect, or transitives — ESM hoists imports before `import.meta.main`. Use dynamic `import()` from a wrapper. Full CLI: `core/bin/lando.ts`.
- **Compile entry:** `bun build --compile` must target `core/bin/lando.ts`, not `core/src/cli/index.ts` (the latter silently exits 0 for `--help` and all commands).
- **Compiled binary:** Until full OCLIF routing, each CLI command needs a matching handler in `core/src/cli/run.ts` (`$bunfs`), including matching error `remediation` and `NotImplementedError` behavior. Do not use `import.meta.url` for package metadata or install dir — use `core/src/version.ts` and `process.execPath` (`shellenv`).
- **OCLIF tests/manifest:** Fixture tests need `ignoreManifest: true` on `Config.load`. Generate manifest via `bun run codegen`, not `bunx oclif manifest` (Bun breaks on workspace TS symlinks).
- **Fresh CLI vs provider cache:** Stop/info/destroy in a new process cannot rely on in-memory applied plans; pass `AppPlan` via `AppSelector.plan` / `ServiceSelector.plan`.
- **FileSystem:** `writeAtomic` is copy-based, not crash-atomic rename. `remove` deletes files only, not directories.
- **CI codegen:** Bun version comes from `.bun-version`, not `package.json#engines.bun` (a semver range broke lockfile alignment).
