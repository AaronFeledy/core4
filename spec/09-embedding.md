# Lando v4 — Embedding and Library Use

> **Part 9 of 17** · [Index](./README.md)
> **Read next:** [10 Plugins](./10-plugins.md)

This part defines what it means to consume Lando v4 as a library from another Bun program. The CLI (§8) is one imperative shell over the runtime; an embedding host is another (§3.6). Both build the same `LandoRuntimeLive` Layer, run Effect programs against it, and tear down through `Scope`. There is no separate "library mode" of core — embedding is a peer use case to the CLI.

Covered here: what counts as an embedding host and which use cases are first-class, the `@lando/core` package surface and entry-point boundaries, the Effect-native public API (no Promise facade), the `LandoRuntime` factory and its options, plugin behavior in library mode (host-controlled by default; opt-in to standard discovery), bootstrap-level and lifecycle semantics for embedding hosts, resource ownership and `Scope` discipline, programmatic invocation of CLI command logic, the testing API surface, version compatibility, and the explicit non-goals.

For *what* services and schemas exist, see §3.4 and §7.8. This part is *how* a host wires them up.

---

## 16. Embedding and Library Use

### 16.1 Concept and use cases

An **embedding host** is any Bun program that imports `@lando/core` and constructs its own Effect runtime, instead of (or in addition to) invoking the `lando` binary as a subprocess. Lando v4 is designed so that the runtime, planner, providers, plugins, and lifecycle bus are reachable from Bun programs without going through OCLIF, without spawning the CLI, and without giving up tagged-error or stream typing.

First-class embedding use cases:

| Use case | Why core supports it |
|---|---|
| **Test frameworks** | Spin up a fully provisioned Lando app inside a `bun test` suite, assert on `ServiceInfo`, run `exec`, tear down through `Scope`. |
| **CI/automation tools** | Plan, validate, and apply Landofiles in CI without depending on the compiled binary's update channel. |
| **IDE/editor extensions** | Subscribe to lifecycle events, query `lando info`-equivalent data, surface diagnostics, drive `start`/`stop` from a host process. |
| **Web UIs / dashboards** | A `Bun.serve()` host that exposes Lando operations over HTTP/WebSocket. |
| **Custom CLIs / wrappers** | A vendor-specific CLI that bundles `@lando/core` with a curated plugin set and an opinionated UX, without re-implementing the runtime. |
| **Monorepo orchestrators** | A higher-level tool that drives multiple Lando apps in one fiber tree. |
| **Config translation tools** | A program that invokes plugin-contributed config translators to turn external formats, including possible v3 Landofiles, into schema-valid v4 Landofile fragments. |

Non-use-cases (see §16.10):

- Driving the CLI from the host by parsing its stdout. Core *publishes* the runtime; do not screen-scrape the binary.
- Wrapping individual providers (Docker, Podman) directly. Use a `RuntimeProvider` plugin through core's registry.
- Replacing core's services with host-owned re-implementations of the same name. Hosts MAY provide alternate Layers for the *pluggable* abstractions in §4; non-pluggable services have private contracts.

### 16.2 Public API surface

The public API is **Effect-native only**. There is no Promise/async facade, no synchronous wrapper, and no parallel set of methods that hide Effect. Hosts compose Effect programs with `Effect.gen`, run them with `Effect.runPromise` / `Effect.runFork` at the host's outer boundary, and propagate `Cause`/`Exit` through the host's preferred error story.

Public API surfaces (all exported from `@lando/core` per §2.7):

| Surface | Entry point | What it exports |
|---|---|---|
| Runtime factory | `@lando/core` | `makeLandoRuntime`, `LandoRuntimeOptions`, `BootstrapLevel` |
| Service tags | `@lando/core/services` | `ConfigService`, `LandofileService`, `PluginRegistry`, `CommandRegistry`, `ConfigTranslatorRegistry`, `TemplateEngineRegistry`, `TemplateRenderer`, `RuntimeProviderRegistry`, `AppPlanner`, `EventService`, `CacheService`, `FileSystem`, `ProcessRunner`, `ShellRunner`, `BunSelfRunner`, `PrivilegeService`, `EmbeddedAssetService`, `Logger`, `Renderer`, `Telemetry`, `DeprecationService`, `DoctorService`, `HostProxyService`, plus pluggable abstraction tags (§4.2) |
| Schemas | `@lando/core/schema` | Every schema in §7.8 (Landofile, ServiceConfig, expression AST/errors, ToolingConfig, ToolingInclude, RouteConfig, HealthcheckConfig, plugin manifest, event payloads, etc.) |
| Tagged errors | `@lando/core/errors` | Every `Schema.TaggedError` subclass declared in `src/errors/tagged.ts` |
| Lifecycle | `@lando/core/events` | `EventService` (re-exported), event payload schemas, subscriber priority bands, the standard event sequence |
| Programmatic CLI | `@lando/core/cli` | Wrappers for invoking built-in command logic without OCLIF (§16.7) |
| Testing | `@lando/core/testing` | Test-Layer fixtures, in-memory `FileSystem` and `ProcessRunner`, `TestRuntimeProvider`, the `TutorialContext` test runtime for executable tutorials (§19.4), helpers for asserting against `Stream`s and `EventService` (§16.8) |
| Docs components | `@lando/core/docs/components` | JSX/Astro runtime + AST helpers for the executable-tutorial component vocabulary (`Tutorial`, `Step`, `Run`, `Verify`, `Inspect`, `Hidden`, `Cleanup`, `Variable`, `Skip`, `Inline`, `Tabs`, `Tab`); contracts (prop schemas, frontmatter, `MatcherSchema`, `Transcript`, `TranscriptFrame`, `TabAxis`, `TabAxisValue`) live in `@lando/sdk/docs/components` (§19.3). |
| Docs redactions | `@lando/core/docs/redactions` | Re-export of the canonical transcript redaction list owned by `@lando/sdk/docs/redactions` (§19.6); consumed by both the docs build and the test-time transcript writer. |
| OCLIF adapter | `@lando/core/oclif` | The OCLIF-specific glue. Hosts MUST NOT import this unless they are building an alternate CLI distribution. |

Stability rules:

- The default entry (`@lando/core`), `@lando/core/services`, `@lando/core/schema`, `@lando/core/errors`, `@lando/core/events`, and `@lando/core/cli` are **semver-stable** within a major version. Breaking changes bump the major.
- `@lando/core/testing`, `@lando/core/docs/components`, and `@lando/core/docs/redactions` are unstable until v4.0.0 GA; published only on the `next` and `dev` channels (§13.7). After GA they follow the standard semver rule.
- `@lando/core/oclif` is **internal**. It is exported only because the OCLIF compiled-binary build needs it; embedding hosts MUST NOT import it. Tests enforce the boundary.
- Any symbol not listed above is internal and may change between patch versions.

### 16.3 The `LandoRuntime` factory

`makeLandoRuntime` returns an Effect `Layer` that an embedding host provides to its program. The factory accepts a typed options bag; every option has a documented default that mirrors the CLI's behavior, except where noted.

```ts
import { Context, Effect, Layer, Schema, Scope } from "effect";
import {
  makeLandoRuntime,
  AppPlanner,
  RuntimeProviderRegistry,
  LandofileService,
} from "@lando/core";

const runtime: Layer.Layer<LandoRuntime, LandoRuntimeBootstrapError, Scope.Scope> =
  makeLandoRuntime({
    bootstrap: "app",
    cwd: process.cwd(),
    plugins: { /* see §16.4 */ },
    config: { /* see §16.5 */ },
    logger: "silent",
    renderer: "json",
  });

const program = Effect.gen(function* () {
  const landofile = yield* LandofileService;
  const planner = yield* AppPlanner;
  const providers = yield* RuntimeProviderRegistry;

  const app = yield* landofile.discover();
  const plan = yield* planner.plan(app);
  const provider = yield* providers.select(plan);
  yield* provider.apply(plan, { reconcile: false });
});

await Effect.runPromise(
  program.pipe(
    Effect.provide(runtime),
    Effect.scoped,                     // host owns the outer Scope
  ),
);
```

**`LandoRuntimeOptions` schema (illustrative; canonical in `@lando/sdk`):**

```ts
export const LandoRuntimeOptions = Schema.Struct({
  // Bootstrap depth. Same semantics as §3.2; default `app` for embedding (CLI commands declare their own).
  bootstrap: Schema.optional(Schema.Literal("minimal", "plugins", "commands", "provider", "app", "tooling")),

  // Working directory for Landofile discovery. Required if bootstrap >= "app".
  cwd: Schema.optional(AbsolutePath),

  // Plugin source policy. Default: host-provided only. See §16.4.
  plugins: Schema.optional(EmbeddingPluginPolicy),

  // Inline overrides applied after global config + env, before Landofile.
  config: Schema.optional(Schema.partial(GlobalConfig)),

  // Override individual services with host-provided Layers (must be pluggable abstractions).
  // Composed *after* the default Layers so the host's choice wins.
  overrides: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),

  // Renderer/logger preset shortcuts. Equivalent to setting LANDO_RENDERER / LANDO_LOGGER.
  // Defaults: logger = "silent" in library mode; renderer = "json" in library mode.
  logger: Schema.optional(Schema.String),
  renderer: Schema.optional(Schema.String),

  // Telemetry: enabled by default in core. Hosts may disable it explicitly.
  telemetry: Schema.optional(Schema.Boolean),

  // Cache root override. Defaults to <userCacheRoot>.
  // Embedding hosts SHOULD pass an isolated path for tests.
  cacheRoot: Schema.optional(AbsolutePath),

  // Signal handling: the host owns SIGINT/SIGTERM by default. Set true to install
  // the same handler the CLI uses (signal → Effect.interrupt on the running fiber).
  installSignalHandlers: Schema.optional(Schema.Boolean),
});
```

**Required factory behaviors:**

- `makeLandoRuntime(options)` MUST return a single `Layer` that, when provided, satisfies every default service tag in §3.4. Type errors at the host's call site catch missing services at compile time.
- The factory MUST validate `options` with Effect Schema and return a `Layer` whose `failure` channel includes `LandoRuntimeBootstrapError` (a tagged error with discriminated subclasses for each bootstrap stage).
- The factory MUST be safe to call multiple times in one process; each call yields an independent runtime with its own caches, plugin registry, and event bus.
- The factory MUST NOT mutate process-global state (no `process.env` writes, no `process.on` handlers, no working-directory changes) unless `installSignalHandlers: true`.
- The factory MUST run the same bootstrap sequence (§3.2) up to the requested level. Lifecycle events fire identically (§16.6).
- The Layer's outer scope owns all resource handles; closing the scope tears everything down (§16.6).

**Runtime reuse for performance.** A single `LandoRuntime` MAY be reused across many sequential Effect programs by the same host. This is the **recommended pattern** for embedding hosts that perform repeated small operations — TUIs, dashboards, IDE/editor extensions, long-lived web servers, monorepo orchestrators driving dozens of apps — and is the perf shape that closes the gap between transactional CLI invocations and the deferred persistent-agent decision (§14.2):

- Build the runtime once at host startup at the **lowest** `bootstrap` level the host needs (e.g., `tooling` for an editor extension that only triggers cached tooling tasks; reserve `app` for hosts that genuinely need full app planning).
- Provide it to every program with `Effect.provide` and run each program with `Effect.runPromise` / `Effect.runFork` against the same Layer instance.
- Close the host's outer scope only when the host shuts down.

Reuse skips bootstrap, plugin discovery, AOT layer instantiation, and cache loading on every operation past the first; in a warm host, sequential operations pay only the per-operation work the program itself does. The §2.1 hot-path budgets are written assuming this reuse pattern: an embedding host that constructs a fresh runtime per operation MUST budget for cold-start latency every time, while one that reuses a runtime hits the hot column. The library-API contract suite (§13.1) gates this with a reuse-mode perf test that asserts operations 2..N each meet the §2.1 hot budget at p95 against a single retained runtime.

Hosts that need *isolation* across operations (per-request isolation in a multi-tenant server, parallel-test isolation, scenarios that mutate `<userCacheRoot>`) construct multiple runtimes per §16.5's cache-root override. The two patterns are not in tension — the host picks one per logical context.

The bundled `HostProxyServiceLive` (§10.10) is itself an embedding host: it constructs one retained `LandoRuntime` at `app:start`, holds it in scope until `app:stop`, and dispatches every inbound `runLando` RPC through `@lando/core/cli` (§16.7) against that retained runtime. Hosts building an alternate `HostProxyService` MUST follow the same pattern so the in-container `lando` shim hits hot-path budgets on all calls past the first.

**Difference from CLI defaults:**

| Concern | CLI default | Embedding default |
|---|---|---|
| `logger` | `pretty` (TTY) / `json` (non-TTY) | `silent` |
| `renderer` | `lando` | `json` |
| Plugin discovery | bundled + system + user + app | host-provided only (§16.4) |
| Telemetry | per global config, enabled by default | enabled by default unless `telemetry: false` or config disables reporting |
| Signal handlers | installed | not installed |
| `bootstrap` per command | declared by command | required option |

These differences are deliberate: an embedded host should be quiet and predictable by default, then opt into CLI-like behavior explicitly.

### 16.4 Plugin behavior in library mode

By default, a library-mode runtime has **no** plugins beyond what the host explicitly provides. This is the most predictable behavior for tests, CI, and embedded hosts where the developer's `<userDataRoot>/plugins/` should not silently change runtime behavior.

```ts
const runtime = makeLandoRuntime({
  bootstrap: "app",
  cwd: import.meta.dir,
  plugins: {
    // Layers contributed directly. Each must be a Layer<unknown, unknown, never>
    // that satisfies one or more pluggable abstractions from §4.2.
    layers: [
      DockerProviderLive,
      MkcertCertificateAuthorityLive,
      LandoServiceTypeLive,
    ],
    // Pre-resolved plugin manifests + entry modules, for hosts that want full plugins
    // (subscribers, contributions) without going through filesystem discovery.
    manifests: [
      { manifest: customServiceManifest, entry: customServiceEntry },
    ],
  },
});
```

**Plugin policy schema:**

```ts
export const EmbeddingPluginPolicy = Schema.Struct({
  // Direct Effect Layers. Most lightweight option.
  layers: Schema.optional(Schema.Array(Schema.Unknown)),

  // Pre-resolved plugin manifests + entry modules. Goes through the full
  // PluginRegistry pipeline (validation, contribution graph, subscribers).
  manifests: Schema.optional(Schema.Array(ResolvedPluginInput)),

  // Opt-in to the standard discovery chain. Each source is independently togglable.
  // Defaults: bundled=false, system=false, user=false, app=false in library mode.
  discovery: Schema.optional(Schema.Struct({
    bundled: Schema.optional(Schema.Boolean),    // statically imported into a binary
    system:  Schema.optional(Schema.Boolean),    // <systemPluginRoot>/plugins
    user:    Schema.optional(Schema.Boolean),    // <userDataRoot>/plugins
    app:     Schema.optional(Schema.Boolean),    // Landofile pluginDirs:
  })),

  // Permit discovery-found plugins to import external disk modules by file:// URL.
  // Defaults to false unless any non-bundled discovery source is enabled.
  externalImports: Schema.optional(Schema.Boolean),

  // Force-disable plugins by name even when discovery would find them.
  disable: Schema.optional(Schema.Array(Schema.String)),
});
```

**Required behaviors:**

- The runtime MUST treat `layers`, `manifests`, and `discovery`-found plugins as a single contribution graph subject to the same selection precedence (§4.3) and conflict rules (§9.4 `conflicts:`).
- A host that asks for a `RuntimeProvider` without contributing or discovering one MUST receive a clear `NoProviderInstalledError` from the registry (the CLI prints the same error; the host receives it as a tagged error).
- Hosts MAY mix `layers` and `manifests` freely. A `manifest`-loaded plugin's contributions take precedence over a raw `layer` only when the manifest declares it via `defaultFor:`.
- Discovery booleans default to `false` in library mode and `true` in CLI mode. The CLI's `init` hook calls `makeLandoRuntime` with `discovery: { bundled: true, system: true, user: true, app: true }`.
- A host MAY enable some discovery sources and disable others (e.g., `discovery: { bundled: true, user: false }` to use the static set the CLI ships with but ignore the developer's installed plugins).
- Bundled discovery uses statically imported plugin modules. System, user, and app discovery use validated external `file://` imports from disk (§9.7) and require `externalImports` to be true, either explicitly or by enabling a non-bundled discovery source.
- `disable:` is evaluated last and removes plugins regardless of source.

### 16.5 Configuration in library mode

Configuration sources, in increasing precedence:

```text
1. Built-in defaults
2. <userConfRoot>/config.yml + config.d/*.yml        (skipped if `config.skipUserConfig: true`)
3. LANDO_* environment variables                     (skipped if `config.skipEnv: true`)
4. The host's `config:` option to makeLandoRuntime   (always applied)
5. Landofile (if discovered at bootstrap >= "app")
```

**Required behaviors:**

- The host's `config:` option is a `Schema.partial(GlobalConfig)`. Validation runs at runtime construction; invalid config raises `ConfigError` from the runtime Layer.
- A host that wants a hermetic runtime can pass `{ config: { skipUserConfig: true, skipEnv: true } }`. This is the recommended setup for tests.
- Env-var prefix override (`envPrefix`) is honored before any `LANDO_*` lookup. Hosts that embed multiple Lando instances in one process MUST set distinct `envPrefix`es per instance.
- Cache root, user-conf root, user-data root, and plugin install dirs are all overridable via the host's `config:` so multiple isolated runtimes can coexist.

### 16.6 Lifecycle and scopes

The bootstrap sequence (§3.2), event sequence (§11.4), and event payload schemas (§11.2) are identical in CLI and embedding modes. Embedding hosts that need to react to lifecycle events subscribe through the `EventService`:

```ts
import { Effect, Stream } from "effect";
import { makeLandoRuntime, EventService } from "@lando/core";
import { PostStartEvent } from "@lando/core/events";

const program = Effect.gen(function* () {
  const events = yield* EventService;
  const stream = events.subscribe<PostStartEvent>("post-start");

  yield* Effect.fork(
    stream.pipe(
      Stream.runForEach((event) =>
        Effect.logInfo(`app started: ${event.app.name}`),
      ),
    ),
  );

  // ...continue with start logic...
});
```

**Required behaviors:**

- `EventService.subscribe` is a `Stream` that completes when the runtime scope closes. Hosts that use `Effect.fork` to consume events MUST either link the fork to the host's outer scope or supervise it explicitly.
- Subscriber priority bands (§11.3) and failure handling (§11.6) apply identically to host-registered subscribers.
- The host MAY register subscribers programmatically by providing a Layer that interposes on `EventService` (advanced use). The recommended path is the manifest-declared subscribers route, even for hosts.

**Scopes and resource ownership:**

- The Layer returned by `makeLandoRuntime` is a `Layer.scoped`. The host MUST run it under `Effect.scoped` (or an equivalent scope-bearing context) so finalizers run.
- Anything the runtime opens — provider connections, file watchers, log streams, network listeners, plugin module handles — is acquired in this scope. Closing the scope tears down everything in LIFO order. The CLI relies on the same guarantee.
- Cancellation propagates: an `Effect.interrupt` (whether from a host signal handler, a test timeout, or an outer fiber) finalizes the runtime cleanly. Provider operations honor `Effect.interrupt` per §5.3.
- Hosts SHOULD construct one runtime per logical app and reuse it across sequential operations within that app's lifetime; sharing one runtime across unrelated app contexts is supported but is the host's choice. The reuse pattern (see §16.3 "Runtime reuse for performance") is how long-lived hosts meet the §2.1 hot-path budgets — cold-start cost is paid once at host startup, not on every operation.

### 16.7 Programmatic CLI invocation

`@lando/core/cli` exports the underlying Effect operations that back each built-in command (§8.2). Embedding hosts that want to "run what `lando app start` runs" can invoke these directly without parsing argv or pulling OCLIF into their bundle. Function names in the library API mirror the canonical command id (`app:start` → `appStart`, `meta:plugin:add` → `metaPluginAdd`); the namespace prefix is preserved in the function name so it's unambiguous which canonical command a host is calling.

```ts
import { Effect } from "effect";
import { makeLandoRuntime } from "@lando/core";
import { appStart, appInfo, appStop, metaConfig } from "@lando/core/cli";

const runtime = makeLandoRuntime({ bootstrap: "app", cwd: process.cwd(), plugins: { layers: [...] } });

const program = Effect.gen(function* () {
  yield* appStart({ reconcile: false });
  const info = yield* appInfo({ deep: true });
  console.log(JSON.stringify(info, null, 2));
  yield* appStop({});
});

await Effect.runPromise(program.pipe(Effect.provide(runtime), Effect.scoped));
```

**Required behaviors:**

- Every built-in command in §8.2 has a corresponding exported Effect-returning function in `@lando/core/cli` except the installation/interactive diagnostics commands explicitly listed below. The function's input is an Effect-Schema-validated subset of the command's flags/args; its output is a typed result (the same data the CLI's renderer would format).
- Function names follow `<namespace><PascalSegments…>` (e.g., `appStart`, `appsList`, `appsPoweroff`, `metaPluginAdd`). Top-level CLI aliases (`lando start` for `app:start`) do **not** create a separate library export; hosts call `appStart` directly.
- Sub-commands of `app config` and `meta config` (§8.2.1, §8.2.2) are exposed as nested function namespaces: `appConfig.get`, `appConfig.set`, `appConfig.unset`, `appConfig.view`, `metaConfig.get`, `metaConfig.set`, etc.
- These functions DO NOT touch `process.stdin`/`stdout`/`stderr` and DO NOT call OCLIF. Output is in the return value; logs go through the active `Logger`; rendering is the host's choice.
- Functions are pure Effect and inherit the runtime's services via the requirements channel. Hosts compose them like any other Effect.
- The compiled `lando` binary uses these same functions internally — there are no two implementations of "what `app:start` does."
- Tooling commands (Landofile-defined Lando tasks) are accessed via `@lando/core/cli`'s `runTooling(canonicalId, input)` function, which compiles and executes the cached `ToolingProgram` graph (§8.6). `canonicalId` is the namespaced id (e.g., `app:composer`, `app:db:wait`). The library API accepts the same args, flags, raw argv, vars, and stdio abstractions as the CLI path but does not depend on OCLIF.
- Config translators are accessed through `appConfig.translate`, `appConfig.detectTranslators`, and `appConfig.listTranslators`. These functions run translators explicitly, return the generated Landofile fragment plus diagnostics, and apply writes only when requested by the host.

**Not exported as functions:**

- `meta:setup` (interactive; host should construct equivalent flows from `@lando/core/services` and `PrivilegeService`).
- `apps:init` (interactive; uses `InitSource` plugins; host should drive `InitSource` directly if needed).
- `meta:events:follow` (diagnostic stream over CLI event traces; hosts should subscribe to `EventService` directly).
- `meta:shellenv` (CLI-installation concern, not runtime behavior).
- `meta:uninstall` (CLI-installation concern, not runtime behavior).

These are deliberate omissions; their CLI implementations call several primitives that hosts can compose themselves.

### 16.8 Testing

`@lando/core/testing` is the supported test surface for both core's own tests and embedding hosts.

Provided test fixtures (illustrative):

| Fixture | Purpose |
|---|---|
| `TestRuntime` | A pre-composed `Layer` with in-memory `FileSystem`, in-memory `ProcessRunner`, mock `RuntimeProvider`, and a `TestEventService` bus that records all published events. |
| `TestRuntimeProvider` | A `RuntimeProvider` Layer that satisfies the contract suite (§13.1) without running any real provider. State is in-memory and inspectable. |
| `withLandofile(yamlOrObject)` | Helper that injects a virtual Landofile into the in-memory `FileSystem` and returns a Layer that overrides `LandofileService.discover`. |
| `expectEvent(name, predicate)` | Awaits an event matching the predicate; fails the test with a useful diff if it doesn't arrive within a timeout. |
| `recordedEvents()` | Returns the full event log captured during the test, for snapshot assertions. |
| `TestClock` / `TestRandom` | Re-exports of Effect's testing primitives, plumbed through the runtime. |

```ts
import { test, expect } from "bun:test";
import { Effect } from "effect";
import { TestRuntime, withLandofile, expectEvent } from "@lando/core/testing";
import { appStart } from "@lando/core/cli";

test("starting an app emits post-start", async () => {
  const program = Effect.gen(function* () {
    yield* appStart({ reconcile: false });
    yield* expectEvent("post-start", (e) => e.app.name === "demo");
  });

  await Effect.runPromise(
    program.pipe(
      Effect.provide(withLandofile({ name: "demo", services: { app: { type: "lando" } } })),
      Effect.provide(TestRuntime),
      Effect.scoped,
    ),
  );
});
```

**Required behaviors:**

- `TestRuntime` MUST satisfy every default service tag in §3.4 with a deterministic, in-memory implementation.
- `TestRuntime` MUST NOT touch the host filesystem outside an explicit override.
- `TestRuntime` MUST NOT make network calls.
- The provider contract suite in `@lando/sdk/test` (§13.1) MUST pass against `TestRuntimeProvider`. This anchors the in-memory provider to the same contract real providers must satisfy.
- `@lando/core/testing` ships JSDoc on every export so editor hover documents the fixture in-place.

### 16.9 Versioning and compatibility

- `@lando/core` follows strict semver (§13.7). The public API surface (§16.2) is the only thing that bounds the major. Internal modules MAY change between patches.
- Hosts pin a major (`"@lando/core": "^4.0.0"`). Patch and minor bumps are safe.
- Plugin compatibility (the `requires."@lando/core"` field in plugin manifests, §9.4) governs plugin loading. A host that contributes plugins in `plugins.layers` is responsible for keeping them aligned with its core version; a host that uses `plugins.manifests` benefits from automatic compatibility checks at plugin load.
- Schema versioning: every schema includes a discriminated `apiVersion` or equivalent; round-trip encode/decode is part of the schema gates (§13.2). Hosts that persist plan caches across core versions MUST consult the cache's version header (§12.2).
- The `@lando/core/testing` API is unstable on `stable` channel until v4.0.0 GA. It is published on `next` and `dev` (§13.7) for early adopters.

### 16.10 Non-goals

The following are explicitly out of scope for v4.0.0 embedding:

- **Promise/async facade.** Hosts use Effect. Wrapping the entire surface in Promises is rejected for the reasons in §16.2; the host is free to write its own facade.
- **Synchronous API.** Every public method is asynchronous and Effect-typed.
- **Browser support.** `@lando/core` is a Bun-only package. There is no isomorphic browser build; Bun primitives (`Bun.spawn`, `Bun.file`) and Effect's Bun integration are required.
- **Node compatibility.** Lando v4 requires Bun. Running `@lando/core` under Node is unsupported. The plugin loader's CommonJS interop layer (§9.2) does not extend to running core itself under Node.
- **Driving multiple cores in one process.** Multiple `makeLandoRuntime` instances MAY coexist in one process for testing and orchestration, but cross-runtime resource sharing (e.g., one runtime borrowing another's plugin registry) is unsupported.
- **Hot-reloading plugins inside a running runtime.** The runtime is built once per scope. To change the plugin set, close the scope and construct a new runtime.
- **Stable internal access.** Anything not in §16.2 is internal. Hosts that import from `dist/` paths or use `// @ts-ignore` to reach internals are unsupported and may break on patch upgrades.
- **Replacing the EventService.** `EventService` is a fixed primitive of the runtime, not a pluggable abstraction. Hosts subscribe; they do not provide alternatives.

---
