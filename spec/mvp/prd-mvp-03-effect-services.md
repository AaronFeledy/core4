# PRD: MVP-03 — Effect services (12 Live implementations)

## Introduction

PRD-01 ships the Effect Service *tags* (frozen, semver-stable shapes) in `@lando/sdk`. PRD-02 ships the runtime *plumbing* that composes them into a Layer. This PRD ships the *Live implementations* — the actual classes that satisfy the tags and run on Bun.

Per [`spec/ROADMAP.md`](../../spec/ROADMAP.md) Phase 1 "Effect services (minimum set)", twelve services must work end-to-end at MVP:

1. `ProcessRunner` — `Bun.spawn`-backed
2. `ShellRunner` — `Bun.$`-backed (needed by `host` ToolingEngine, even though tooling itself is deferred)
3. `FileSystem` — `Bun.file`-backed
4. `ConfigService` — global config + env overlay only
5. `LandofileService` — YAML parser + minimal Compose subset
6. `EventService` — basic publish/subscribe
7. `Logger` — Effect's built-in `Logger.pretty` wrapped
8. `CacheService` — in-memory only
9. `PluginRegistry` — reads `BUNDLED_PLUGINS` only
10. `RuntimeProvider` + `RuntimeProviderRegistry` — single-implementation picker
11. `AppPlanner` — produces a minimal `AppPlan`
12. `BuildOrchestrator` — sequential, no group weighting

Depends on: **PRD-01 (SDK contracts)**, **PRD-02 (Foundation)**.

## Goals

- One Live Layer per tag, each composable into `LandoRuntimeLive` at the right bootstrap level.
- Each Live impl has a focused, isolated test that uses only the dependencies it needs (no implicit dependency on `RuntimeProvider` from a `Logger` test, etc.).
- Failure channels use only `@lando/sdk` tagged errors.
- `ShellRunner` and `ProcessRunner` are the *only* services that touch `Bun.spawn` / `Bun.$` directly — every other service uses them.
- `PluginRegistry` consumes `BUNDLED_PLUGINS` via the codegen path PRD-02 ships.

## User Stories

### US-001: `ProcessRunner` Live implementation (`Bun.spawn`)

**Description:** As `RuntimeProvider`, I need a typed `ProcessRunner.run({ cmd, args, cwd, env, stdin?, timeoutMs? })` that returns an `Effect` resolving to `{ stdout, stderr, exitCode }` or failing with a structured `ProcessExecError`.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/services/process-runner.test.ts` runs `Effect.flatMap(ProcessRunner, p => p.run({ cmd: "echo", args: ["hello"] }))` and asserts `stdout === "hello\n"`, `exitCode === 0`.
- [ ] Test asserts `cmd: "false"` resolves with `exitCode === 1` *without* failing the Effect (non-zero exit is data, not a defect — failure is reserved for spawn errors).
- [ ] Test asserts a missing executable (`cmd: "definitely-not-a-binary"`) fails with `ProcessExecError` carrying `{ cmd, cwd, errno }`.
- [ ] Test asserts `timeoutMs` triggers a `ProcessTimeoutError` with the elapsed ms.
- [ ] No use of `child_process` — `Bun.spawn` only.
- [ ] Live impl lives at `core/src/services/process-runner.ts`; test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-002: `ShellRunner` Live implementation (`Bun.$`)

**Description:** As the future `host` ToolingEngine (deferred to Alpha but the contract lives now), I need `ShellRunner.exec(cmdString, { cwd, env })` that runs through Bun's shell API and returns the same `{ stdout, stderr, exitCode }` shape as `ProcessRunner`.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/services/shell-runner.test.ts` runs `Effect.flatMap(ShellRunner, s => s.exec("echo $FOO", { env: { FOO: "bar" } }))` and asserts `stdout === "bar\n"`.
- [ ] Test asserts shell metacharacters (`|`, `&&`, `>`) work as expected through `Bun.$`.
- [ ] Test asserts a syntactically invalid shell command fails with a `ShellExecError`.
- [ ] Live impl lives at `core/src/services/shell-runner.ts`; test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-003: `FileSystem` Live implementation (`Bun.file`)

**Description:** As `LandofileService` and `CacheService`, I need a typed `FileSystem` service that wraps `Bun.file` and `Bun.write` so my failure channels are tagged errors, not anonymous throws.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/services/file-system.test.ts` exercises `read`, `write`, `exists`, `stat`, `mkdir`, `remove`, `readDir` on a Bun temp dir and asserts behavior matches `Bun.file` semantics.
- [ ] Each method's failure channel is one of: `FileNotFoundError`, `FilePermissionError`, `FileIoError` (all from `@lando/sdk/errors`).
- [ ] `read` returns a `Stream<Uint8Array>` for chunked reads, plus a `readText` convenience returning `Effect<string, ...>`.
- [ ] No use of `node:fs` — `Bun.file` / `Bun.write` only.
- [ ] Live impl lives at `core/src/services/file-system.ts`; test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-004: `ConfigService` Live implementation (global config + env overlay)

**Description:** As `@lando/core`, I need `ConfigService.load: Effect<GlobalConfig, ConfigError>` that reads a YAML config from `<userConfRoot>/config.yml`, overlays env vars (`LANDO_*` namespace), and returns the merged shape.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/services/config.test.ts` writes a fixture `config.yml` to a temp `userConfRoot`, sets `LANDO_DEFAULT_PROVIDER_ID=lando`, calls `ConfigService.load`, and asserts the env overlay wins over the file.
- [ ] Test asserts that a missing config file returns the schema-default `GlobalConfig` (not an error — file is optional at MVP).
- [ ] Test asserts that a malformed YAML config fails with `ConfigError` carrying `{ filePath, message }`.
- [ ] Test asserts `ConfigService.get("defaultProviderId")` returns the merged value.
- [ ] Live impl lives at `core/src/services/config.ts`; test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-005: `LandofileService` Live implementation (YAML + Compose subset)

**Description:** As `AppPlanner`, I need `LandofileService.discover` to walk up from `cwd`, find a `.lando.yml`, parse it, validate it against the SDK `LandofileShape`, and return a typed value.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/services/landofile.test.ts` writes a fixture `.lando.yml` (with one `node:lts` service and one `postgres` service) under a temp dir, sets `cwd` to a subdir, calls `LandofileService.discover`, and asserts the parsed shape.
- [ ] Test asserts a missing `.lando.yml` fails with `LandofileNotFoundError` carrying the search path list.
- [ ] Test asserts malformed YAML fails with `LandofileParseError` carrying `{ filePath, message, line }`.
- [ ] Test asserts a Compose key outside the MVP allowlist (e.g. `deploy:`) fails with `LandofileValidationError` naming the rejected key + a remediation pointing at the spec.
- [ ] No `includes:`, no `landofile.ts`, no expressions at MVP.
- [ ] Uses `Bun.file` (or `js-yaml`/`yaml` package — implementer's choice as long as it's already a workspace dep).
- [ ] Live impl lives at `core/src/landofile/`; test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-006: `EventService` Live implementation (basic pub/sub)

**Description:** As `app:start`/`app:stop`, I need `EventService.publish(event)` and `EventService.subscribe(handler)` so plugins (and future telemetry) observe lifecycle events.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/services/event-service.test.ts` subscribes a handler, publishes a `pre-app-start` event, and asserts the handler ran with the typed payload.
- [ ] Test asserts published events go to *every* active subscriber (fan-out).
- [ ] Test asserts a subscriber's failure does *not* abort the publish (errors logged, not propagated — `EventError` raised from publish only on the bus itself failing).
- [ ] No priority bands at MVP (Alpha+); subscribers fire in registration order.
- [ ] Subscriptions are scope-bound — when their owning Effect Scope closes, the handler is unregistered.
- [ ] Live impl lives at `core/src/services/event-service.ts`; test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-007: `Logger` Live implementation (`Logger.pretty` wrapper)

**Description:** As every other service, I need `Logger.info | warn | error | debug` calls to route through Effect's built-in `Logger.pretty` so output is consistent.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/services/logger.test.ts` captures stdout, runs an Effect that calls `Logger.info("hello")`, and asserts the captured output contains `"hello"` and a level marker (`INFO` or equivalent).
- [ ] Test asserts a `silent` configuration produces no output (used in library mode per PRD-02 `makeLandoRuntime` defaults).
- [ ] At MVP, the `@lando/logger-pretty` plugin is empty — Effect's `Logger.pretty` is what's used. The Live Layer in core is a thin wrapper that picks `Logger.pretty` vs `Logger.silent` based on config.
- [ ] Live impl lives at `core/src/logging/`; test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-008: `CacheService` Live implementation (in-memory)

**Description:** As `AppPlanner` (and future Beta consumers), I need `CacheService.get<T>(key, schema)` and `set(key, value, ttlMs?)` that round-trip through Effect Schema and live in-memory only at MVP.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/services/cache.test.ts` sets a value, gets it back, and asserts equality after schema decode.
- [ ] Test asserts a missing key returns `Option.none()` (not an error).
- [ ] Test asserts `ttlMs` expiration causes subsequent gets to return `Option.none()` (use a controllable Clock; Effect's `TestClock` is acceptable).
- [ ] Test asserts a value whose stored encoding doesn't match `schema` on read returns `CacheError` carrying `{ key, decodeError }` (so a future schema change is loud, not silent).
- [ ] No persistence — process exit drops the cache.
- [ ] Live impl lives at `core/src/cache/`; test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-009: `PluginRegistry` Live implementation (bundled-only)

**Description:** As `RuntimeProviderRegistry` and `AppPlanner`, I need `PluginRegistry.list` and `PluginRegistry.load(name)` to return manifests sourced exclusively from `BUNDLED_PLUGINS`.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/services/plugin-registry.test.ts` calls `PluginRegistry.list` and asserts the returned array contains all four MVP plugin names (`@lando/provider-lando`, `@lando/provider-docker`, `@lando/service-lando`, `@lando/logger-pretty`).
- [ ] Test asserts `PluginRegistry.load("@lando/provider-lando")` returns the manifest with the expected `kind: provider` discriminator.
- [ ] Test asserts `PluginRegistry.load("not-bundled")` fails with `PluginLoadError` naming the missing plugin.
- [ ] No FS scanning, no system/user/app discovery sources at MVP.
- [ ] Live impl lives at `core/src/plugins/registry.ts`; test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-010: `RuntimeProvider` + `RuntimeProviderRegistry` Live implementations

**Description:** As `app:start`, I need to ask the registry for the active provider, get a typed `RuntimeProvider`, and call its lifecycle methods. At MVP the registry is a single-implementation picker — it returns whichever provider matches `config.defaultProviderId`.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/services/runtime-provider-registry.test.ts` configures `defaultProviderId: "lando"`, asks the registry for the active provider, and asserts it returns the `provider-lando` Layer's `RuntimeProvider`.
- [ ] Test asserts `defaultProviderId: "docker"` returns the `provider-docker` provider (PRD-04 stretch — if `provider-docker` is not yet implemented, the test xfails with a `// xfail: PRD-04 stretch goal` comment, not a skip).
- [ ] Test asserts `defaultProviderId: "missing"` fails with `NoProviderInstalledError`.
- [ ] Test asserts that asking the registry for capabilities returns the SDK `ProviderCapabilities` value the active provider declares.
- [ ] The registry consults `PluginRegistry` for the candidate provider list; it does *not* hardcode plugin names.
- [ ] Live impl lives at `core/src/providers/registry.ts`; test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-011: `AppPlanner` Live implementation (minimal `AppPlan`)

**Description:** As `app:start`, I need `AppPlanner.plan(landofile, providerCapabilities)` to produce a typed `AppPlan` containing the service list, one app-root bind mount, and endpoints.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/services/app-planner.test.ts` plans a fixture Landofile with one `node:lts` and one `postgres` service against a `provider-lando` capability fixture, and asserts the resulting `AppPlan` contains:
  - Both services in `services[]` with the correct `serviceType`, `image`, `ports`, `environment`.
  - One bind mount of the app root → `/app` (or similar canonical mount point).
  - Endpoints derived from each service's published ports.
  - `providerId: "lando"`.
- [ ] Test asserts that planning against a capability fixture with `bindMountPerformance: "slow"` does *not* swap the bind mount for a Mutagen volume (Mutagen is Beta).
- [ ] Test asserts an unknown `serviceType` fails with `LandofileValidationError` (delegated through the Landofile schema; this test pins the propagation).
- [ ] Live impl lives at `core/src/services/planner.ts` (file already exists as a stub); test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-012: `BuildOrchestrator` Live implementation (sequential)

**Description:** As `app:start`, I need `BuildOrchestrator.build(plan)` to drive provider artifact builds for every service in the plan, sequentially, with no group weighting at MVP.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/services/build-orchestrator.test.ts` uses a `TestRuntimeProvider` whose `build` records its invocations, runs `BuildOrchestrator.build(plan)` against a 2-service plan, and asserts:
  - Both services' `build` methods were called.
  - They were called sequentially, not in parallel (assertion: a counter incremented on entry never exceeds 1 concurrent value).
  - Each invocation passed the right service plan.
- [ ] Test asserts a service whose build fails causes the orchestrator to short-circuit — subsequent services are *not* built — and the failure is propagated as the original tagged error.
- [ ] Test asserts pre-build/post-build lifecycle events are published per service.
- [ ] No group weighting at MVP — that is Beta (`spec/06-services.md` group ordering).
- [ ] Live impl lives at `core/src/services/build-orchestrator.ts`; test passes after impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

## Functional Requirements

- FR-1: One Live Layer per service, exported from `core/src/services/<service-name>.ts` (or its existing canonical location).
- FR-2: `LandoRuntimeLive` (PRD-02) merges these Layers in the right bootstrap order; this PRD does not modify the composition itself.
- FR-3: Every method's failure channel is typed against `@lando/sdk/errors`. No `unknown`, no bare `Error`, no `string`.
- FR-4: `ProcessRunner` and `ShellRunner` are the only services that call `Bun.spawn` and `Bun.$`. `FileSystem` is the only service that calls `Bun.file` / `Bun.write`. Other services use these three.
- FR-5: `EventService` subscriptions are scope-bound; when the owning Scope closes, the subscription is removed.
- FR-6: `CacheService` is in-memory at MVP; persistence ships in Alpha. The interface must already accept a `schema` parameter so persistence can be added without an interface change.
- FR-7: `PluginRegistry` reads only `BUNDLED_PLUGINS`; FS scanning, dynamic imports, and remote sources are forbidden at MVP.
- FR-8: `RuntimeProviderRegistry` derives the active provider from `ConfigService.get("defaultProviderId")` and `PluginRegistry.list`.
- FR-9: Each service's Live Layer is *idempotent* under double-build (`Layer.merge(L, L)` produces the same effective service).

## Non-Goals

- No persistent caches (Alpha).
- No plugin discovery beyond `BUNDLED_PLUGINS` (Alpha).
- No event priority bands, no event payload schema validation beyond the start/stop set (Beta).
- No `tooling` bootstrap level work (cache-only app-plan read — Beta).
- No `ProxyService`, `CertificateAuthority`, `SshService`, `HealthcheckService`, `ScannerService`, `HostProxyService` (Beta).
- No `SecretStore` (Beta).
- No `DeprecationService` (RC).
- No telemetry hooks (RC).

## Technical Considerations

- Effect 3.x patterns: `Layer.effect`, `Effect.gen`, `Effect.flatMap`. Avoid older "Tagged class with `Tag.of(...)`" patterns.
- For `EventService`, prefer `Effect.PubSub` or `Effect.Hub` (Effect's built-in pub/sub primitive) — it gives back-pressure, scope binding, and unsubscribe for free.
- `ConfigService` env overlay: only `LANDO_*`-prefixed env vars are considered. The mapping is uppercase-snake-case `LANDO_FOO_BAR` → `foo.bar` in config.
- `LandofileService` YAML parser: prefer Bun's built-in YAML capability if it exists in 1.3.x; otherwise add `yaml` as a `core` workspace dep (do *not* add it to `@lando/sdk`).
- `BuildOrchestrator` short-circuit: use `Effect.forEach({ concurrency: 1 })` rather than ad-hoc loops, so cancellation semantics match Effect's defaults.
- All services must work with `provideTestRuntime` from PRD-02 US-008 — that is the test entry point.

## Success Metrics

- 12 services, 12 dedicated tests, 12 Live Layers — all green.
- Zero use of `node:` modules across `core/src/services/` (Bun-only).
- Zero anonymous throws across `core/src/services/` — every `Effect.fail` carries a SDK tagged error.
- A grep for `as any` / `@ts-ignore` / `@ts-expect-error` across `core/src/services/` returns zero hits.

## Open Questions

- Bun shipped a built-in YAML parser experimentally in some 1.3.x releases — does it cover the MVP Landofile shape, or do we add the `yaml` package? Default: add `yaml` as a core dep; revisit at Alpha.
- Should `Logger` accept structured fields (e.g. `Logger.info("event", { appId, serviceName })`)? Default: yes — Effect's logger already supports structured annotations; expose them.
- `EventService` failure semantics on a slow subscriber: at MVP we run sequentially per-publish. Beta may add concurrency bands. Document the slow-subscriber risk in code comments.
