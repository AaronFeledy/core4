# PRD: MVP-02 — Foundation (runtime + bootstrap + build/test infra)

## Introduction

This PRD covers the *imperative shell* of Lando v4: the composed `LandoRuntimeLive` Layer, the `makeLandoRuntime` factory, the OCLIF init hook that wires bootstrap levels to commands, the pre-OCLIF fast paths for `--version` / `version` / `shellenv`, and the build/test infrastructure that everything else relies on.

Today (Phase 0):

- [`core/src/runtime/bootstrap.ts`](../../core/src/runtime/bootstrap.ts) declares `BootstrapLevel` and `BOOTSTRAP_RANK` (Phase 0 already complete).
- [`core/src/runtime/layer.ts`](../../core/src/runtime/layer.ts) declares the `makeLandoRuntime` schema; the factory body is TODO.
- OCLIF command shells exist for ~25 commands; every `run()` body is `Effect.die("not yet implemented")`.
- `core/src/cli/oclif/hooks/init.ts` does not exist yet (or is a stub).
- `bundled.ts` is an empty generated stub at [`core/src/plugins/bundled.ts`](../../core/src/plugins/bundled.ts).
- `tsc -b` clean and `bun test` runs (no real assertions).

Depends on: **PRD-01 (SDK contracts)** — every layer wired here imports SDK service tags, errors, and schemas.

## Goals

- `LandoRuntimeLive` composes correctly for bootstrap levels `none`, `minimal`, `commands`, `provider`, `app` (the levels Phase 1 actually uses). `plugins` and `tooling` exist as skeleton compositions.
- `makeLandoRuntime` works for the CLI shell; library mode throws `NotImplemented` (Alpha 1 makes it real).
- The OCLIF `init` hook reads bootstrap level off the resolved command and provides exactly the matching layer.
- Pre-OCLIF fast path handles `--version`, `-v`, `version`, and `shellenv` in <50ms, never touching Effect.
- `scripts/build-bundled-plugins.ts` and `scripts/codegen.ts` exist and produce a real `bundled.ts`.
- `bun build --compile` produces a Linux x64 binary that runs.
- The test harness lets PRDs 03–06 write Effect-service tests, scenario tests, and CLI tests without rebuilding plumbing.

## User Stories

### US-001: `makeLandoRuntime` factory composes a Layer at the requested bootstrap level

**Description:** As `@lando/core`'s OCLIF init hook, I need `makeLandoRuntime({ bootstrap: <level>, ... })` to return one composed `Layer` that satisfies every required service tag for that level — and only that level.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/runtime/make-runtime.test.ts` calls `makeLandoRuntime({ bootstrap: "minimal" })` and asserts the returned Layer can be `Effect.provide`d to a program that requires `Logger | ConfigService | FileSystem` — and not to one that requires `RuntimeProvider` (level too low).
- [ ] Same test calls `makeLandoRuntime({ bootstrap: "provider" })` and asserts the returned Layer satisfies `RuntimeProvider | RuntimeProviderRegistry`.
- [ ] Same test calls `makeLandoRuntime({ bootstrap: "app" })` and asserts the returned Layer satisfies `LandofileService | AppPlanner | RuntimeProvider`.
- [ ] Failure cases: invalid `bootstrap` value, malformed options object — both fail with `LandoRuntimeBootstrapError` carrying a structured payload.
- [ ] Test passes after `core/src/runtime/layer.ts` factory body is implemented.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-002: OCLIF init hook resolves command's bootstrap level and provides the matching Layer

**Description:** As an OCLIF command, I declare `static bootstrap: BootstrapLevel = "provider"` (etc.) on my class; the init hook reads that level on dispatch and provides me a runtime that satisfies it.

**Acceptance Criteria:**
- [ ] Failing CLI integration test in `core/test/cli/init-hook.test.ts` registers a fixture command with `static bootstrap = "provider"`, dispatches it via OCLIF, and asserts:
  - The hook ran before the command's `run()`.
  - The command's `run()` could `yield* RuntimeProvider` without a missing-context error.
  - A second fixture command with `static bootstrap = "minimal"` cannot `yield* RuntimeProvider` without a missing-context error.
- [ ] Init hook is at `core/src/cli/oclif/hooks/init.ts`, registered in `core/package.json` `oclif.hooks`.
- [ ] Hook fails with `LandoRuntimeBootstrapError` if a command class is missing the `static bootstrap` declaration (no silent default).
- [ ] Test passes after the hook is implemented.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-003: Pre-OCLIF fast path for `--version`, `-v`, `version`

**Description:** As a CI script that runs `lando --version` thousands of times, I need that path to skip OCLIF + Effect entirely and return in <50ms.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/cli/fast-path.test.ts` shells out to `bun run core/src/cli/index.ts --version`, asserts exit code 0, asserts stdout matches the version string from `core/package.json`, and asserts no Effect runtime imports were touched (verified via a debug hook that throws if `makeLandoRuntime` is called).
- [ ] Same test repeats for `-v` and `version`.
- [ ] Wall-clock budget: ≤50ms on a baseline Linux x64 dev machine in `bun test` mode (CI gating on this number is Alpha 3 — the budget at MVP is documented but not enforced).
- [ ] Test passes after the fast-path branch is added at the top of `core/src/cli/index.ts` before any OCLIF import.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-004: Pre-OCLIF fast path for `shellenv`

**Description:** As a user setting up shell integration, `lando shellenv` must run at bootstrap level `none` so it works before *any* lando state exists on the machine.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/cli/fast-path.test.ts` runs `lando shellenv` against the compiled binary and asserts stdout contains the canonical shellenv lines (export of `LANDO_INSTALL_DIR`, prepend of `${LANDO_INSTALL_DIR}/bin` to `PATH`).
- [ ] The output is identical regardless of whether `~/.lando/` exists.
- [ ] Test passes after the fast-path branch handles `shellenv`.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-005: `BUNDLED_PLUGINS` array consumed by PluginRegistry's bundled-only loader

**Description:** As `PluginRegistry.Live`, I read the `BUNDLED_PLUGINS` array from `core/src/plugins/bundled.ts` to decide which plugins are loaded at MVP — no FS scanning, no dynamic imports.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/plugins/bundled.test.ts` asserts `BUNDLED_PLUGINS` is exported as `ReadonlyArray<{ name, layer, manifest }>` and contains all four MVP-bundled plugins (`@lando/provider-lando`, `@lando/provider-docker`, `@lando/service-lando`, `@lando/logger-pretty`) — *empty* layer/manifest stubs are acceptable in this PRD; PRDs 04 and 05 fill them.
- [ ] Test asserts `bundled.ts` is regenerated by `scripts/build-bundled-plugins.ts` (running the script on a fresh checkout produces identical output — i.e. it's idempotent).
- [ ] Test passes after `scripts/build-bundled-plugins.ts` lands and `bundled.ts` is populated with the four entries.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-006: `scripts/codegen.ts` orchestrates all codegen steps

**Description:** As a developer running `bun run codegen`, every codegen output (`bundled.ts`, OCLIF manifest, schema artifacts, recipe asset embedding) is regenerated in one command.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/scripts/codegen.test.ts` runs `bun run codegen` against a fresh checkout, asserts exit code 0, and asserts the listed outputs exist with non-empty contents.
- [ ] The script is at `scripts/codegen.ts` and is idempotent — running it twice produces no diff.
- [ ] At MVP, the orchestrator only needs to call `scripts/build-bundled-plugins.ts` and a placeholder OCLIF manifest step (`oclif manifest`); Beta 1 will add schema artifacts and recipe embedding.
- [ ] Test passes after `scripts/codegen.ts` is implemented.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-007: Compiled binary builds for Linux x64

**Description:** As a developer running `bun run build`, I get a single-file Linux x64 executable in `dist/lando` that runs.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/build/compile.test.ts` (gated on `process.platform === "linux"` and `process.arch === "x64"`; otherwise skipped) runs `bun run build` and asserts:
  - `dist/lando` exists and is executable.
  - `dist/lando --version` prints the package.json version.
  - `dist/lando --help` exits 0 (basic OCLIF help registers commands).
- [ ] `core/package.json` `scripts.build` invokes `bun build --compile --outfile=dist/lando ./src/cli/index.ts` (or equivalent — exact flags per `spec/15-binary-build-and-release.md` MVP guidance).
- [ ] Asset embedding is documented as deferred (Alpha 3) — at MVP, runtime FS reads of plugins/recipes are acceptable; `lando init --full` is allowed to read its hardcoded recipe from the source tree at MVP.
- [ ] Test passes after the build script is wired.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-008: Test harness for Effect services

**Description:** As a PRD-03 implementer, I need a reusable `provideTestRuntime` helper so my service tests don't re-implement Layer composition.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/testing/test-runtime.test.ts` uses a `provideTestRuntime({ bootstrap: "minimal" })` helper, runs `Effect.flatMap(ConfigService, c => c.load)` against it, and asserts a default `GlobalConfig` is returned.
- [ ] The helper lives at `core/src/testing/index.ts` and re-exports from `@lando/core/testing`.
- [ ] At MVP the helper exposes overrides via a `with` option: `provideTestRuntime({ bootstrap: "provider", with: { RuntimeProvider: TestRuntimeProvider } })`.
- [ ] Test passes after the helper is implemented.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-009: `bun test` configuration covers unit + Effect-service + CLI scenario tests

**Description:** As a contributor running `bun test`, every test type Phase 1 ships passes from one command.

**Acceptance Criteria:**
- [ ] Failing test fixtures in `core/test/unit/`, `core/test/services/`, and `core/test/cli/` are each runnable individually (`bun test core/test/unit/...`).
- [ ] Top-level `bun test` discovers all of them.
- [ ] `bunfig.toml` (or equivalent) declares the test pattern explicitly so future test layers (library API, recipe, scenario) can be added by directory convention.
- [ ] No test depends on a real Podman/Docker daemon at this PRD's scope — provider-touching tests are gated on env vars and skipped by default at unit-layer (PRD-04 owns the integration layer).
- [ ] Test passes after `bunfig.toml` and the scaffolding directories exist.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-010: `tsc -b` build-info file `dist/.tsbuildinfo` does not leak into runtime

**Description:** As a release-engineer, I rely on `tsc -b` producing a clean build cache (`AGENTS.md` notes it may write to `dist/`). Production runtime must not depend on those artifacts.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/build/no-runtime-tsbuildinfo.test.ts` asserts `core/dist/.tsbuildinfo` (and any `*.tsbuildinfo` files) are never read at runtime by importing `@lando/core` and asserting via instrumentation that no `.tsbuildinfo` path is opened.
- [ ] `bun run clean` removes `dist/` and `*.tsbuildinfo` from every workspace.
- [ ] Test passes after `bun run clean` is wired and a runtime-instrumentation guard is in place (a simple `Bun.file` interceptor in tests is acceptable).
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-011: `biome check .` is enforced

**Description:** As a contributor, my PR must pass `biome check .` before merge — at MVP that means lint runs locally cleanly on the whole tree.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/build/biome.test.ts` runs `bun run lint` programmatically and asserts exit code 0.
- [ ] `biome.json` (workspace-root) declares the rules used; `core/`, `sdk/`, `plugins/*` all participate.
- [ ] Test passes once lint is clean across the whole tree.
- [ ] Typecheck/lint/whole-workspace tests pass.

## Functional Requirements

- FR-1: `core/src/runtime/layer.ts` exports `makeLandoRuntime(options): Layer<LandoRuntimeServices, LandoRuntimeBootstrapError>` where `LandoRuntimeServices` is the union of service tags satisfied at the requested bootstrap level.
- FR-2: `LandoRuntimeLive` composes correctly for `none`, `minimal`, `commands`, `provider`, `app`. `plugins` composes minimally (no plugin discovery — uses `BUNDLED_PLUGINS`). `tooling` composes as a stub that throws `NotImplemented` if a tag specific to tooling is requested.
- FR-3: OCLIF init hook lives at `core/src/cli/oclif/hooks/init.ts` and is registered in `core/package.json#oclif.hooks.init`.
- FR-4: Pre-OCLIF fast path lives at the very top of `core/src/cli/index.ts`, *before* any `import` of OCLIF or Effect.
- FR-5: `BUNDLED_PLUGINS` is exported from `core/src/plugins/bundled.ts` and is *only* written by `scripts/build-bundled-plugins.ts`. The file has a header comment marking it generated.
- FR-6: `scripts/codegen.ts` is idempotent; running it twice produces no diff.
- FR-7: `bun run build` produces `dist/lando` for Linux x64 by default.
- FR-8: `core/src/testing/index.ts` exports `provideTestRuntime`, `TestRuntimeProvider` (re-exported from `@lando/sdk/test`), and `withService(<Tag>, <impl>)` helpers.
- FR-9: `bunfig.toml` declares the test directory pattern; `bun test` from repo root runs every test in every workspace.
- FR-10: `bun run clean` removes generated outputs across the workspace; CI/dev fast paths must still work after a clean.

## Non-Goals

- **No CI in this PRD.** CI is owned by [PRD-07](./prd-mvp-07-ci-and-binaries.md) and consumes the local gates this PRD ships (`bun run typecheck`, `bun run lint`, `bun test`, `bun run build`). The local gates here must be runnable from a clean checkout — that is what makes PRD-07's workflow possible.
- **No persistent caches**. `CacheService` is in-memory at MVP — but this PRD doesn't own the implementation, PRD-03 does.
- **No library-mode `makeLandoRuntime`**. Library mode throws `NotImplemented` at MVP; Alpha 1 makes it real for `bootstrap: "app"`.
- **No `tooling` bootstrap level work**. Skeleton-only — PRD-03 wires services, but the tooling-specific cache-only app-plan path is Alpha 3.
- **No AOT bootstrap-layer codegen**. That's `spec/15-binary-build-and-release.md` §17.2, Alpha 3.
- **No asset embedding** (recipes, schemas, OCLIF manifest). Runtime FS reads acceptable at MVP. Alpha 3 does the embedding.
- **No signal handlers** installed by `makeLandoRuntime`. The `installSignalHandlers` option exists in the schema; the CLI shell installs them itself in PRD-06's command implementations.
- **No Mutagen / file-sync infrastructure**. Alpha 3.
- **No Windows or macOS build path**. Linux x64 only.

## Technical Considerations

- The fast-path branch is sensitive to *import order*: any `import` of `@oclif/core` at module top-level prevents <50ms exit. Use lazy `await import()` inside the OCLIF dispatcher only.
- `bun build --compile` cannot dynamically import bundled plugins (per [`AGENTS.md`](../../AGENTS.md)). All bundled plugin imports must go through `core/src/plugins/bundled.ts`, which is statically analyzable.
- `LandoRuntimeLive` composition uses `Layer.merge` and `Layer.provide` per `spec/03-architecture.md`; intermediate layer composition outside `core/src/runtime/layer.ts` is forbidden in core.
- Stale OCLIF/Node CI workflows in `.github/workflows/` (per `AGENTS.md`) must be left alone or updated separately; this PRD does not depend on or modify them.
- The `engines.bun >=1.3.0` floor in `package.json` stays at MVP (the floor itself is an Beta 1 open decision per `spec/14`).

## Success Metrics

- `bun run typecheck && bun run lint && bun test && bun run build` is a single green flow on a clean Linux x64 checkout.
- Pre-OCLIF fast path cold-start under 50ms on a baseline dev machine (measured, not enforced).
- `BUNDLED_PLUGINS` round-trips through `scripts/build-bundled-plugins.ts` with zero hand-edits.
- Zero runtime FS reads of `*.tsbuildinfo`, `node_modules`, or generated codegen outputs (verified by US-010's instrumentation).

## Open Questions

- Does the OCLIF init hook need to handle `--bootstrap=<level>` overrides at MVP for debugging? Default: no — `static bootstrap` on the class is the only source.
- The `none`-level fast path for `version` is at MVP; what about `--help`? Default: `--help` goes through OCLIF — it needs the command list, which needs at least a partial CommandRegistry. Document as an Alpha 1 optimization.
- Should `provideTestRuntime` accept a `setup` Effect (for fixture setup) or rely on Bun's `beforeEach`? Default: rely on Bun's hooks; the helper is a Layer factory, nothing more.
