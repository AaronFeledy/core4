# Repository Instructions

Keep this file compact: add only repo-specific facts an agent would likely miss. Put package-specific depth in `core/AGENTS.md` or `sdk/AGENTS.md` instead of expanding this root file.

## Source of Truth

- Lando v4 is a pre-release Bun monorepo for `@lando/core`, `@lando/sdk`, `@lando/container-runtime`, and bundled plugins under `plugins/*`.
- The spec in `spec/` is the compatibility contract. If code and spec conflict, conform to the spec; do not preserve unreleased behavior for its own sake.
- Gut-and-replace is allowed before first ship. Do not add compatibility shims, legacy adapters, or dual paths unless the spec or a persisted artifact requires them.
- Read nested instructions before editing package code: `core/AGENTS.md` for CLI/runtime details and `sdk/AGENTS.md` for SDK contract rules.

## Core Code Tenets

- Keep business logic in pure Effect; filesystem, process, network, and terminal side effects belong behind services, not command bodies (spec §1.2).
- Public contracts come from Effect Schema with inferred TypeScript types; do not maintain parallel hand-written public types (spec §1.2).
- Core failures are `Schema.TaggedError` values with machine `_tag` and human remediation, not thrown generic exceptions (spec §1.2).
- Acquire handles, locks, files, ports, networks, and subprocesses in `Scope` so cancellation cleans them up (spec §1.2).
- Validate provider capabilities before planning, and plan before provider action; do not let providers discover unsupported intent at execution time (spec §1.2).
- Prefer interfaces/plugins over config flags when implementations can differ; flags should tune one implementation, not choose architecture (spec §1.2).
- Use Bun primitives first. Node compatibility APIs need a narrow adapter; use `ProcessRunner` for argv-precise spawn and `ShellRunner` for shell-shaped pipelines (spec §1.1-§1.2).
- User-facing surfaces must be agent-drivable: structured output, tagged failures, remediation, and preserved context across boundaries beat prose scraping (spec §1.1-§1.2).

## Commands

- Use Bun only: `bun install`, `bun run ...`, `bun test`. Do not introduce Node/npm/yarn/pnpm workflows.
- Standard gate after code changes is `bun run typecheck` plus `bun test`; root `tsc -b` does not typecheck `sdk/test/`.
- Also run `bun run lint` and any touched boundary/codegen/guide gate: `check:renderer-boundary`, `check:managed-file-boundary`, `check:state-store-boundary`, `check:probe-boundary`, `check:redaction-boundary`, `check:telemetry-inventory`, `lint:guides`, `check:guide-coverage`, `check:public-transcripts`, or `check:guide-drift`.
- Focused tests run by path, e.g. `bun test core/test/unit/bootstrap.test.ts`. Single-package scripts use Bun filters, e.g. `bun run --filter='@lando/core' typecheck`.
- `bun run test:unit` skips `*.integration.test.ts`; provider/live integration requires explicit env such as `LANDO_TEST_PODMAN_SOCKET` and is intentionally serial.
- After adding a new `plugins/*` workspace package, run `bun install` so workspace imports resolve from the repo root.

## Generated Files

- Do not hand-edit generated CI workflows or generated runtime/plugin tables. Edit the generator, run the matching `bun run codegen:*`, and verify drift with `git diff --exit-code` on the generated paths.
- `bun run codegen` runs generators in dependency order: guide scenarios, recipe READMEs, bundled plugins, bundled recipes, bootstrap layers, schema snapshot, OCLIF manifest, and CI/nightly/release/provider workflows.
- Bootstrap layers under `core/src/runtime/generated/layers/`, bundled plugin/recipe tables, `.github/workflows/*.yml`, `core/src/cli/oclif/compiled-manifest.ts`, and schema artifacts are generator outputs.
- Codegen scripts are expected to finish with `biome check --write` on emitted files; do not replace that with formatting-only steps.

## Architecture Boundaries

- `@lando/sdk` is the public contract surface. Additive exports and schema changes must follow `sdk/AGENTS.md`, update `sdk/API_COMPATIBILITY.md` where required, and refresh schema snapshots with `bun run codegen:schema-snapshot`.
- Each §4.2 plugin-abstraction contract suite from `@lando/sdk/test` must stay listed in `core/test/contract/plugin-abstraction-coverage.test.ts` and exercised by its documented core built-in invocation unless §4.2 says no built-in ships.
- `@lando/core` owns runtime, planner, CLI, library API, generated bootstrap layers, and bundled-plugin wiring. CLI/runtime quirks live in `core/AGENTS.md`.
- RemoteSource/Dataset contract freeze: keep the `Dataset` x `RemoteSource` split contract-only for Beta 1; it never syncs application code, and implementation belongs to the 4.1 feature wave.
- Source CLI dispatch uses OCLIF; the compiled Bun `$bunfs` binary uses `runCompiledCli` in `core/src/cli/run.ts`. Keep behavior shared or updated in both paths and run parity tests when command routing changes.
- The compiled binary target is `core/bin/lando.ts`, not `core/src/cli/index.ts`. Compiled-mode code must avoid top-level `await` and must not rely on `import.meta.url` for package/install metadata.
- Cold-start files (`core/src/cli/index.ts`, `core/src/cli/oclif/pre-renderer.ts`) must not statically import Effect, OCLIF-heavy modules, `@lando/sdk`, renderers, or plugins; startup regressions are release-blocking performance bugs (spec §1.2).
- Command output goes through the `Renderer` service. Direct `console.*` or `process.std*.write` under `core/src/**` or `plugins/**` fails the renderer-boundary gate except documented fast-path carve-outs.
- In Effect layers, `Effect.serviceOption(X)` sees services provided to that sub-layer, not sibling layers in `Layer.mergeAll`; provide dependencies directly to the layer that needs them.
- Use the Effect-free paths primitive in `core/src/config/paths.ts` for Lando roots and derived paths; do not re-spell `$HOME`, XDG, `%APPDATA%`, or platform separators. Hand-rolled `join(<userDataRoot>, "plugins"|"bin")` / `join(<userCacheRoot>, "scratch")` is blocked by `check:paths-boundary`; route through `makeLandoPaths` (pure) or `PathsService` (Effect). A genuinely host-bound path that must ignore a faked `process.platform` (e.g. mutagen install dirs) should pin `makeLandoPaths({ platform: sep === "\\" ? "win32" : "linux" })` from `node:path.sep`, not read `process.platform`.
- Durable atomic, versioned, lockable state belongs in `StateStore` (`core/src/state/**`); plugins use `LandoPluginContext.stateStore`; host/tests override `StateStore` or use `TestStateStore`. Do not hand-roll write-temp+rename+lockfile+version envelopes; `check:state-store-boundary` enforces this.
- Host/provider-shaped retry/backoff/timeout-to-verdict probing (healthcheck, scanner, doctor, downloader, setup readiness) must build on `@lando/sdk/probe`'s `runProbe`; net-new hand-rolled `Effect.retry`/`Effect.repeat`/`Effect.schedule`/`Schedule.*` loops in `core/src/**` or `plugins/**` are blocked by `check:probe-boundary` (allowlist the advisory-lock loops in `core/src/state/lock.ts` and `core/src/state-store/json-bucket.ts`). Consumers redact `ProbeResult.lastError` through `RedactionService` before it reaches an event, transcript, or readiness summary.
- CLI commands resolving a user app should go through `loadUserLandofile(...)` from `core/src/cli/app-resolution.ts`, not raw `LandofileService.discover`.

## Platform and Runtime Gotchas

- CI/release platform id `windows-x64` is different from runtime host key `win32-x64`; keep both names in their existing domains.
- The default `@lando/provider-lando` runtime-bundle manifest is a placeholder. To exercise setup with real bytes, build a local bundle and point `LANDO_RUNTIME_BUNDLE_MANIFEST` at it; verification is never disabled.
- OpenTUI prompt support belongs behind the renderer plugin and dynamic import boundary described in `core/AGENTS.md`; never add `@opentui/core` to `@lando/core` or import it statically.

## Guides and Docs-as-Tests

- Executable guides are MDX sources that generate tests and public transcripts. Use `bun run dev:guides docs/guides/<path>.mdx --once` for a focused guide pass, or omit `--once` for the watch loop.
- If a guide, recipe README, or guide-owned CLI surface changes, run the relevant guide codegen/lint/drift gates; `docs/ci-runbook.md` mirrors the CI sequence.
- `recipes/<id>/README.mdx` feeds both guide-scenario generation and committed scaffold README generation, so it must remain executable-guide-valid, not just readable prose.

## Working Tree Discipline

- Generated outputs and `dist/`/`.tsbuildinfo` can appear after typecheck/build/codegen; clean with `bun run clean` when needed.
- Do not commit or stage unrelated generated drift. If a generator change is intentional, include the generator and its emitted outputs in the same change.
