# PRD: BETA1-11 — Library API stability & §17.9 acceptance

## Introduction

Beta 1 ends with the library API stable on the `next` channel and the §17.9 binary acceptance machinery green on the reference platform, linux-x64. This PRD depends on PRD-01 through PRD-10 because it verifies the whole product surface rather than one isolated subsystem.

The library API must be safe for embedding hosts, contract-tested from workspace and packed installs, and separated from OCLIF. The §17.9 acceptance set is **27 criteria** total (the `v4.0.0` release MUST list). Beta 1 is the last phase that adds feature surface, so the harness implements and runs **all 27 criteria** green on linux-x64 during Beta 1 — including external compiled-plugin loading (criteria 20–24) and the codegen/bundled-plugin/recipe gates (criteria 25–27). Only the all-platform acceptance pass is deferred to RC; RC and GA take bug fixes, not new feature surface.

Depends on: **BETA1-01 through BETA1-10**.

## Source References

- [`spec/09-embedding.md`](../09-embedding.md) §16 library and embedding API.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13 test layers, library API contract suite, and plugin SDK contract suite.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.9 binary-shipping acceptance criteria.
- [`spec/02-toolchain.md`](../02-toolchain.md) §2.7 package surface and entry-point catalog.
- [`spec/10-plugins.md`](../10-plugins.md) §9 plugin compatibility and manifest requirements.

## Goals

- Declare the Beta 1 stable `@lando/core` library entry points and keep internal OCLIF code out of stable imports.
- Make `@lando/core/testing` stable on `next` with deterministic test runtime coverage and JSDoc on every export.
- Contract-test library-mode defaults, `makeLandoRuntime`, CLI operations, and packed-install entry points.
- Enforce plugin SDK compatibility through `requires."@lando/core": "^4.0.0"`.
- Run the §17.9 acceptance harness green on linux-x64: implement all 27 criteria (1–19 runtime/release/update/setup, 20–24 external compiled-plugin loading, 25–27 codegen/bundled-plugin/recipe gates), with only the all-platform pass deferred to RC.

## User Stories

### US-272: `@lando/core/testing` stable on `next` + deterministic `TestRuntime`

**Description:** As an embedding host or plugin author, I can import `@lando/core/testing` from the `next` channel and get deterministic in-memory testing utilities with documented exports.

**Acceptance Criteria:**
- [ ] `@lando/core/testing` is declared stable on the `next` channel for Beta 1 while `@lando/core/docs/components` and `@lando/core/docs/redactions` remain unstable until GA.
- [ ] `TestRuntime` satisfies every default service tag, is deterministic, and does not touch filesystem or network outside explicit overrides.
- [ ] The provider contract suite runs against `TestRuntime` and proves the default fake provider behavior is stable.
- [ ] Every `@lando/core/testing` export has JSDoc and is covered by workspace and packed-install resolution tests.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-273: Full §16.2 library contract suite + `docs/redactions` export gap

**Description:** As a package consumer, I need every public library entry point to resolve, obey import boundaries, and match the §16.2 stability contract.

**Acceptance Criteria:**
- [ ] `core/test/library/entry-points-export.test.ts` verifies `@lando/core`, `@lando/core/services`, `@lando/core/schema`, `@lando/core/errors`, `@lando/core/events`, `@lando/core/cli`, `@lando/core/testing`, `@lando/core/docs/components`, and `@lando/core/docs/redactions`.
- [ ] `core/test/library/import-boundary.test.ts` proves the default entry is OCLIF-free and `@lando/core/oclif` is internal-only.
- [ ] `core/test/library/core-testing-export.test.ts` resolves `@lando/core/testing` from both workspace and packed install.
- [ ] `core/test/library/cli-operations-export.test.ts` and `core/test/library/make-runtime-app.test.ts` cover CLI operation exports and runtime creation.
- [ ] The known missing `@lando/core/docs/redactions` export is either added or ticketed with a failing contract test and explicit Beta 1 acceptance note.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-274: Library-mode defaults + scoped/idempotent `makeLandoRuntime`

**Description:** As an embedding host, I can create Lando runtimes repeatedly without unwanted process mutation and with library-mode defaults that are safe for host applications.

**Acceptance Criteria:**
- [ ] Library-mode defaults are `logger: silent`, `renderer: json`, discovery booleans default `false`, telemetry disabled unless the host explicitly opts in (matching PRD-06 US-240), and signal handlers off unless requested.
- [ ] `makeLandoRuntime` validates options through Effect Schema and returns one scoped Layer.
- [ ] Repeated calls to `makeLandoRuntime` are safe, do not share mutable global state accidentally, and tear down all resources when the scope closes.
- [ ] The runtime runs the same bootstrap sequence as CLI mode while avoiding global process mutation unless signal handlers are explicitly enabled.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-275: Plugin SDK contract test for `requires."@lando/core": "^4.0.0"`

**Description:** As a plugin author, I need the plugin compatibility contract to reject plugins that target the wrong core major version.

**Acceptance Criteria:**
- [ ] Plugin manifests must declare `requires."@lando/core": "^4.0.0"` for Beta 1 compatibility.
- [ ] The plugin SDK contract test accepts compatible manifests and rejects missing, incompatible, or overly broad core requirements with tagged remediation.
- [ ] Bundled plugin fixtures and generated schema snapshots are updated to match the compatibility requirement.
- [ ] Plugin authoring docs explain the requirement and show the field in scaffolded `package.json` output.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-276: §17.9 criteria 1-9 acceptance harness green on linux-x64

**Description:** As a release engineer, I can run the first half of the binary acceptance harness on linux-x64 and prove release, signing, supply-chain, and update behavior work on the reference platform.

**Acceptance Criteria:**
- [ ] Criterion 1 passes: clean checkout plus `bun run release` produces a signed, checksum-manifested local binary that launches and reports version.
- [ ] Criterion 2 passes or records gated timing evidence: full 1-13 pipeline stays under 30 minutes single-platform and 60 minutes full matrix in CI.
- [ ] Criteria 3-5 pass for linux-x64: binary signing policy, CycloneDX SBOM, SLSA v1.0 provenance, SHA256SUMS, and `cosign verify-blob` verification.
- [ ] Criteria 6-9 pass for linux-x64: signed update manifest verification, `lando update` snapshot replacement and re-exec, failed launch rollback to `.bak` with `UpdateLaunchProbeError`, and EACCES handling with `UpdatePermissionError` and no silent elevation.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-277: §17.9 criteria 10-14 acceptance harness green on linux-x64

**Description:** As a release engineer, I can verify installers, compiled import boundaries, Mutagen embedding policy, and setup file-sync behavior on linux-x64.

**Acceptance Criteria:**
- [ ] Criterion 10 passes: `install.sh` on a clean linux-x64 container installs to `<userDataRoot>/bin/lando`, verifies the embedded GPG trust root, runs `lando version`, and matches `lando shellenv` path output.
- [ ] Criterion 11 is represented in the harness and marked platform-gated for Windows until RC all-platform acceptance.
- [ ] Criterion 12 passes: the compiled binary import graph has no runtime filesystem reads of bundled plugins, recipes, OCLIF manifest, or built-in schema.
- [ ] Criterion 13 passes: the compiled binary contains the generated Mutagen Connect-RPC client and `mutagen-versions.json` but no Mutagen binary blob.
- [ ] Criterion 14 passes on linux-x64: `lando setup` on slow providers downloads Mutagen host and agents through proxy/CA stack, `--skip-file-sync` defers downloads, and native providers download nothing.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-278: §17.9 criteria 15-19 acceptance harness green on linux-x64

**Description:** As a release engineer, I can verify the final runtime, bytecode, AOT, performance, and level-none import-boundary criteria on linux-x64.

**Acceptance Criteria:**
- [ ] Criterion 15 passes: `app:start` on a slow provider with bind mount engages `FileSyncEngine`, and repeat starts reuse file-sync sessions.
- [ ] Criterion 16 passes: the compiled binary is built with `--bytecode`.
- [ ] Criterion 17 passes: AOT bootstrap layers live at `src/runtime/generated/layers/<level>.ts`, with no runtime `Layer.merge` or `Layer.provide` outside codegen paths.
- [ ] Criterion 18 passes or is nightly-gated with recorded linux-x64 evidence for e2e and perceived-performance p95 budgets.
- [ ] Criterion 19 passes: level-`none` invocations do not import `@oclif/core` or construct any `Context.Service`.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-279: §17.9 criteria 20–27 acceptance harness green on linux-x64

**Description:** As a release engineer, I can verify external compiled-plugin loading and the codegen, bundled-plugin-removal, and recipe-codegen gates on linux-x64, completing the full §17.9 acceptance set in the last feature-adding phase.

**Acceptance Criteria:**
- [ ] Criteria 20–24 pass on linux-x64: the compiled binary loads an external ESM plugin by absolute `file://` URL from a Lando-managed plugin store, loads an external TypeScript plugin where Bun supports the file type directly, resolves dependencies installed under an external plugin package root, rejects plugin contribution module paths that resolve outside the plugin package root, and marks a failed external plugin import unhealthy with a tagged `PluginLoadError` without preventing unrelated plugins from loading.
- [ ] Criterion 25 passes: `bun run codegen:check` succeeds on a clean checkout with no uncommitted changes.
- [ ] Criterion 26 passes: removing a bundled plugin from `core/build.config.ts` and rebuilding produces a binary that omits the plugin from `oclif.manifest.json` and `src/plugins/bundled.ts` with no code edits in `src/`.
- [ ] Criterion 27 passes: adding a canonical recipe under `recipes/<id>/` with a valid `recipe.yml` ships via `bun run codegen` alone and is reachable via `lando init --recipe <id>` in the next built binary.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

## Functional Requirements

- FR-1: Stable in-major entry points are `@lando/core`, `@lando/core/services`, `@lando/core/schema`, `@lando/core/errors`, `@lando/core/events`, and `@lando/core/cli`.
- FR-2: `@lando/core/testing`, `@lando/core/docs/components`, and `@lando/core/docs/redactions` publish on `next`/`dev`; only `@lando/core/testing` is declared stable at Beta 1.
- FR-3: `@lando/core/oclif` remains internal-only and must not be imported by the default entry point.
- FR-4: `@lando/core/cli` exports Effect-returning operations for every built-in command except explicitly omitted interactive or install surfaces; operations return typed results, not rendered text.
- FR-5: `@lando/core/cli` exposes `runTooling(...)` and config-translator operations without touching stdio or OCLIF.
- FR-6: `makeLandoRuntime` must be scoped, option-validated, idempotent, CLI-bootstrap-equivalent, and safe from global process mutation unless signal handlers are enabled.
- FR-7: The §17.9 acceptance set is 27 criteria. The Beta 1 harness MUST implement all 27 criteria — including external compiled-plugin loading (criteria 20–24) and the `codegen:check` / bundled-plugin-removal / recipe-codegen gates (criteria 25–27) — and run them green on linux-x64. Only the all-platform pass is deferred to RC; no §17.9 criterion is deferred to RC as new feature work.

## Non-Goals

- Declaring `@lando/core/docs/components` or `@lando/core/docs/redactions` stable before GA.
- Exposing `@lando/core/oclif` as a supported embedding API.
- Adding a Promise-based facade for the library API.
- Requiring all-platform §17.9 acceptance during Beta 1.
- Allowing library-mode operations to write rendered CLI text instead of typed results.

## Technical Considerations

- Current `core/package.json#exports` includes `.`, `./schema`, `./errors`, `./events`, `./services`, `./testing`, `./cli`, `./cli/operations`, and `./oclif`; `./docs/redactions` is the known gap from the spec.
- The library contract suite belongs under `core/test/library/` and should test both workspace imports and packed-install imports where applicable.
- CLI operation exports should reuse the same command logic as OCLIF and compiled dispatch while stopping before renderer formatting.
- Live signing, notarization, installer, and update tests must stay environment-gated when credentials or external services are missing.
- Acceptance criteria that are platform-specific should be represented in the harness at Beta 1 even when non-linux platforms are marked RC-gated.

## Success Metrics

- All stable library entry points import from workspace and packed installs without OCLIF leakage.
- Embedding hosts can create and close repeated `makeLandoRuntime` scopes without leaked resources or global process changes.
- Plugin SDK compatibility failures produce clear remediation before plugin execution.
- The §17.9 harness runs green on linux-x64 and records which criteria remain all-platform RC gates.

## Guide Coverage

Per [PRD-12 US-198](../alpha-3/prd-alpha-3-12-executable-guides.md) (`## Guide Coverage` convention) and [US-199](../alpha-3/prd-alpha-3-12-executable-guides.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-272 | Testing API and deterministic `TestRuntime` | `docs/guides/library/testing-runtime.mdx` | Required at story acceptance |
| US-273, US-274 | Library entry points and `makeLandoRuntime` | `docs/guides/library/embedding-runtime.mdx` | Required at story acceptance |
| US-275 | Plugin SDK compatibility declaration | `docs/guides/plugins/sdk-compatibility.mdx` | Required at story acceptance |
| US-276, US-277, US-278, US-279 | Linux-x64 §17.9 acceptance rehearsal | `docs/guides/release/linux-acceptance-rehearsal.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `core/package.json`
- `core/src/library/**`
- `core/src/cli/operations/**`
- `core/src/cli/commands/start.ts`
- `core/src/testing/**`
- `core/test/cli/start.scenario.test.ts`
- `core/test/cli/fast-path*.ts`
- `core/test/runtime/generated-bootstrap-layers.test.ts`
- `core/test/library/**`
- `core/test/plugins/**`
- `scripts/check-acceptance*`
- `scripts/release.ts`
- `scripts/install*`
- `sdk/src/**`

## Open Questions

- Should `@lando/core/docs/redactions` be added in Beta 1 or only ticketed? Default: add the export because §16 names it and the contract test should pass.
- Which interactive/install CLI surfaces are omitted from `@lando/core/cli` operations? Default: omit only surfaces that cannot return typed results without user prompts or external credentials.
- Should telemetry default-on apply in `TestRuntime`? Default: no, `TestRuntime` uses deterministic no-op telemetry unless explicitly overridden.
- How should linux-only acceptance results be labeled in release notes? Default: clearly label them as Beta 1 reference-platform acceptance, with RC owning all-platform acceptance.
