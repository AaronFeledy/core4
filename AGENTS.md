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
- **Generated TS code formatting:** Codegen scripts that write into `core/src/**` must end with `biome format --write <output>` (see `scripts/build-bundled-recipes.ts`). Biome's import-line wrapping rule and the test harness `core/test/build/biome.test.ts` will otherwise turn into a lint failure on any branch that ships a fresh bundled recipe/plugin entry. The drift gate (`bun run codegen` + `git diff --exit-code`) only catches drift if the generator output is already biome-clean.
- **Recipe source resolution:** `core/src/recipes/source.ts#resolveRecipeRef` returns an Effect that either succeeds with a `ResolvedRecipe` (`{ id, source, manifestYaml, root }`) for bare-id bundled recipes (`BUNDLED_RECIPES`) and local `./path`/`/abs/path` directories, or fails with `NotImplementedError(commandId: "recipe.source.resolve", specSection: "§8.8.4")` for `github:`/`git+`/`git@`/`git://`/`npm:`/`registry:` schemes. Built-in recipe ids are matched by `/^[a-z0-9][a-z0-9-]*$/`; anything else (uppercase, tarball/http URLs, unknown prefixes, empty string) falls through to "unknown" scheme rejection — still tagged `NotImplementedError` with the same Beta remediation. For local directory refs the resolver enforces §8.8.3's hard requirement that `recipe.yml`'s top-level `id:` match the directory basename and rejects with `RecipeManifestValidationError` if not. Local IO is wrapped with `Effect.tryPromise` so EACCES/EIO failures stay tagged (`RecipeManifestNotFoundError`) instead of escaping as Effect defects. The compiled `$bunfs` `init` handler and the source OCLIF `apps:init` command both unwrap the Effect via `Effect.runPromiseExit` + `Cause.failureOption` so callers see the tagged error rather than `FiberFailure`.
- **Recipe prompts:** `core/src/recipes/prompts/` exposes `collectPrompts` plus a `PromptIO` seam (`createStdioPromptIO` for prod, `createBufferedPromptIO({ inputs })` for tests). Per-type prompt tests should use the buffered IO to script answers and assert `io.stdout()`/`io.stderr()` — no `Bun.spawn` round-trip needed. CLI integration tests of `lando init` that DO drive subprocess prompts MUST pass `stdin: "pipe"` and write `\n`-separated answers; tests that DON'T script stdin MUST set `stdin: "ignore"` AND pass `--no-interactive`, otherwise `Bun.spawn`'s default `"inherit"` reads from the parent test runner's stdin and hangs. OCLIF wraps long error messages at ~80 columns and indents continuation lines with `\n    `; substring assertions over CLI stderr should normalize whitespace first (`text.replace(/\s+/g, " ")`). `--full` on `lando init` is a confirmation gate only; use `--yes` for defaults-only and `--no-interactive` to fail fast on missing answers.
