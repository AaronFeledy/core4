# Lando v4 — Testing, Distribution, and Quality Gates

> **Part 13 of 18** · [Index](./README.md)
> **Read next:** [14 Appendices](./14-appendices.md)

This part defines the quality bar and the release pipeline. Tests run under `bun test`. `tsc --noEmit` is a merge gate. The provider contract suite is mandatory for every `RuntimeProvider` plugin. The default release artifact is the Bun-compiled single-binary, one per platform target, alongside the `@lando/core` library package whose `package.json#bin` entry doubles as the package-manager install path for users who already run Bun.

Covered here: the fourteen test layers (unit, Effect service, CLI, library API, provider contract, template engine contract, host proxy contract, plugin SDK contract, scenario, recipe, executable guides/generated scenarios, deprecation, perf budget, end-to-end) with their Effect testing patterns, schema gates (round-trip encode/decode for every public schema), type gates (`tsc --noEmit` + `expectTypeOf` tests in `test/types/`), the PR merge requirements, the scenario / recipe / end-to-end conventions that replace the Lando 3 Leia format, distribution targets and bundled-plugin / bundled-recipe generation, the per-PR/nightly/weekly CI matrices, and the release flow with channels (`stable`, `next`, `dev`) and self-update.

---

## 13. Testing, Distribution, and Quality Gates

### 13.1 Test layers

| Layer | Tool | Purpose |
|---|---|---|
| Unit | `bun test` | Pure functions, schemas, expression resolver, merge, planners |
| Effect service | `bun test` + `Effect.TestServices` | Layers with test implementations; the probe primitive (§10.5.1) is asserted here under `TestClock` for deterministic attempt-count, backoff, and `timeout` behavior, and `EventService` typed `subscribe`/`waitFor`/`query` narrowing + bounded-history semantics (§11.1) are exercised here |
| CLI | `@oclif/test` + `bun test` | Command parsing, flag/arg handling, exit codes |
| Library API | `bun test` + `@lando/core/testing` | Embedding-host surface (§16): `makeLandoRuntime`, public services, `@lando/core/cli` operations, lifecycle event publication |
| Provider contract | Shared contract suite (in `@lando/sdk/test`) | Any `RuntimeProvider` plugin must pass |
| Template engine contract | Shared contract suite (in `@lando/sdk/test`) | Any `TemplateEngine` plugin must pass: capability declaration matches behavior, `lando` engine round-trip parity for the §7.3.1 portable function set, `TemplateRenderContext` shape acceptance without mutation, purity (no shell/FS/network/process state mutation), `unsafe: false` engines reject any helper that performs side effects, render output is byte-stable across repeated calls with identical input |
| Host proxy contract | Shared contract suite (in `@lando/sdk/test`) | Any `HostProxyService` plugin must pass: token auth enforcement, URL scheme allowlist (including `file://` rejection), `runLando` allowlist enforcement against the `host-proxy-allowlist` cache, recursion guard via `LANDO_HOST_PROXY_DEPTH`, concurrency cap, `pre-host-proxy-call` / `post-host-proxy-call` event publication with redacted payloads, atomic socket creation with mode `0600`, scope finalization (socket unlink, in-flight cancellation) within 1s of `Effect.interrupt` |
| File sync engine contract | Shared contract suite (in `@lando/sdk/test`) | Any `FileSyncEngine` plugin must pass: declared `capabilities` match observed behavior; `setup` is idempotent and safe under network loss; `createSession` is `Scope`-acquired and finalizes on `Effect.interrupt` within 2s; `pre-/post-file-sync-create`, `pre-/post-file-sync-pause`, `pre-/post-file-sync-resume`, `pre-/post-file-sync-terminate` events publish with redacted source paths; `${HOME}` normalization is byte-stable; `excludesHash` is deterministic across replays; `mountKey` correlation matches the `MountPlan` it realizes; `FileSyncSourceOutsideRootError` fires when source resolves outside the app root; `pause`/`resume` cycles preserve session content (asserted by a deterministic-byte-tree fixture); the bundled Mutagen engine additionally passes daemon-socket atomicity checks (mode `0600`, no pre-existing socket) and version-pinning checks (refuses to use a system Mutagen on PATH) |
| Downloader contract | Shared contract suite (in `@lando/sdk/test`) | Any `Downloader` plugin must pass: capability declaration matches observed behavior; `https://` production URLs are accepted and `file://` is rejected unless the request explicitly allows local sources; proxy/CA resolution honors §10.3.1 precedence and `NO_PROXY` bypass; existing verified artifacts short-circuit as cache hits and offline cache misses fail before network access; SHA-256 and size mismatches delete temp files and surface tagged errors; destination filenames cannot escape the destination directory; file downloads stream/hash/write atomically and finalize temp files on `Effect.interrupt`; `pre-download` / `download-progress` / `post-download` events redact proxy credentials, URL userinfo, bearer tokens, signed-URL query params, and caller-supplied secrets |
| Redaction contract | Shared contract suite (in `@lando/sdk/test`) | The single redaction primitive (§3.7) and every surface that composes it must pass: a canonical "secret soup" fixture (env assignments, `user:pass@` URLs, bearer tokens, signed-URL query params, home/Windows/UNC paths, container ids, UUIDs, high-entropy tokens, and a registered literal secret) redacts byte-identically per profile (`secrets`, `telemetry`, `transcript`); the value layer masks longest-first and runs before the pattern layer; registered secret values never survive even when split across a pattern boundary; `redactValue` preserves array/object/`Error` shape and never throws on cyclic input; the canonical `[redacted]` sentinel and the `transcript` placeholder vocabulary are byte-stable; an audited/sandboxed `ShellRunner` / `BunSelfRunner` / `HostProxyService` / `FileSyncEngine` / `Downloader` plugin cannot weaken the sentinel, value-set, or pattern coverage |
| Interaction contract | Shared contract suite (in `@lando/sdk/test`) | Any `InteractionService` impl (`InteractionServiceLive`, `TestInteractionService`, plugin-contributed) must pass: capability declaration matches observed behavior; answer-source precedence (explicit answer → default-under-`--yes` → interactive prompt → `InteractionRequiredError`) resolves deterministically; `mode: "auto"` gates interactivity on TTY; non-interactive mode never blocks on stdin and fails fast with remediation; every `PromptType` validates per its `validate` rules; `secret` answers are never echoed, never logged, and absent from transcripts; `Effect.interrupt` surfaces `InteractionCancelledError` and restores TTY state; dynamic `choicesFrom` resolves under the `runs:` allowlist and degrades to manual entry / `ChoicesUnavailableError`; prompt output routes through `Renderer.output` when present |
| Tooling engine contract | Shared contract suite (in `@lando/sdk/test`) | Any `ToolingEngine` plugin (and the built-in `providerExec` / `host` engines) must pass: declared `capabilities` match observed behavior; a compiled `ToolingProgram` graph runs its steps in dependency order with the documented concurrency; `Effect.interrupt` cancels in-flight steps and finalizes child processes; `tooling-step-start` / `-complete` / `-skip` / `-fail` events publish with redacted command shapes; up-to-date `sources`/`generates` checks short-circuit to `-skip`; a non-zero step exit maps to a tagged `ToolingExecError` carrying the failing step id; secret-resolved values never reach event/transcript output |
| Route filter contract | Shared contract suite (in `@lando/sdk/test`) | Any `RouteFilter` plugin (and the built-ins `requestHeader` / `responseHeader` / `redirect` / `rewritePath` / `stripPrefix` / `addPrefix`) must pass: the filter is provider-neutral (emits a declarative transform of the route intent, never proxy-native middleware); `apply` is a pure, deterministic, idempotent transform; declared `capabilities` match behavior; invalid filter options fail schema decode with a tagged error before the plan is built; filter ordering is stable across replays |
| Secret store contract | Shared contract suite (in `@lando/sdk/test`) | Any `SecretStore` plugin (and the built-in env store) must pass: `resolve(ref)` returns the value for a known `${secret:…}` reference and fails with `SecretNotFoundError` for an unknown one; resolved values are registered with the canonical redactor (§3.7) so they never appear in logs, events, transcripts, lockfiles, or cache metadata; `resolve` is read-only and side-effect-free; missing-backend/auth failures surface tagged errors with remediation; already-cached secrets resolve deterministically offline (§12.6) |
| Config translator contract | Shared contract suite (in `@lando/sdk/test`) | Any `ConfigTranslator` plugin must pass: `detect()` is authoritative over the advisory `detects:` globs; `translate()` returns a schema-valid `LandofileShape` fragment plus diagnostics and NEVER an `AppPlan`, never mutates files, never contacts a provider, never installs plugins; `optionsSchema` (when declared) validates caller options before `translate`; output is deterministic for identical input; the emitted fragment round-trips through the canonical Landofile serializer (§7.8.1) |
| Plugin source contract | Shared contract suite (in `@lando/sdk/test`) | Any `PluginSource` plugin (and the built-in registry/git/local/tarball sources) must pass: `resolve(spec)` yields a concrete package root contained under a Lando-managed store after realpath resolution (escapes fail with `PluginModulePathError`); resolution honors `network.proxy` / `network.ca` (§10.3.1); registry auth tokens are redacted from logs/events; resolution is offline-safe for already-locked sources (§9.3) and never re-fetches without a lockfile change; failures surface tagged errors with remediation |
| Doctor check contract | Shared contract suite (in `@lando/sdk/test`) | Any `doctorChecks:` contribution (and the built-in core checks) must pass: `run()` returns a `DoctorCheckResult` whose issues carry severity, context, and either an `automatic` solution command or `manual` instructions; default runs are read-only and only `--fix` executes automatic solutions; shell-shaped probes route through `ShellRunner` so they appear in the redacted doctor transcript (§10.9); checks never require provider-native commands for normal diagnosis unless the provider is the subject; secrets are redacted |
| Plugin SDK contract | Type tests + runtime tests | Public API compatibility |
| Scenario | `bun test` + `@lando/core/testing` | End-to-end through the library API against `TestRuntimeProvider`; no real container runtime |
| Recipe | `bun test` against `recipes/` | Every canonical recipe scaffolds with default answers and produces a Landofile that passes schema validation; the resulting app starts under the end-to-end suite |
| Executable guides | `bun test` over `test/scenarios/generated/**` after `scripts/build-guide-scenarios.ts` (§19.7, §17.2) | Every authored executable guide under `docs/src/content/docs/{guides,tutorials,how-to}/**` and every `recipes/<id>/README.mdx` with a `<Guide>` root regenerates into generated scenario tests per scenario variant (§19.16), runs through each scenario's declared `layer` (`scenario` against `TestRuntimeProvider`, `e2e` against the real provider), and surfaces failures back to MDX or colocated case source via the source-mapper reporter (§19.8); generated tests are gitignored, internal transcripts are captured under `dist/transcripts/<guide-or-fixture-id>/...`, and the docs build consumes only public reader-scenario transcript frames (§19.6) |
| Deprecation | `bun test` + `@lando/core/testing` | Per-surface tests that exercise every `DeprecationNotice` in the codebase: triggering the surface emits the `deprecation-used` event, the renderer warns once per `(kind, id)`, `lando doctor --deprecations` lists the entry, and the `removeIn` gate rejects stale notices (§18.7–§18.8) |
| Perf budget | `bun test` + `Bun.$` driving `dist/lando-${target}` with byte-resolution stdout/stderr capture | Asserts the §2.1 end-to-end and perceived-performance budgets, the §12.5 hot-path read budgets, and the §8.9.1 first-paint contract |
| End-to-end | `bun test` + `Bun.$` against the compiled binary | The released artifact run on a real OS against a real provider |

**Compiled-binary dispatch parity.** Because the compiled `$bunfs` binary routes through the hand-rolled `runCompiledCli` rather than `@oclif/core`'s `execute()` (§8.4.1, resolved as the §14.2 option (b) outcome), a dedicated parity test layer (`core/test/cli/parity/`) holds the two shipping dispatch paths at a single contract. It has two halves. The **structural** half (no process spawn; runs on every platform) takes the canonical command-id universe as `Object.keys(compiledCommands)` and asserts: every id is exactly one of MVP-implemented (`MVP_COMMAND_IDS`) or deferred (`DEFERRED_COMMAND_PLANS`, the §17.1 stage-7 deferred-command set); the two sets partition the registry; every MVP id has an `argv[0]` dispatch branch in `runCompiledCli`; and every deferred id has a registered plan and no bespoke branch (it routes through the generic `NotImplementedError` fallthrough). This is the exhaustive coverage of every canonical command id. The **behavioral** half (drives the compiled binary on linux-x64) asserts the source and compiled paths produce semantically identical exit codes, tagged-error payloads, and JSON-renderer envelopes (after normalizing timestamps and temp paths via the shared `parity/normalize.ts`) for representative MVP commands — including the canonical `meta:version` / `meta:shellenv` forms, which must dispatch rather than emit `NotImplementedError` — and for the deferred set.

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

**File sync engine contract suite** (mandatory for every `FileSyncEngine` plugin and for the bundled `@lando/file-sync-mutagen`; lives in `@lando/sdk/test`):

- Capability declaration: the engine's `capabilities` field at runtime matches the manifest declaration in §4.4 and matches observed behavior — every declared `mode` is accepted by `createSession`, declared `exclusionPatterns: true` engines actually honor `excludes:`, declared `progressReporting: true` engines actually emit `file-sync-progress` for every session.
- Setup idempotency: `setup()` succeeds when binaries are already present, succeeds when the daemon is already running, and is a no-op on a `bindMountPerformance: "native"` provider. A `setup()` after a partial failure (binary partially downloaded, daemon socket leftover) recovers cleanly without manual intervention.
- Session lifecycle: a happy-path `createSession` → `pauseSession` → `resumeSession` → `terminateSession` cycle publishes the eight expected `pre-/post-file-sync-*` events in order, each with a stable `callId` linking pre to post and a `mountKey` matching the originating `MountPlan`. The `Scope` acquired by `createSession` finalizes within 2s of `Effect.interrupt`; the contract harness asserts session termination by `listSessions(filter)` returning empty for that app.
- Source-path normalization: a session created with `source: ~/projects/foo` (under the host user's home) emits events whose payload `source` is `${HOME}/projects/foo`; the active `Logger` at debug level observes the absolute path. Asserted via a transcript fixture with redaction enabled.
- Excludes correctness: an engine declaring `exclusionPatterns: true` correctly excludes the declared paths (asserted by a deterministic byte-tree fixture: 100 files, 5 of which are under `excludes:`, transferred to a service path; the 5 must not appear). An engine declaring `exclusionPatterns: false` MUST forward the excludes back to the planner so the volume-shadow expansion (§6.4) takes over; the harness asserts the resulting `MountPlan` carries one volume-shadow per exclude.
- Source containment: `createSession` with a `source` that resolves outside the app root (after symlink) fails with `FileSyncSourceOutsideRootError` and does NOT spawn a daemon or allocate a session.
- Pause/resume content fidelity: a deterministic-byte-tree fixture is synchronized; `pauseSession` is called; the host-side fixture is mutated; `resumeSession` is called; the contract asserts the mutations propagate to the target on resume without manual reconciliation.
- Conflict surfacing: a fixture that creates a both-modified conflict on a `mode: "two-way-safe"` session emits `file-sync-conflict-detected` with the affected paths and the `kind: "both-modified"` discriminator; the engine MUST refuse to silently auto-resolve.
- Cancellation: `Effect.interrupt` of a session-creation fiber finalizes within 2s — engine-side allocations released, daemon-side sessions terminated, no leaked resources visible to `listSessions`.
- Network discipline: the engine's `setup()` honors the `network.proxy` and `network.ca` resolution path; a fixture that points the proxy at a recording test server asserts every binary download is routed through it. Proxy credentials in the recording are redacted.
- Bundled-Mutagen-specific assertions: the daemon socket is created atomically (`O_CREAT | O_EXCL`) with mode `0600`; a pre-existing socket triggers `FileSyncDaemonUnreachableError`; the engine refuses to use a `mutagen` binary found on the system `PATH` (asserted by setting `PATH=/path/to/fake-mutagen` and verifying the engine still uses `<userDataRoot>/bin/mutagen`); version-pin enforcement triggers a daemon restart when the pinned `mutagen-versions.json` checksum changes between Lando releases.

**Library API contract suite** (mandatory; lives in `test/library/`):

- `makeLandoRuntime` returns a Layer satisfying every default service tag in §3.4.
- The default entry (`@lando/core`) does not pull `@oclif/core` into the import graph (import-boundary test).
- `@lando/core/cli` exports a function for every built-in command listed in §16.7's "exported as functions" set.
- `@lando/core` exports `openLandoRuntime` and `resolveApp` from the default entry without pulling `@oclif/core` into the import graph; `@lando/sdk` exports the canonical `App`, `AppSelector`, `AppResolveError`, and `LandoRuntime` contracts.
- `@lando/core/testing` ships a `TestRuntime` that satisfies the provider contract suite against `TestRuntimeProvider`.
- Lifecycle event sequence (§11.4) is identical between a CLI invocation and `app.start()` against the same Landofile + plugin set.
- Plugin policy honors `discovery.{bundled,system,user,app}` flags independently, including the library-mode default of all-false.
- Multiple `makeLandoRuntime` instances in one process are isolated (no shared caches, no cross-runtime event leakage).
- `resolveApp` and `runtime.app` produce root-bound `App` handles: later calls remain stable after `process.chdir`, decoded `LandofileShape` selectors require an explicit root, selector-less calls resolve from the retained runtime `cwd` (or the acquired scratch app for scratch runtimes), and selector mismatches fail with tagged `AppResolveError` variants.
- `App` lifecycle methods preserve scope ownership: `app.start()` defaults to managed `detached: false`, start-state finalizers survive the method call, runtime-scope close tears them down, and explicit `detached: true` does not register a handle-owned stop finalizer.
- A single retained runtime Layer acquisition or `LandoRuntime` object reused across N sequential operations performs the per-bootstrap work exactly once: bootstrap, plugin discovery, AOT layer instantiation, and cache loading happen on operation 1; operations 2..N each meet their respective §2.1 **hot-path** budget at p95. The library-mode reuse-perf test class lives under `test/perf/library-reuse/` and is part of the perf-budget suite (gated on Linux x64 per §13.4, advisory on macOS/Windows per-PR CI). The test class asserts the §16.3 "Runtime reuse for performance" contract for `runtime.run(runTooling(...))`, `app.info()`, `runtime.run(appConfig.get(...))`, and a representative `app.start()` → `app.stop()` round-trip.
- Closing the host scope finalizes every runtime resource (provider connections, file watchers, log streams).
- Tagged errors crossing the runtime boundary include their full payload schema and remediation field.
- `runTooling(name, input)` executes the same compiled task graph through CLI and library paths, including deps, expressions, status/precondition behavior, and lifecycle events.

**Scenario suite** (lives in `test/scenarios/`):

- One TypeScript file per scenario; uses `bun test` with `@lando/core/testing`.
- Drives the program through the public library API (`makeLandoRuntime`, `openLandoRuntime`, `resolveApp`, `runtime.app`, `runTooling`, `app.start()`, and programmatic `@lando/core/cli` command operations).
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
- The concurrent-build test class drives `lando start` against `TestRuntimeProvider` configured with three services whose `build.app:` scripts sleep for known durations (`appserver`/`composer install` = 6s, `node`/`npm ci` = 6s, `python`/`pip install` = 4s). It asserts: (a) wall-clock for the `app` build phase is within 20% of `max(t_a, t_b, t_c)` (i.e., ~6s), not `sum(…)` (~16s); (b) every child publishes at least one `task.detail` event during its sleep window; (c) `task.tree.start` fires once per phase with the correct `children:` list; (d) on synthetic Enter/Esc input fed to the renderer's TTY, `task.detail.expand` and `task.detail.collapse` events are published in order; (e) injecting a non-zero exit on the `node` step under the default `failFast: false` policy produces `BuildPhaseFailedError { failures: [node] }` *after* the other two complete normally — not before; (f) the same fixture under the `artifact` phase with `failFast: true` interrupts the in-flight siblings on first failure within the §2.1 cancellation budget; (g) re-running the same `lando start` after the first cycle short-circuits all three steps to `build-step-skip { reason: "up-to-date" }` because the `build-results` cache (§12.1) reports matching `buildKey`s; (h) the per-step transcript files exist at the expected `<userDataRoot>/builds/<app-id>/...` paths and contain the full unredacted output.
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
- The Lando 3 `examples/` directory is **not** the home for v4 e2e fixtures. Internal regressions live under `test/e2e/fixtures/`; user-facing scenarios live as canonical recipes under `recipes/<id>/` and are tested through the scaffold flow. The `examples/` directory does not exist in the v4 layout. Authored user docs that include executable steps live as MDX guides under `docs/src/content/docs/{guides,tutorials,how-to}/**/*.mdx` and `recipes/<id>/README.mdx`, processed by §19 ("Executable Guides and Scenarios") into generated scenario tests; doc snippets that appear in the rendered Starlight site are derived from the same MDX components (or, for whole-file fixtures, from `?raw` imports of the recipe templates), and the docs build fails when the source and the rendered site diverge.
- A smoke subset (tagged `@smoke`) runs on every PR on Linux x64 against the Lando-managed runtime; the full suite runs nightly on Linux x64/arm64 and macOS x64/arm64; Windows e2e runs on the weekly provider matrix.
- The e2e suite plus the executable-guides layer (§19) together replace the Lando 3 Leia (`@lando/leia`) approach. The v3 "markdown as executable spec" format is retired wholesale: bash-block parsing, `grep`-based assertions, and the `Start up tests` / `Verification commands` / `Destroy tests` heading contract no longer apply. The properties Leia provided — real binary, real provider, structured cleanup — are preserved by the e2e suite using TypeScript assertions and `Scope`-based cleanup; the "fixtures co-located with docs" property is preserved by the recipe scaffolds (canonical user-facing init artifacts and e2e source for stack-starter scenarios) and by executable guides/generated scenarios (typed JSX components in MDX whose props carry structured assertions and whose codegen produces TypeScript tests, leaving prose free to be prose). v4 is a fresh rewrite, not a migration: there is no v3-to-v4 conversion path for Leia files.

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
- The file sync engine contract suite (§13.1) passes against `passthrough` and against the bundled `@lando/file-sync-mutagen`. Every bundled provider's reported `bindMountPerformance` value is exercised at least once across the suite.
- The library API contract suite passes.
- The scenario suite passes on every per-PR platform.
- The recipe suite passes on every per-PR platform; every canonical recipe under `recipes/` validates and produces a schema-valid Landofile with default answers.
- The executable-guides suite passes (§19.11): every authored executable guide under `docs/src/content/docs/{guides,tutorials,how-to}/**` and every `recipes/<id>/README.mdx` containing a `<Guide>` regenerates via `scripts/build-guide-scenarios.ts`, type-checks under `tsc --noEmit`, and runs each generated scenario through its declared `layer` on the per-PR matrix (scenario-layer guide scenarios on every supported platform; e2e guide-scenario `@smoke` subset on Linux x64). Failures map back to MDX or colocated case coordinates via the source-mapper reporter (§19.8).
- The guide lint gate passes: `bun run lint:guides` (§19.10) walks every executable-guide MDX file and asserts frontmatter validity, Diátaxis bucket constraints, component prop conformance, the hidden:visible ratio cap, the `<Inline>` density cap, the display:execute divergence cap, mandatory `<Cleanup>` for `layer: "e2e"` scenarios, and the no-raw-shell-blocks rule that prevents the v3 Leia failure mode.
- The guide/scenario component schema gate passes: every component prop schema in `@lando/sdk/docs/components`, plus `GuideFrontmatter`, `ScenarioProps`, `MatcherSchema`, `Transcript`, and `TranscriptFrame`, round-trips through encode/decode (§13.2 schema gate scope).
- The transcript redaction gate passes: a fixture transcript exercising every redaction class in `@lando/sdk/docs/redactions` produces output identical to the canonical golden frame (§19.6).
- The redaction contract suite passes (§13.1): the canonical "secret soup" fixture redacts byte-identically for each profile (`secrets`, `telemetry`, `transcript`), the value layer runs longest-first and before the pattern layer, and `redactValue` preserves shape without throwing on cyclic input.
- The redaction-boundary gate passes: `bun run check:redaction-boundary` (§3.7) walks `core/src/**` and `plugins/**` and fails on new `[redacted]` / `[REDACTED]` string literals and ad-hoc secret-matching regexes outside `@lando/sdk/secrets`, mirroring the renderer-boundary gate.
- The MDX source-mapper reporter passes its fixture suite: a known-failing executable guide → seeded generated scenario test → asserted reporter output translates failure coordinates back to MDX line ranges with no off-by-one errors (§19.8).
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

**Bundled runtime and native helpers.** `@lando/provider-lando` downloads a complete private runtime bundle (Podman binary, helper binaries, configuration) on first use via `lando setup` and installs it under Lando-controlled data paths (§12.4). The bundle is versioned and checksum-verified and does not affect any system-wide Docker or Podman installation. Other Lando-managed helpers follow the same on-demand pattern under `<userDataRoot>/bin/`: `mkcert` for the bundled CA plugin, and the **Mutagen host CLI plus per-platform agent binaries** for the bundled `@lando/file-sync-mutagen` engine (§10.6.2). Each helper plugin ships a compile-time `*-versions.json` asset (Mechanism A per §17.3) carrying pinned URLs and SHA-256 checksums; first-use download is routed through the §10.3.1 corporate-proxy / custom-CA stack. Core does not bundle any runtime or helper binaries directly into the compiled `lando` binary — they are always under `<userDataRoot>/bin/` and managed by `lando setup` / `lando doctor --fix`.

**Runtime-bundle verification against the current commit.** The provider-integration jobs (§13.6) MUST exercise the real `lando setup` runtime-bundle download-and-verify path against a bundle built from the **current commit**, never a published release. A CI prep step runs `scripts/build-runtime-bundle.ts --local` to stage the per-platform bundle and emit a `file://` manifest carrying its locally-computed SHA-256, then runs `lando setup` with `LANDO_RUNTIME_BUNDLE_MANIFEST` pointed at that manifest. Checksum verification stays enforced against the locally-built artifact (§5.8.1); the job fails if the downloaded bytes do not match. This manifest override is the standing mechanism that lets CI verify setup against the most recent code without depending on a published runtime-bundle release, and it is the supported way to test setup against a local bundle during development. It does not relax the production path: with no override, `lando setup` resolves the bundled `https://`-pinned manifest unchanged.

**Schemas and types.** The release includes:

- `dist/schemas/*.json` — JSON Schema files for every public schema.
- `dist/types/*.d.ts` — TypeScript declaration bundles, one per entry point in §2.7.
- The `@lando/sdk` package published independently for plugin authors (runtime contract objects plus inferred types; see §2.6).

**Documentation site.** The public documentation site is built from `docs/` with Astro Starlight. It combines authored Markdown/MDX with generated reference pages for schemas, public APIs, CLI commands, lifecycle events, and tagged errors. Authored guides, tutorials, and how-tos use the executable-guides surface (§19): typed JSX components define rendered reader scenarios plus optional hidden test-only scenarios, transcripts captured at test time are split into public and internal frames, and the MDX→scenario codegen produces the generated tests that prove the docs work. The docs build consumes the generated schema metadata and the captured transcripts; it fails if the generated reference is stale or if any rendered reader scenario in the docs tree lacks a public transcript while transcripts are required by the active build mode.

### 13.6 CI matrix

CI runs at three cadences. Each cadence is a superset of the previous one in scope.

**Per-PR CI** — runs on every pull request on:

- macOS x64 + arm64
- Linux x64 + arm64
- Windows x64

Per-PR CI executes: unit, Effect service, CLI, library API, plugin SDK contract, provider contract (against `TestRuntimeProvider` and the bundled provider), scenario, recipe, executable guides/generated scenarios (scenario-layer guide scenarios on every supported platform; e2e guide-scenario `@smoke` subset on Linux x64; §19.11), the perf-budget suite (Linux x64 gating; macOS/Windows advisory), and the `@smoke`-tagged subset of the end-to-end suite (Linux x64 only). Type, schema, lint, and docs-build gates from §13.4 also run on every PR — including the guide lint gate and the guide/scenario component schema gate.

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
