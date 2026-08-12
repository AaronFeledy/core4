# Repository Instructions

Keep this file compact: add only repo-specific facts an agent would likely miss. Put package-specific depth in `core/AGENTS.md` or `sdk/AGENTS.md` instead of expanding this root file.

## Source of Truth

- Lando v4 is a pre-release Bun monorepo. Workspace packages: `@lando/core` (CLI + library API + wiring), `@lando/sdk` (public contracts), `@lando/engine` (orchestration runtime), `@lando/container-runtime`, and the private primitive packages `@lando/paths`, `@lando/state-store`, `@lando/landofile`, `@lando/redaction`, `@lando/http-client`, `@lando/managed-file`, plus bundled plugins under `plugins/*`.
- Lando v4 has not shipped yet. Conform code to the intended design; do not preserve unreleased behavior for its own sake.
- The specification tree is authored planning material, not a shipped part of this repository, and may be deleted at any time. Only files inside it may cite or read it; every other file must state the durable detail itself. Enforced by the `spec-reference` rule in `check:boundaries`.
- Gut-and-replace is allowed before first ship. Do not add compatibility shims, legacy adapters, or dual paths unless a persisted artifact requires them.
- Read nested instructions before editing package code: `core/AGENTS.md` for CLI/runtime details and `sdk/AGENTS.md` for SDK contract rules.

## Core Code Tenets

- Keep business logic in pure Effect; filesystem, process, network, and terminal side effects belong behind services, not command bodies.
- Public contracts come from Effect Schema with inferred TypeScript types; do not maintain parallel hand-written public types.
- Core failures are `Schema.TaggedError` values with machine `_tag` and human remediation, not thrown generic exceptions.
- Acquire handles, locks, files, ports, networks, and subprocesses in `Scope` so cancellation cleans them up.
- Validate provider capabilities before planning, and plan before provider action; do not let providers discover unsupported intent at execution time.
- Prefer interfaces/plugins over config flags when implementations can differ; flags should tune one implementation, not choose architecture.
- Use Bun primitives first. Node compatibility APIs need a narrow adapter; use `ProcessRunner` for argv-precise spawn and `ShellRunner` for shell-shaped pipelines.
- User-facing surfaces must be agent-drivable: structured output, tagged failures, remediation, and preserved context across boundaries beat prose scraping.

## Commands

- Use Bun only: `bun install`, `bun run ...`, `bun test`. Do not introduce Node/npm/yarn/pnpm workflows.
- Standard gate after code changes is `bun run typecheck` plus `bun test`; root `tsc -b` does not typecheck `sdk/test/`.
- Also run `bun run lint` and any touched boundary/codegen/guide gate: `check:boundaries`, `check:guide-coverage`, `check:guide-drift`, `check:public-transcripts`, `check:telemetry-inventory`, or `lint:guides`. Debug one boundary rule with `bun run scripts/check-boundaries.ts <rule-id>`.
- Focused tests run by path, e.g. `bun test core/test/unit/bootstrap.test.ts`. Single-package scripts use Bun filters, e.g. `bun run --filter='@lando/core' typecheck`.
- That path is a filter, not a path: a stale or misspelled one emits a `did not match any test files` diagnostic and exits nonzero. Scripted spot-check loops must require both command success and a positive test count; never infer a pass only from the absence of failures.
- `bun run test:unit` skips `*.integration.test.ts`; provider/live integration requires explicit env such as `LANDO_TEST_PODMAN_SOCKET` and is intentionally serial.
- `NIGHTLY_TIER_TESTS` in `scripts/test-shards.ts` (the CI-workflow codegen suite and the Linux acceptance suite) is excluded from PR shards, so drift those files guard can reach `main` without a red PR. Run them by path whenever you touch their generator.
- After adding a new `plugins/*` workspace package, run `bun install` so workspace imports resolve from the repo root.

## Generated Files

- Do not hand-edit generated CI workflows, pin manifests, or the vendored Compose spec JSON. Edit the generator, run the matching `bun run codegen:*`. The Compose vendor generator writes checksum-pinned upstream bytes verbatim and must not format that file.
- **Pins vs derived (architecture-simplicity):** pin manifests (runtime-bundle, mutagen, compose vendor) and human-reviewed CI workflows stay committed. Pure build products (`dist/schemas/**`, `dist/command-schemas/**`, bake-time generated TS tables, command registry embed manifest, generated schema docs) are **derived** — produce them with codegen; they are not required as git SoT once US-510+ lands. Model: treat them like guide transcripts, which are regenerated every test run, gitignored, and never committed.
- `core/dist/schemas/**` and `core/dist/command-schemas/**` are ignored derived package mirrors produced byte-identically by schema snapshot codegen.
- `bun run codegen` runs generators in dependency order (see `scripts/codegen-catalog.ts`, the machine-readable ordered catalog; each entry carries exactly one ownership value (`committed-pin`, `committed-workflow`, or `derived`); `scripts/codegen.ts` is the runner).
- **Pure-drift `codegen:check` gate (architecture-simplicity US-505):** `codegen:check` runs the full codegen catalog and then `check:codegen-drift`, which fails on drift for the generated paths named by `CATALOG_OUTPUT_PATHS` in `scripts/check-codegen-drift.ts`. Its pathspec-scoped `git status --porcelain=v1 --untracked-files=all` catches tracked and newly untracked outputs without false-failing on unrelated dirty files elsewhere in the working tree. Gitignored derived trees stay outside that git-status half; they're covered instead by their existing generator/consumer validation. Deprecation checks stay in `lint`, while `typecheck` remains a separate gate. Use `bun run codegen` alone when you just want to iterate. Semantic gates stay separate: `check:guide-coverage`, `check:schema-compatibility`, `check:public-transcripts`, and `check:boundaries`.

| Gate | Class |
| --- | --- |
| `codegen:check` | pure drift |
| `check:guide-coverage` | semantic |
| `check:schema-compatibility` | semantic |
| `check:public-transcripts` | semantic |
| `check:boundaries` | semantic |

- Codegen scripts are expected to finish with `biome check --write` on emitted files; do not replace that with formatting-only steps.
- Route generated-file formatting through `scripts/_codegen-output.ts`; it explicitly disables Biome's VCS-ignore handling so gitignored derived outputs are still processed.
- Clean checkout bootstrap (target): `git clone && bun install && bun run codegen` before typecheck/test.

## Architecture Boundaries

- `@lando/sdk` is the public contract surface. Additive exports and schema changes must follow `sdk/AGENTS.md`, update `sdk/API_COMPATIBILITY.md` where required, and refresh the schema artifact set with `bun run codegen:schema-snapshot`.
- Each plugin-abstraction contract suite from `@lando/sdk/test` must stay listed in `core/test/contract/plugin-abstraction-coverage.test.ts` and exercised by its documented core built-in invocation unless the abstraction's pluggability-catalog entry documents that no built-in ships (e.g. `InitSource`, `ServiceFeature`, `AppFeature`, and `ConfigTranslator` are plugin-only or have no bundled default).
- `@lando/core` owns the CLI, library API, generated bootstrap layers, and bundled-plugin wiring. CLI/runtime quirks live in `core/AGENTS.md`.
- `@lando/engine` is the orchestration runtime: planner, operations, lifecycle, app/provider/subsystem services. It is not a grab-bag; cohesive self-contained concerns must be extracted to primitive packages (as `@lando/paths`, `@lando/state-store`, `@lando/landofile`, `@lando/redaction`, `@lando/http-client`, and `@lando/managed-file` were), and each extraction pays the scanner-retirement ratchet.
- `@lando/redaction` owns the canonical `RedactionService`/standalone redactor; `@lando/http-client` owns HTTP egress (`HttpClientLive`, network trust, downloader) and is the only package allowed to call global `fetch`; `@lando/managed-file` owns `ManagedFileService` Live, ownership markers, codecs, and overwrite decisions.
- Plugins may not depend on `@lando/core`; core imports plugin packages only via the generated composition root (`core/src/plugins/generated/**`), enforced by the `package-dag` rule in `check:boundaries`.
- RemoteSource/Dataset contract freeze: keep the `Dataset` x `RemoteSource` split contract-only for Beta 1; it never syncs application code, and implementation belongs to the 4.1 feature wave.
- **Single native CLI dispatcher** (architecture-simplicity): source and compiled `$bunfs` entries share one native command registry/dispatcher (`core/src/cli/run.ts`). Do not add a second OCLIF shipping path. The CLI surface is split three ways by role: `core/src/cli/commands/` is operation invocation plus render helpers, `core/src/cli/command-specs/` is the declarative CLI surface (`LandoCommandSpec`, flags/args/aliases, `*OptionsFromInput` parsers), and `core/src/cli/spec/` is the spec machinery (base class, spec type and validation, pre-command boundary, flag metadata primitives, bootstrap hooks). Prefer registry completeness + machine-output + relocated-binary smoke over dual-path parity tests. See `core/AGENTS.md`.
- The compiled binary target is `core/bin/lando.ts`, not `core/src/cli/index.ts`. Compiled-mode code must avoid top-level `await` and must not rely on `import.meta.url` for package/install metadata.
- Cold-start files must not statically import Effect, OCLIF, `@lando/sdk`, renderers, or plugins; startup regressions are release-blocking performance bugs.
- Command output goes through the `Renderer` service. Direct `console.*` or `process.std*.write` under the shared shipped-runtime tier (`core/src/**`, `engine/src/**`, `http-client/src/**`, `landofile/src/**`, `managed-file/src/**`, `paths/src/**`, `redaction/src/**`, `state-store/src/**`, and `plugins/**`) fails the renderer-boundary gate except documented fast-path carve-outs.
- In Effect layers, `Effect.serviceOption(X)` sees services provided to that sub-layer, not sibling layers in `Layer.mergeAll`; provide dependencies directly to the layer that needs them.
- Use the Effect-free paths primitive in `@lando/paths` (`paths/src/paths.ts`; re-exported through the semver-stable `@lando/core/paths` subpath via the `core/src/config/paths.ts` shim) for Lando roots and derived paths; do not re-spell `$HOME`, XDG, `%APPDATA%`, or platform separators. Hand-rolled `join(<userDataRoot>, "plugins"|"bin")` / `join(<userCacheRoot>, "scratch")` is blocked by package-dag/paths rules; the residual paths rule scans the shared shipped-runtime tier (`core/src/**`, `engine/src/**`, `http-client/src/**`, `landofile/src/**`, `managed-file/src/**`, `redaction/src/**`, `state-store/src/**`, and `plugins/**`) with no carve-outs, excluding only the owning `paths/src/**` implementation. Route consumers through `makeLandoPaths` (pure) or `PathsService` (Effect). A genuinely host-bound path that must ignore a faked `process.platform` (e.g. mutagen install dirs) should pin `makeLandoPaths({ platform: sep === "\\" ? "win32" : "linux" })` from `node:path.sep`, not read `process.platform`.
- Durable atomic, versioned, lockable state belongs in the private `@lando/state-store` package; plugins use `LandoPluginContext.stateStore`; host/tests override `StateStore` or use `TestStateStore`. The `package-dag` rule owns package direction, while the residual `state-store` rule forbids hand-rolled write-temp+rename+lockfile+version-envelope combinations in core and plugins.
- Host/provider-shaped retry/backoff/timeout-to-verdict probing (healthcheck, scanner, doctor, downloader, setup readiness) must build on `@lando/sdk/probe`'s `runProbe`; net-new hand-rolled `Effect.retry`/`Effect.repeat`/`Effect.schedule`/`Schedule.*` loops across the shared shipped-runtime tier (`core/src/**`, `engine/src/**`, `http-client/src/**`, `landofile/src/**`, `managed-file/src/**`, `paths/src/**`, `redaction/src/**`, `state-store/src/**`, and `plugins/**`) are blocked by the `probe` rule in `check:boundaries` with no allowlist. Consumers redact `ProbeResult.lastError` through `RedactionService` before it reaches an event, transcript, or readiness summary.
- User-app resolution should go through `loadUserLandofile(...)` from `engine/src/landofile/app-resolution.ts`; core CLI modules may use the CLI-only re-export at `core/src/cli/app-resolution.ts`. Do not call raw `LandofileService.discover`.
- **Package seams first, AST second:** when a boundary is a private workspace package, the `package-dag` rule is primary. Propose a package seam before adding a scanner. **Scanner-retirement ratchet:** every new private workspace package seam must delete or shrink at least one boundary rule; every new boundary-rule registration needs a seam-impossibility justification in `scripts/boundary/registry.ts` and a matching `scripts/boundary/README.md` row. Net rule count may grow only with that recorded argument. `bun run check:boundaries` runs every registered rule in one pass; use `bun run scripts/check-boundaries.ts <rule-id>` for focused debugging.

## Platform and Runtime Gotchas

- CI/release platform id `windows-x64` is different from runtime host key `win32-x64`; keep both names in their existing domains.
- The Windows Lando-owned Podman machine exposes its API at `\\.\pipe\podman-lando`; use HTTP over the named-pipe socket transport, not `curl --unix-socket`, and do not probe the Linux managed-service socket under `runtime/run/podman.sock` on win32.
- The committed `@lando/provider-lando` runtime-bundle manifest points at real published assets. To test a local unpublished bundle, build it locally and point `LANDO_RUNTIME_BUNDLE_MANIFEST` at it; verification is never disabled.
- Managed Podman's `--config <dir>` does not load `<dir>/containers.conf`; the service launcher must also set `CONTAINERS_CONF=<dir>/containers.conf` so bundled helper paths are honored.
- Podman 6 volume-prune safety requires one ownership-complete selector per `label` value because values are ORed; keep named-volume intent in the top-level `all=true` query parameter, not inside the encoded `filters` map, or it broadens deletion.
- OpenTUI prompt support belongs behind the renderer plugin and dynamic import boundary described in `core/AGENTS.md`; never add `@opentui/core` to `@lando/core` or import it statically. Production code loads it only via a Bun-traceable literal `import("@opentui/core")`, lazy and TTY/default-renderer-only; a constructed or aliased specifier (e.g. string concatenation) is not a substitute and is treated as a boundary violation.

## Guides and Docs-as-Tests

- Before writing or editing docs, guides, recipe READMEs, or other user-facing prose, load the `lando-write-docs` skill (`.agents/skills/lando-write-docs/SKILL.md`). It owns voice, page shape, and prose-first executable-guide rules.
- Executable guides are prose-first MDX: Markdown is the reader surface; `<Run>`/`<Verify>` wrap real harness execution only. No documentation-only `<Variable>` scenarios.
- Use `bun run dev:guides docs/guides/<path>.mdx --once` for a focused guide pass (require success and a positive test count). Full sequence: `docs/ci-runbook.md`.
- If a guide, recipe README, or guide-owned CLI surface changes, run `bun run lint:guides` and any relevant coverage/transcript/drift gates.
- `recipes/<id>/README.mdx` feeds both guide-scenario generation and committed scaffold README generation, so it must remain executable-guide-valid, not just readable prose.

## Working Tree Discipline

- Generated outputs and `dist/`/`.tsbuildinfo` can appear after typecheck/build/codegen; clean with `bun run clean` when needed.
- Do not commit or stage unrelated generated drift. If a generator change is intentional, include the generator and its emitted outputs in the same change.
