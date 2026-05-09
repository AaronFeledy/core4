# Lando v4 — Testing, Distribution, and Quality Gates

> **Part 13 of 17** · [Index](./README.md)
> **Read next:** [14 Appendices](./14-appendices.md)

This part defines the quality bar and the release pipeline. Tests run under `bun test`. `tsc --noEmit` is a merge gate. The provider contract suite is mandatory for every `RuntimeProvider` plugin. The default release artifact is the Bun-compiled single-binary, one per platform target, alongside the `@lando/core` library package whose `package.json#bin` entry doubles as the package-manager install path for users who already run Bun.

Covered here: the nine test layers (unit, Effect service, CLI, library API, provider contract, plugin SDK contract, scenario, recipe, end-to-end) with their Effect testing patterns, schema gates (round-trip encode/decode for every public schema), type gates (`tsc --noEmit` + `expectTypeOf` tests in `test/types/`), the PR merge requirements, the scenario / recipe / end-to-end conventions that replace the Lando 3 Leia format, distribution targets and bundled-plugin / bundled-recipe generation, the per-PR/nightly/weekly CI matrices, and the release flow with channels (`stable`, `next`, `dev`) and self-update.

---

## 13. Testing, Distribution, and Quality Gates

### 13.1 Test layers

| Layer | Tool | Purpose |
|---|---|---|
| Unit | `bun test` | Pure functions, schemas, expression resolver, merge, planners |
| Effect service | `bun test` + `Effect.TestServices` | Layers with test implementations |
| CLI | `@oclif/test` + `bun test` | Command parsing, flag/arg handling, exit codes |
| Library API | `bun test` + `@lando/core/testing` | Embedding-host surface (§16): `makeLandoRuntime`, public services, `@lando/core/cli` operations, lifecycle event publication |
| Provider contract | Shared contract suite (in `@lando/sdk/test`) | Any `RuntimeProvider` plugin must pass |
| Template engine contract | Shared contract suite (in `@lando/sdk/test`) | Any `TemplateEngine` plugin must pass: capability declaration matches behavior, `lando` engine round-trip parity for the §7.3.1 portable function set, `TemplateRenderContext` shape acceptance without mutation, purity (no shell/FS/network/process state mutation), `unsafe: false` engines reject any helper that performs side effects, render output is byte-stable across repeated calls with identical input |
| Host proxy contract | Shared contract suite (in `@lando/sdk/test`) | Any `HostProxyService` plugin must pass: token auth enforcement, URL scheme allowlist (including `file://` rejection), `runLando` allowlist enforcement against the `host-proxy-allowlist` cache, recursion guard via `LANDO_HOST_PROXY_DEPTH`, concurrency cap, `pre-host-proxy-call` / `post-host-proxy-call` event publication with redacted payloads, atomic socket creation with mode `0600`, scope finalization (socket unlink, in-flight cancellation) within 1s of `Effect.interrupt` |
| Plugin SDK contract | Type tests + runtime tests | Public API compatibility |
| Scenario | `bun test` + `@lando/core/testing` | End-to-end through the library API against `TestRuntimeProvider`; no real container runtime |
| Recipe | `bun test` against `recipes/` | Every canonical recipe scaffolds with default answers and produces a Landofile that passes schema validation; the resulting app starts under the end-to-end suite |
| Executable tutorials | `bun test` over `test/mdx/**` after `scripts/build-doc-tests.ts` (§19.7, §17.2) | Every authored MDX tutorial under `docs/src/content/docs/{tutorials,how-to}/**` and every `recipes/<id>/README.mdx` with a `<Tutorial>` root regenerates into one TypeScript test per variant (Cartesian product of `tabs:`/`axes:` declarations, §19.16), runs through its declared `layer` (`scenario` against `TestRuntimeProvider`, `e2e` against the real provider), and surfaces failures back to the source MDX (with the variant axis-value map prefixed) via the source-mapper reporter (§19.8); generated tests are gitignored, transcripts captured at `dist/transcripts/<id>[.<axis-value>...].json` are consumed by the docs build (§19.6) |
| Deprecation | `bun test` + `@lando/core/testing` | Per-surface tests that exercise every `DeprecationNotice` in the codebase: triggering the surface emits the `deprecation-used` event, the renderer warns once per `(kind, id)`, `lando doctor --deprecations` lists the entry, and the `removeIn` gate rejects stale notices (§18.7–§18.8) |
| Perf budget | `bun test` + `Bun.$` driving `dist/lando-${target}` with byte-resolution stdout/stderr capture | Asserts the §2.1 end-to-end and perceived-performance budgets, the §12.5 hot-path read budgets, and the §8.9.1 first-paint contract |
| End-to-end | `bun test` + `Bun.$` against the compiled binary | The released artifact run on a real OS against a real provider |

**Effect testing patterns:**

- Use `Layer.succeed(Service, mock)` for service mocks; never patch globals.
- Use `Effect.provide` to inject test layers per test.
- Use `TestClock` for time-dependent code.
- Use `TestRandom` for deterministic randomness.
- Use `Stream.fromIterable` to feed test data into stream-based services.

**Provider contract suite** (mandatory for every `RuntimeProvider` plugin):

- Capability reporting matches declared capabilities.
- `apply` is idempotent across repeated calls with the same plan.
- `destroy` removes everything `apply` created.
- `exec` against a missing service returns `ServiceNotFoundError`.
- `logs` produces a `Stream` that completes cleanly when the service stops.
- Mount, endpoint, storage, and route behavior matches the capability matrix.
- Errors are tagged and contain remediation.
- Cancellation propagates: an interrupted `apply` rolls back partial state.

**Template engine contract suite** (mandatory for every `TemplateEngine` plugin and for the built-in `lando` engine):

- The engine's declared `capabilities` (§7.3.2) match observed behavior. An engine with `wholeFile: true` accepts the canonical control-flow grammar; an engine with `partials: true` resolves `{{> name}}`-style partials when the site supplies them.
- The `lando` engine's renders for the §7.3.1 portable function set are byte-stable across repeated calls with identical input.
- A plugin engine that registers the §7.3.1 portable function set produces results that match the `lando` engine's for the same input/context.
- Every engine accepts the canonical `TemplateRenderContext` shape (§7.3.2) without engine-specific mutation; the engine's render output MUST NOT depend on context keys outside the declared shape.
- Purity: a render produces zero observable side effects — no filesystem reads (other than the template itself, already loaded), no network calls, no `process.env` mutation, no `process.cwd()` mutation, no global-state writes. The contract harness asserts this via `Effect.TestServices` with denied filesystem/network access.
- Unsafe engines: an engine with `capabilities.unsafe: true` MUST refuse to render when global config opt-in is absent and emits `TemplateEngineUnsafeRejectedError` (§7.3.2).
- Errors are tagged (`TemplateCompileError`, `TemplateRenderError`) and include the source location and remediation.
- Cancellation: an `Effect.interrupt` during render terminates promptly; finalizers reap any internal resources.

**Host proxy contract suite** (mandatory for every `HostProxyService` plugin and for the built-in default; lives in `@lando/sdk/test`):

- Token auth: a request without `Authorization: Bearer <token>` or with a mismatched token is answered HTTP 401 with an opaque body; no log/event payload includes the supplied token.
- URL scheme allowlist: every `openUrl` request is matched against the configured scheme allowlist; `file://`, `javascript:`, `data:`, and `vbscript:` are rejected with `HostProxyOpenUrlSchemeError` regardless of plugin configuration.
- `runLando` allowlist: requests for canonical ids absent from the `host-proxy-allowlist` cache (§12.1) are rejected with `HostProxyCommandNotAllowedError`. Lifecycle commands (`app:start`, `app:stop`, `app:rebuild`, `app:destroy`, `apps:poweroff`) MUST NOT appear in the allowlist; a contract test attempts to register them and asserts `HostProxyAllowlistConflictError`.
- Recursion guard: an inbound request with `LANDO_HOST_PROXY_DEPTH >= 3` is rejected with `HostProxyRecursionLimitError`; a successful dispatch passes the incremented value into the host re-entry env.
- Concurrency cap: the dispatcher answers HTTP 429 with `HostProxyBackpressureError` for requests beyond the configured `hostProxy.maxConcurrent` (default 16).
- Lifecycle events: every dispatch (including rejected ones) publishes `pre-host-proxy-call` and `post-host-proxy-call` with the redacted payload from §11.2; `${secret:…}` values resolved during the dispatch are redacted identically to `pre-shell-exec`.
- Socket discipline: socket creation is atomic (`O_CREAT | O_EXCL`), mode is set to `0600` before any client can connect, and a pre-existing path raises `HostProxySocketStaleError`.
- Cancellation: `Effect.interrupt` of the dispatcher fiber finalizes within 1s — listener closed, in-flight request fibers cancelled, socket file unlinked, in that order.
- `runLando` streaming: stdout/stderr arrive at the in-container shim as NDJSON frames in the order produced; the final `{ kind: "exit", code }` frame matches the host program's exit code.
- Capability gating: when `hostReachability` is `none`, the feature plans as a no-op and the test asserts no socket is bound and no token is generated.

**Library API contract suite** (mandatory; lives in `test/library/`):

- `makeLandoRuntime` returns a Layer satisfying every default service tag in §3.4.
- The default entry (`@lando/core`) does not pull `@oclif/core` into the import graph (import-boundary test).
- `@lando/core/cli` exports a function for every built-in command listed in §16.7's "exported as functions" set.
- `@lando/core/testing` ships a `TestRuntime` that satisfies the provider contract suite against `TestRuntimeProvider`.
- Lifecycle event sequence (§11.4) is identical between a CLI invocation and a programmatic `startApp` call against the same Landofile + plugin set.
- Plugin policy honors `discovery.{bundled,system,user,app}` flags independently, including the library-mode default of all-false.
- Multiple `makeLandoRuntime` instances in one process are isolated (no shared caches, no cross-runtime event leakage).
- A single `LandoRuntime` reused across N sequential operations performs the per-bootstrap work exactly once: bootstrap, plugin discovery, AOT layer instantiation, and cache loading happen on operation 1; operations 2..N each meet their respective §2.1 **hot-path** budget at p95. The library-mode reuse-perf test class lives under `test/perf/library-reuse/` and is part of the perf-budget suite (gated on Linux x64 per §13.4, advisory on macOS/Windows per-PR CI). The test class asserts the §16.3 "Runtime reuse for performance" contract for `runTooling`, `appInfo`, `appConfig.get`, and a representative `appStart` → `appStop` round-trip.
- Closing the host scope finalizes every runtime resource (provider connections, file watchers, log streams).
- Tagged errors crossing the runtime boundary include their full payload schema and remediation field.
- `runTooling(name, input)` executes the same compiled task graph through CLI and library paths, including deps, expressions, status/precondition behavior, and lifecycle events.

**Scenario suite** (lives in `test/scenarios/`):

- One TypeScript file per scenario; uses `bun test` with `@lando/core/testing`.
- Drives the program through the public library API (`makeLandoRuntime`, `runTooling`, `startApp`, programmatic `@lando/core/cli` operations).
- Backed by `TestRuntimeProvider` — no Docker, no Podman, no real network, no host filesystem mutation outside `os.tmpdir()`.
- Asserts on plan output, lifecycle event sequence (§11.4), expression resolution, error tagging and remediation, and `Scope` cleanup.
- Fixtures (Landofiles, source trees, plugin manifests) live in `test/scenarios/fixtures/<name>/` and are shared across scenarios.
- Cleanup is automatic via Effect `Scope` finalizers; tests do not call `lando destroy` and do not leave state on disk.
- Runs on every PR on every supported platform in the per-PR matrix (§13.6) and is expected to complete in seconds, not minutes.

**Recipe suite** (lives in `test/recipes/`):

- One TypeScript file per canonical recipe under `recipes/<id>/` plus a shared driver.
- For each recipe, the suite scaffolds with default answers into `os.tmpdir()`, asserts that `recipe.yml` validates against the published `RecipeManifest` schema, asserts that every prompt's `default` resolves, asserts that every file under `files:` renders without expression errors, and asserts that the produced `.lando.yml` validates against the published Landofile schema (§7.8).
- An additional pass exercises non-default branches: each `select` / `multiselect` / `confirm` is varied across its choice space (subject to a coverage cap) and the produced Landofile is re-validated.
- The suite does NOT start the resulting app; that is the end-to-end suite's responsibility. The recipe suite establishes that scaffolding is structurally correct and fast.
- Runs on every PR on every supported platform.

**Perf-budget suite** (lives in `test/perf/`):

- One TypeScript file per command class (level-`none`, `minimal`, `tooling` hot path, `app` cold start). Driven by `Bun.$` against the compiled binary at `dist/lando-${target}` (the artifact §13.5 produces).
- Each test runs the command 50× and asserts on p95 timing against the §2.1 end-to-end budget plus the §2.1 perceived-performance budget. Both are merge gates per §13.4.
- The suite measures three timings per invocation: process spawn → first byte to stdout/stderr (first-paint), process spawn → final byte (end-to-end), and (for tooling fast path) the §12.5 hot-path read budget extracted from the `meta:events:follow` trace.
- The cold variant drops OS file caches before each run on Linux (`sync && echo 3 > /proc/sys/vm/drop_caches`); macOS and Windows runners use platform equivalents where available, otherwise the cold variant is skipped on those runners with a CI annotation. The warm variant runs back-to-back without cache drops.
- The level-`none` test class additionally asserts that the binary's level-`none` invocations do not import `@oclif/core` or any module that constructs a `Context.Service`, by snapshotting `Bun.embeddedFiles` access patterns through a debug build flag (`LANDO_PERF_TRACE=1`) — the trace is asserted against an allowlist.
- The first-paint test class drives `lando start` against `TestRuntimeProvider` in a way that lets the test inject artificial latency at provider `apply` and asserts that the §8.9.1 banner, spinner, and skeleton-table rules fire within their budgets independent of that latency.
- Failures emit a structured report (per-percentile timings, regression delta vs. the channel baseline, top contributors from the embedded `LANDO_PERF_TRACE` log) so a regressing PR has actionable evidence rather than a single "too slow" message.
- The reference runner spec for §17.8 (4 vCPU / 16 GB Linux) is the canonical baseline; budgets are the same on all platforms, but only the Linux runner gates merge by default. macOS/Windows perf runs are advisory on per-PR CI and gating on the nightly matrix.

**End-to-end suite** (lives in `test/e2e/`):

- One TypeScript file per scenario; uses `bun test` with `Bun.$` (or an `Effect`-wrapped equivalent) shelling out to the compiled binary at `dist/lando-${target}` produced by §13.5.
- Each test acquires its own working directory under `os.tmpdir()`. Fixture sources are split by purpose:
  - Internal-only fixtures (edge cases, regressions, contrived names) live under `test/e2e/fixtures/<name>/`.
  - Recipe-driven scenarios scaffold from `recipes/<id>/` via `lando init --recipe <id> --no-interactive --answers …` so the e2e suite exercises the same scaffolding path users hit. The scaffolded directory is the test fixture; the recipe directory is never mutated.
- Each test registers an Effect `Scope` finalizer that runs `lando destroy -y`, `lando poweroff` (where appropriate), and `rm -rf` regardless of success, failure, timeout, or interrupt.
- Assertions are structured: parsed JSON output, full stdout/stderr captured into the failure message, exit codes, file system state, real network endpoints, and event traces consumed via `lando events --follow --format json`.
- The compiled-binary smoke suite includes external plugin-loader coverage: load an external ESM plugin by absolute `file://` URL, load an external TypeScript plugin, resolve plugin-local dependencies, reject module paths escaping the plugin root, and continue after an unrelated plugin load failure.
- Runs against a real provider — the Lando-managed runtime by default; the weekly provider matrix substitutes Docker Desktop, Docker Engine, Podman Desktop, Podman, Lima, and OrbStack.
- Includes an offline-after-build scenario: build/start an app with any Lando-managed remote dependencies while online, disable network access for Lando-controlled fetches, then verify `lando start`, `info`, `logs`, `stop`, `restart`, and a cached tooling command do not require network. App-level dependency commands are excluded unless the scenario intentionally asserts their behavior.
- Tests must tolerate first-run runtime download (`lando setup`); the cost is reported in the test setup phase and excluded from per-test timeouts.
- The Lando 3 `examples/` directory is **not** the home for v4 e2e fixtures. Internal regressions live under `test/e2e/fixtures/`; user-facing scenarios live as canonical recipes under `recipes/<id>/` and are tested through the scaffold flow. The `examples/` directory does not exist in the v4 layout. Authored user docs that include executable steps live as MDX tutorials under `docs/src/content/docs/{tutorials,how-to}/**/*.mdx` and `recipes/<id>/README.mdx`, processed by §19 ("Executable Tutorials") into the test/mdx layer above; doc snippets that appear in the rendered Starlight site are derived from the same MDX components (or, for whole-file fixtures, from `?raw` imports of the recipe templates), and the docs build fails when the source and the rendered site diverge.
- A smoke subset (tagged `@smoke`) runs on every PR on Linux x64 against the Lando-managed runtime; the full suite runs nightly on Linux x64/arm64 and macOS x64/arm64; Windows e2e runs on the weekly provider matrix.
- The e2e suite plus the executable-tutorials layer (§19) together replace the Lando 3 Leia (`@lando/leia`) approach. The v3 "markdown as executable spec" format is retired wholesale: bash-block parsing, `grep`-based assertions, and the `Start up tests` / `Verification commands` / `Destroy tests` heading contract no longer apply. The properties Leia provided — real binary, real provider, structured cleanup — are preserved by the e2e suite using TypeScript assertions and `Scope`-based cleanup; the "fixtures co-located with docs" property is preserved by the recipe scaffolds (canonical user-facing init artifacts and e2e source for stack-starter scenarios) and by executable tutorials (typed JSX components in MDX whose props carry structured assertions and whose codegen produces TypeScript tests, leaving prose free to be prose). v4 is a fresh rewrite, not a migration: there is no v3-to-v4 conversion path for Leia files.

### 13.2 Schema gates

Core ships and validates schemas for:

- Global config
- Landofile (supported Compose subset + Lando extensions + service config + tooling tasks/includes/defaults + events + proxy)
- Config expressions (AST, function registry metadata, resolution errors, redaction markers)
- Plugin manifest
- Config translator manifests and translation results
- Route, healthcheck, mount, storage, endpoint
- Provider extension declaration metadata
- Event payloads

Schemas are used for runtime validation, JSON Schema generation, doc generation, and contract tests. Every schema has a dedicated `bun test` file that exercises happy path, error path, and round-trip encode/decode.

Public schema gates also verify:

- Every public schema in the registry has an `identifier`, `title`, and `description` annotation.
- Public fields have descriptions unless the field is self-explanatory and documented by an enclosing schema.
- Examples attached to schemas decode successfully.
- JSON Schema generation succeeds for every public schema and produces stable output.
- Generated schema reference docs build without hand edits.

### 13.3 Type gates

`tsc --noEmit` must pass on every PR. Type-only tests live in `test/types/*.test-d.ts` and use `expectTypeOf` patterns to verify inferred types and `Effect` requirement narrowing.

### 13.4 Quality gates

A PR cannot merge unless:

- `bun test` passes.
- `tsc --noEmit` passes.
- `bunx biome check` passes (lint + format).
- The provider contract suite passes against the bundled providers.
- The library API contract suite passes.
- The scenario suite passes on every per-PR platform.
- The recipe suite passes on every per-PR platform; every canonical recipe under `recipes/` validates and produces a schema-valid Landofile with default answers.
- The executable-tutorials suite passes (§19.11): every authored MDX tutorial under `docs/src/content/docs/{tutorials,how-to}/**` and every `recipes/<id>/README.mdx` containing a `<Tutorial>` regenerates via `scripts/build-doc-tests.ts`, type-checks under `tsc --noEmit`, and runs through its declared `layer` on the per-PR matrix (scenario tutorials on every supported platform; e2e tutorials' `@smoke` subset on Linux x64). Failures map back to MDX coordinates via the source-mapper reporter (§19.8).
- The tutorial lint gate passes: `bun run lint:tutorials` (§19.10) walks every executable-tutorial MDX file and asserts frontmatter validity, Diátaxis bucket constraints, component prop conformance, the hidden:visible ratio cap, the `<Inline>` density cap, the display:execute divergence cap, mandatory `<Cleanup>` for `layer: "e2e"` tutorials, and the no-raw-shell-blocks rule that prevents the v3 Leia failure mode.
- The tutorial-component schema gate passes: every component prop schema in `@lando/sdk/docs/components`, plus `TutorialFrontmatter`, `MatcherSchema`, `Transcript`, and `TranscriptFrame`, round-trips through encode/decode (§13.2 schema gate scope).
- The transcript redaction gate passes: a fixture transcript exercising every redaction class in `@lando/sdk/docs/redactions` produces output identical to the canonical golden frame (§19.6).
- The MDX source-mapper reporter passes its fixture suite: a known-failing MDX tutorial → seeded generated test → asserted reporter output translates failure coordinates back to MDX line ranges with no off-by-one errors (§19.8).
- The end-to-end smoke subset passes on Linux x64.
- The deprecation suite passes: every `DeprecationNotice` in the codebase has a corresponding test that exercises the surface and asserts the `deprecation-used` event payload (§18.4); the renderer's per-`(kind, id)` dedup is verified across loops; `--no-deprecation-warnings` and `LANDO_DEPRECATION_WARNINGS=0` suppress renderer output without affecting recording, the event, or `lando doctor` (§18.6).
- The deprecation lint gate passes: `bun run lint:deprecations` (§18.8) walks the AST and asserts every TS export carrying a TSDoc `@deprecated` tag is wrapped with `markDeprecated(notice, impl)`; mismatches fail the build.
- The deprecation removal gate passes: `scripts/check-deprecations.ts` (§18.7) loads every notice, fails with `DeprecationStaleError` when a notice's `removeIn` matches the version being released and the surface is still present, and fails with `DeprecationOverdueError` when a notice's `removeIn` is in the past. The check also runs as part of `bun run codegen:check`.
- The perf-budget suite passes on Linux x64: every command class meets its §2.1 end-to-end budget at p95, every command at level ≥ `plugins` meets the §2.1 perceived-performance first-paint budgets, and the §12.5 hot-path read budgets hold. macOS and Windows perf runs are advisory on per-PR CI but block release on the nightly matrix.
- Level-`none` commands (§3.2) do not import `@oclif/core` or construct any `Context.Service`, verified by the `LANDO_PERF_TRACE` allowlist snapshot in the perf-budget suite.
- Top-level module work in any module reachable from `bin/lando.ts` stays under the §2.4 budget; this is asserted as part of the level-`none` perf test class.
- New CLI-surface or library-surface behavior has at least one test in `test/scenarios/`; new CLI-surface behavior additionally has at least one test in `test/e2e/` (smoke-tagged when fast enough, full-suite otherwise).
- New canonical recipes added to `recipes/` ship with a passing recipe-suite test and an e2e smoke entry.
- New schemas have round-trip tests and required annotations.
- New config translators have detect/translate tests, preview output tests, and write-path tests proving generated fragments validate before they are persisted.
- New app-dependency resolution behavior has an offline-after-build test proving routine local-dev commands use local state and fail clearly when required local state is missing.
- Generated JSON Schema output is up to date.
- Command registry docs, event registry docs, service registry docs, API reports, recipe action docs, and acceptance coverage outputs are up to date.
- Command registry drift checks pass: every built-in command in §8.2 exists in the command registry, every command has canonical namespace metadata, and every recipe post-init allowlisted command declares `recipePostInitAllowed: true`.
- Service registry drift checks pass: every core service tag listed in §3.4 is exported from `@lando/core/services` or explicitly marked internal.
- Event registry drift checks pass: every lifecycle event mentioned in §3.5/§11 has a payload schema or an explicit marker that it is a router-only diagnostic event.
- Deprecation registry drift checks pass: every surface kind in the §18.5 matrix is represented in the merged `DeprecationService` registry walk, every `DeprecationNotice` in the codebase round-trips through schema decode without loss, and every annotated public schema produces a JSON Schema with a valid `x-deprecation` extension.
- The Starlight docs site builds, including generated schema reference pages.
- New abstractions are listed in §4 and have at least one bundled implementation.
- Public API additions to `@lando/core` (any new export from the entry points listed in §16.2) are accompanied by a library-API test under `test/library/` and a JSDoc block on the export.
- Public API additions to `@lando/sdk` are accompanied by a JSDoc/TSDoc block and, when schema-backed, generated schema docs.
- Any change to `package.json#exports` requires an import-boundary test asserting that the default entry stays free of OCLIF.

### 13.5 Distribution

This section catalogs *what* ships. The operational pipeline that produces these artifacts — the ordered build stages, the codegen catalog, asset embedding, signing and notarization, supply-chain attestations, the self-update protocol, and the v4.0.0 install surface — is specified in §17 ([15 Binary Build and Release Engineering](./15-binary-build-and-release.md)). Sections below cite specific §17 subsections where the operational mechanics matter.

Lando v4 ships in two forms, both built from the same source at the same version:

| Form | Audience | Built by | Installed as |
|---|---|---|---|
| **Single-executable CLI binary** | End users; no prerequisites | `bun build --compile` | One per platform: `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `windows-x64` |
| **Library package** | Bun programs embedding Lando, plus end users who prefer a package-manager install | Standard `@lando/core` publish | `bun add @lando/core` (programmatic) or `bun add -g @lando/core` (CLI on PATH via `package.json#bin`) |

**Single-executable binaries.** The default end-user release artifact is the Bun-compiled binary, one per platform target:

```bash
bun build ./bin/lando.ts --compile --target=bun-${T} --outfile=dist/lando-${T} --minify --sourcemap=external
```

Platforms shipped: `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `windows-x64`. The compiled binary embeds Bun and has no host prerequisites.

**Library package.** `@lando/core` is published to npm (and any registry the project mirrors to) as a standard ESM package. The package contains the multiple-entry-point structure spec'd in §2.7 (default entry, `/schema`, `/errors`, `/events`, `/services`, `/testing`, `/cli`, `/oclif`). The library and the CLI binary ship at the same version — there is no separate release cadence.

The library package's `package.json#bin` retains the `lando` binary entry, so installing the package globally (`bun add -g @lando/core`) also provides a `lando` CLI on PATH (subject to Bun's bin-link rules). This is the package-manager install path for users who already run Bun and prefer registry-managed installations over a downloaded binary; the runtime behavior is the same as the compiled binary. Hosts that want only the library and don't want a `lando` binary in their `node_modules/.bin` should install with the tooling's no-bin-link option.

`oclif pack` is **not** used to produce a separate tarball release artifact. The library package's bin entry covers the package-manager install path, and the compiled binary covers the no-prerequisites path; an OCLIF-packed tarball would be a redundant third form. `@oclif/core` remains the CLI framework (§2.3); only the `oclif pack` distribution mechanism is dropped.

**Bundled plugins** are statically imported into the compiled binary. The set is defined at build time via `scripts/build-bundled-plugins.ts` which generates `src/plugins/bundled.ts` (§17.2). Removing a plugin from the bundled set is a build-time decision; the user can still install it at runtime. Library consumers do **not** receive bundled plugins by default — they must opt into bundled discovery (§16.4) or contribute their own Layers.

**Bundled recipes** are statically embedded into the compiled binary. The canonical set listed in §8.8.10 is defined at build time via `scripts/build-bundled-recipes.ts` which generates `src/recipes/bundled.ts` (§17.2). Each recipe directory under `recipes/<id>/` is read and its contents (the `recipe.yml`, `templates/`, `fragments/`, `assets/`, and `README.md`) are embedded via the asset-embedding policy in §17.3 as a virtual filesystem available to `lando init --recipe <id>` without disk access. Adding or removing a canonical recipe is a build-time decision; users can still scaffold from any non-canonical recipe by referencing local paths, git, npm, or the registry. Library consumers do **not** receive bundled recipes by default; the same opt-in policy that governs bundled plugins (§16.4) covers bundled recipes.

**Bundled runtime and native helpers.** `@lando/provider-lando` downloads a complete private runtime bundle (Podman binary, helper binaries, configuration) on first use via `lando setup` and installs it under Lando-controlled data paths (§12.4). The bundle is versioned and checksum-verified and does not affect any system-wide Docker or Podman installation. Other provider-specific helpers (e.g., `mkcert`) follow the same on-demand pattern under `<userDataRoot>/bin/`. Core does not bundle any runtime artifacts directly.

**Schemas and types.** The release includes:

- `dist/schemas/*.json` — JSON Schema files for every public schema.
- `dist/types/*.d.ts` — TypeScript declaration bundles, one per entry point in §2.7.
- The `@lando/sdk` package published independently for plugin authors (runtime contract objects plus inferred types; see §2.6).

**Documentation site.** The public documentation site is built from `docs/` with Astro Starlight. It combines authored Markdown/MDX with generated reference pages for schemas, public APIs, CLI commands, lifecycle events, and tagged errors. Authored tutorials and how-tos use the executable-tutorials surface (§19): typed JSX components carry both the rendered terminal blocks and the structured test data, transcripts captured at test time at `dist/transcripts/<id>.json` are embedded at site build time, and the MDX→TypeScript codegen produces the test files that prove the docs work. The docs build consumes the generated schema metadata and the captured transcripts; it fails if the generated reference is stale or if any executable tutorial in the docs tree lacks a transcript while transcripts are required by the active build mode.

### 13.6 CI matrix

CI runs at three cadences. Each cadence is a superset of the previous one in scope.

**Per-PR CI** — runs on every pull request on:

- macOS x64 + arm64
- Linux x64 + arm64
- Windows x64

Per-PR CI executes: unit, Effect service, CLI, library API, plugin SDK contract, provider contract (against `TestRuntimeProvider` and the bundled provider), scenario, recipe, executable tutorials (scenario tutorials on every supported platform; e2e tutorials' `@smoke`-tagged subset on Linux x64; §19.11), the perf-budget suite (Linux x64 gating; macOS/Windows advisory), and the `@smoke`-tagged subset of the end-to-end suite (Linux x64 only). Type, schema, lint, and docs-build gates from §13.4 also run on every PR — including the tutorial lint gate and the tutorial-component schema gate.

**Nightly CI** — runs once per day on Linux x64/arm64 and macOS x64/arm64:

- Full end-to-end suite against the Lando-managed runtime (the default provider).
- Distribution rehearsal: `bun build --compile` for every platform target listed in §13.5, and a dry-run `bun publish --dry-run` of the library package.

**Weekly provider matrix** — runs the provider contract suite **and** the full end-to-end suite against:

- Lando-managed runtime (baseline, all platforms)
- Docker Desktop (latest, macOS + Windows)
- Docker Engine (Linux)
- Podman Desktop (macOS + Windows)
- Podman (Linux)
- Lima (macOS)
- OrbStack (macOS)

### 13.7 Release flow

- **Channels:** `stable`, `next`, `dev`. Plugins may opt into channels independently of core. The channel-to-tag mapping and the GitHub Actions release workflow are specified in §17.8.
- **Versioning:** Strict semver. Core API breaks bump major. Plugin SDK API tracks core major.
- **Auto-update:** `lando update` consults the active channel. The compiled binary self-updates by writing a new binary alongside, atomic-renaming, and re-execing. The update manifest schema, signature verification, Windows running-`.exe` rename strategy, rollback on launch failure, and permission handling are specified in §17.6.
- **Signing & supply chain:** every released artifact is signed (§17.4) and accompanied by a CycloneDX SBOM, a SLSA v1.0 provenance attestation, and cosign signatures (§17.5).
- **Installation:** v4.0.0 ships installable artifacts via GitHub Releases and a curl-pipe installer at `https://get.lando.dev/` (§17.7). Homebrew, scoop, winget, and distro packages are deferred.
- **Plugins update independently** through their own release pipelines. Plugins declare `requires."@lando/core": "^4.0.0"` to opt into compatibility.

---
