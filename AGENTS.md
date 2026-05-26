# AGENTS.md

Keep repo-specific quirks here. **This file is authoritative** for agents and contributors working in this repo — follow it unless a task explicitly overrides it. Update or remove a note when implementation changes make it stale. Items marked **(interim)** describe temporary behavior or known gaps; revise them when the underlying quirk is fixed (do not leave stale interim notes).

## Context

- Lando Core v4 is a Bun workspace for `@lando/core`, `@lando/sdk`, and bundled reference plugins under `plugins/*`.

## Commands

- Use Bun, not Node/npm/yarn/pnpm: `bun install`, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`.
- Treat `bun run typecheck` and `bun test` as the combined gate — root `tsc -b` does not typecheck `sdk/test/`.
- Run a focused test by path, e.g. `bun test core/test/unit/bootstrap.test.ts`.
- Root `typecheck` is `tsc -b`; it may create `dist/` and `.tsbuildinfo`. `bun run clean` removes generated package outputs.
- For a single workspace package, follow the repo's Bun filter style, e.g. `bun run --filter='@lando/core' typecheck`.
- After adding a new `plugins/*` workspace package, run `bun install` so root `node_modules` gets the workspace symlink before testing imports from the repo root.

## Gotchas

- **Hot path:** `core/src/cli/index.ts` and `core/src/cli/oclif/pre-renderer.ts` sit on the cold-start / first-byte path. No static imports of Effect, OCLIF, `@lando/sdk`, renderer code, or plugins — pre-renderer is bun builtins only; the index wrapper uses dynamic `import()` for everything else. Tests in `core/test/cli/fast-path-canary-preload.ts` and `paint-banner.test.ts` enforce this.
- **Compiled binary entry:** `bun build --compile` targets `core/bin/lando.ts`, not `index.ts`. Compiled code must not use `import.meta.url` for package metadata or install paths — use `core/src/version.ts` and `process.execPath` instead.
- **Dual CLI dispatch (interim):** Source mode uses OCLIF (`core/src/cli/oclif/` via `execute()`). The compiled `$bunfs` binary bypasses OCLIF and routes through a hand-rolled dispatcher (`runCompiledCli` in `core/src/cli/run.ts`). Tracked as `spec/08-cli-and-tooling.md` §8.4.1 (parity rules + accepted divergences) and as a GA-blocking open decision in `spec/01-mission-and-tenets.md` §14.2 ("Compiled-binary CLI dispatch unification"); spike scheduled in `spec/ROADMAP.md` Phase 3 Beta. Remove or rewrite this bullet when the spike closes the §14.2 row. Until then, keep error handling, flags, and routing in sync across both paths.
- **Single source of truth (interim):** While dual dispatch exists, shared CLI behavior belongs in one module both paths import (e.g. `deferred-commands.ts`, `bug-report.ts`, `renderer-selection.ts`) — don't fork logic into OCLIF commands and `run.ts` separately. This is normative under spec §8.4.1's parity rules; drop the constraint if dispatch converges to a single router and §8.4.1 is folded into a historical note.
- **Compiled CLI test coverage (interim):** Most scenario tests exercise source mode (`core/bin/lando.ts`), not `core/dist/lando`. Spec §8.4.1 mandates the §13.1 layer-coverage rules treat both as the same surface even when the per-test target differs; update this note if compiled-binary parity becomes the default test harness.
- **Renderer not wired at CLI command boundary (interim):** Commands in `core/src/cli/run.ts` and per-command `render` helpers write to `process.stdout`/`process.stderr` directly via `console.log`/`console.error`. The `--renderer=lando|json|plain` flag parses through `core/src/cli/renderer-selection.ts` but its mode does not reach a `Renderer` Live Layer. The §2.4 "two carve-outs only" rule and the §13.4 lint gate are therefore not yet enforceable. Tracked as `spec/01-mission-and-tenets.md` §14.2 ("Renderer wiring at the CLI command boundary"); resolution scheduled in `spec/ROADMAP.md` Phase 3 Beta. Remove this bullet when that §14.2 row closes.
- **AOT bootstrap-layer codegen not yet shipped (interim):** Spec §2.4 forbids runtime `Layer.merge` / `Layer.provide` chains outside the §17.2 codegen output, but the codegen has not landed and `core/src/runtime/layer.ts` builds the runtime via runtime `Layer.mergeAll` chains. Scheduled in `spec/ROADMAP.md` Phase 3 Beta ("AOT bootstrap-layer codegen (§17.2)"). Remove this bullet when the Beta deliverable lands.
- **Effect layer wiring:** `Effect.serviceOption(X)` resolves against what the current layer provides at build time — not against sibling layers in `Layer.mergeAll`. Dependencies must be `Layer.provide`'d on the sub-layer that needs them, or the service silently stays unavailable.
- **SDK public surface:** Anything exported from `@lando/sdk` is compatibility-locked. When changing schema, services, events, or errors, follow `sdk/AGENTS.md` (update `sdk/API_COMPATIBILITY.md`, fixtures, and test doubles as needed).
- **Generated output:** Codegen scripts must finish with `biome check --write` on emitted files (not `format` alone). After generator changes, run the relevant `bun run codegen:*` and confirm `git diff --exit-code` on the generated paths.
