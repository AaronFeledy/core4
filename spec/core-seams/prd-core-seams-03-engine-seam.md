# PRD: SEAMS-03 — Engine seam

## Introduction

Extract the runtime brain into a private `@lando/engine` workspace package, leaving `@lando/core` as the shell: CLI, MCP surface, generated composition root, public entry points, and testing API. This is the load-bearing PRD of the wave. Today the brain and the shell share one package, and the dependency arrows have inverted where nothing stops them: the public library API calls CLI command implementations (`core/src/app/operations.ts` → `core/src/cli/commands/{destroy,exec,app-config-lint,...}.ts`), so business logic lives in command bodies — the exact thing the core tenets forbid. After this PRD, the engine package cannot import the shell because the workspace DAG makes that edge unrepresentable, CLI commands are thin adapters over engine operations, and the planner's import surface is bounded by a package boundary instead of habit.

## Source References

- `spec/03-architecture.md` §3.1 (four layers), §3.2 (bootstrap levels), §3.3 (source layout), §3.4 (service catalog)
- `spec/02-toolchain.md` §2.1 (cold-start budgets), §2.4 (top-level module work), §2.7 (entry points)
- `spec/09-embedding.md` §16.2–§16.3 (public API surface, `makeLandoRuntime`)
- `spec/15-binary-build-and-release.md` §17.2 (bootstrap-layers and composition-root codegen)
- `spec/core-seams/prd-core-seams-02-landofile-seam.md` (landofile package the engine consumes)

## Goals

- `@lando/engine` owns the planner, core services, subsystems, lifecycle, app operations, and the supporting runtime service modules, behind the workspace DAG.
- CLI command bodies contain argument decoding, renderer wiring, and one engine call — no business logic.
- The generated composition root and bootstrap layers stay core-owned and are the only place engine, plugins, and shell meet.
- Cold-start and hot-path budgets hold; the extraction adds no eager imports.

## User Stories

### US-540: Scaffold @lando/engine workspace package

**Description:** As a maintainer, a private `@lando/engine` package exists, wired into the workspace, tsconfig references, and the US-536 edge table.

**Acceptance Criteria:**

- [ ] Package exists with build/typecheck/test scripts matching sibling seam packages; root workspace list and tsconfig references updated; `bun install` run.
- [ ] Declared edges: `@lando/engine` → {`@lando/sdk`, `@lando/paths`, `@lando/state-store`, `@lando/container-runtime`, `@lando/landofile`} only; plugins may not import engine; engine may not import core or plugins.
- [ ] Package name recorded in §2.7's private-seam allowance (US-535 text) matches the shipped name.
- [ ] Tests pass; typecheck passes; lint passes

### US-541: Hoist app-lifecycle logic out of CLI command bodies

**Description:** As a maintainer, the start/stop/restart/rebuild/destroy/exec/logs/info/config operations hoist out of CLI command bodies into core-internal engine-staging modules that `core/src/app/**` and the CLI both call; US-542 relocates the staging modules into `@lando/engine` unchanged.

**Acceptance Criteria:**

- [ ] Each operation currently implemented inside `core/src/cli/commands/*.ts` and consumed by `core/src/app/operations.ts` moves to a core-internal engine-staging module (e.g. `core/src/operations/**`) with an Effect signature (typed error channel, `Scope`-owned resources, no Renderer/InteractionService coupling beyond event publication). Staging modules MUST NOT import `core/src/cli/**` — hoisting into the engine package directly is not possible yet because the planner and subsystems move only in US-542, and an engine→core import is unrepresentable in the DAG.
- [ ] `core/src/app/operations.ts` and `core/src/app/handle.ts` (including the `LogsAppLine` type home) consume staging modules only; zero imports of `core/src/cli/**` remain anywhere under `core/src/app/**` or `core/src/services/**`; the US-539 burn-down allowlist is emptied and deleted.
- [ ] The corresponding CLI command files reduce to: decode input → resolve app via the Landofile seam → invoke engine operation → render; per-command diffstat demonstrates logic moved rather than duplicated.
- [ ] Library API contract suite passes unchanged; machine-output (`--format json`) transcripts for the affected commands are byte-identical or the diff is reviewed and recorded in progress notes.
- [ ] Tests pass; typecheck passes; lint passes

### US-542: Move runtime service modules into @lando/engine

**Description:** As a maintainer, the runtime-brain directories move from `core/src/**` into the engine package — `services/`, `subsystems/`, `lifecycle/`, `app/`, the US-541 staging modules, `cache/`, `managed-file/`, `data-mover/`, `scratch-app/`, `global-app/`, `downloader/`, `http-client/`, `telemetry/`, `deprecation/`, `redaction/`, `tunnel/`, `providers/`, the non-generated parts of `runtime/` and `plugins/`, and whatever small runtime-tier modules the closure rule pulls in (`logging/`, `platform/`, `secrets/`, `errors/`, `schema/`, `utils/`, `state/`, non-shim `config/`) — together with the codegen retarget, as one change.

**Acceptance Criteria:**

- [ ] **Import-closure rule:** the moved set is closed over its core-internal static imports — anything a moved module imports either moves with it, is already a seam package, or is inverted to an sdk-published tag/injected input. The engine package typechecks with zero `@lando/core` imports.
- [ ] Confirmed generated-import inversions land with the move: `services/bundled-global-service-loader.ts`, `subsystems/proxy/registry.ts`, `lifecycle/subscribers.ts`, `cache/command-index-writer.ts`, and `providers/registry.ts` stop importing `core/src/{plugins,runtime}/generated/**` and receive those tables as injected inputs wired by the core-owned composition root.
- [ ] `core/src/interaction/**` stays in core: it imports recipe prompt machinery (`core/src/recipes/**`, which stays) and is the input peer of the renderer/shell. Engine modules reach `InteractionService` only through its sdk-published tag, never by static import of the implementation.
- [ ] `codegen:bootstrap-layers` and `codegen:bundled-plugins` are retargeted **in the same change** so the generated bootstrap layers and composition root import `@lando/engine`; `codegen:check` is drift-clean at story close. (Splitting the move and the retarget into separate stories would leave an intermediate state that cannot typecheck.)
- [ ] Core retains only shell code (`cli/`, `mcp/`, `interaction/`, `recipes/`, `docs/`, `testing/`, `bin`, generated composition root and bootstrap layers, §2.7 entry-point shims).
- [ ] Service tags that plugins or embedders consume remain sdk-published or core-re-exported exactly as before; no public import specifier changes.
- [ ] Moved tests run under the engine package with a positive test count; `bun test` totals match pre-move minus relocations (no silently dropped suites).
- [ ] `check:package-dag`, `check:import-cycle`, and the full boundary suite pass with the new layout (scanner tier globs updated to include `engine/src/**` and `landofile/src/**` wherever they scan `core/src/**` today).
- [ ] Tests pass; typecheck passes; lint passes

### US-543: Composition seam and performance budgets hold

**Description:** As a maintainer, after the US-542 move the core-owned generated composition root and bootstrap layers are the only meeting point of engine, plugins, and shell, and the cold-start/hot-path budgets hold.

**Acceptance Criteria:**

- [ ] The generated composition root (`core/src/plugins/generated/**`) and generated bootstrap layers (`core/src/runtime/generated/layers/**`) are the only modules importing both `@lando/engine` and plugin packages; engine source contains zero imports of generated composition modules — asserted by a focused test or a thin boundary check, not by inspection.
- [ ] Cold-start files still avoid static Effect/renderer/plugin imports; `bench:opentui-startup` and cold-start checks show no regression against `scripts/bench-baselines.json`.
- [ ] `bench:tooling-hot-path` holds its budget.
- [ ] Tests pass; typecheck passes; lint passes

### US-544: Public surface holds — entry points, embedding, compiled binary

**Description:** As an embedder and a CLI user, nothing observable changes: `@lando/core` entry points re-export engine surfaces, the compiled binary builds, and relocated-binary smoke passes.

**Acceptance Criteria:**

- [ ] Every §2.7 entry point resolves to the same exported names; API report/schema snapshot gates pass without contract diffs.
- [ ] `makeLandoRuntime`/`openLandoRuntime`/`resolveApp` behave identically; library API and plugin-abstraction contract suites pass.
- [ ] `bun build --compile` against `core/bin/lando.ts` succeeds; relocated-binary smoke (success path, tagged failure, root help) passes; no top-level `await` or `import.meta.url` reliance introduced.
- [ ] The publish path (`scripts/prepare-npm-dev-packages.ts` + release workflow) handles the new workspace deps exactly like `@lando/paths`/`@lando/state-store` (version and `workspace:*` rewrite or bundling), so the library install form of `@lando/core` resolves.
- [ ] Tests pass; typecheck passes; lint passes

## Functional Requirements

- Behavior-preserving move: no command semantics, event sequences, or cache formats change.
- Engine modules MUST NOT read `process.argv`, own TTY concerns, or import renderer implementations; output remains event/Renderer-mediated.
- The engine package is testable with test layers only (TestStateStore, in-memory ports), without a compiled shell.

## Non-Goals

- Splitting the public `@lando/core` publish surface (§2.7 rejection stands).
- Extracting `core/src/recipes/` or `core/src/mcp/` (deferred).
- Refactoring `core/src/cli/` internals beyond thinning command bodies (mega-router and generated manifest work is a follow-up wave).
- Renaming services, events, or cache keys.

## Technical Considerations

- Sequence US-541 before US-542 so logic hoists happen while files are still in place — move clean, then relocate; combined move+rewrite commits are hard to review even pre-ship.
- US-542 is deliberately the wave's largest single change: the directory move and the codegen retarget cannot be split without an intermediate state that fails typecheck, so they land together under one verification contract.
- `Effect.serviceOption` visibility inside merged layers (root AGENTS.md gotcha) means moved layers must keep receiving their dependencies directly; the bootstrap-layer generator's dependency tables are the source of truth to update, not the emitted files.
- Scanner-tier boundary rules (renderer, redaction, probe, paths, state-store) enumerate `core/src/**` today; US-542 updates their scanned-root lists in the same change as the move so coverage never lapses.
- `plugins/*` must keep resolving after the move: run `bun install` at the repo root and re-run `codegen` in dependency order.

## Success Metrics

- `core/src/cli/` share of core source drops materially once brain directories leave core (tracked in progress notes with before/after LOC).
- Zero import edges from engine → shell anywhere; the direction is unrepresentable in the DAG.
- Planner import surface is exactly the engine package's declared dependencies.

## Guide Coverage

**None — internal/infra PRD.** No end-user CLI behavior changes; existing guides keep passing as-is.

## Open Questions

- None blocking. (Package name `@lando/engine` is the default; if implementation surfaces a collision with provider "runtime bundle" terminology, record the rename in US-535's spec text in the same change.)
