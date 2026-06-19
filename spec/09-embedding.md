# Lando v4 — Embedding and Library Use

> **Part 9 of 18** · [Index](./README.md)
> **Read next:** [10 Plugins](./10-plugins.md)

This part defines embedding Lando v4 as a library from another Bun program. The CLI (§8) is one imperative shell over the runtime; an embedding host is another (§3.6). Both build the same `LandoRuntimeLive` Layer, run Effect programs against it, and tear down through `Scope`.

Covered here: what counts as an embedding host and which use cases are first-class, the `@lando/core` package surface and entry-point boundaries, the Effect-native public API (no Promise facade), the `makeLandoRuntime` Layer factory, the `openLandoRuntime` object wrapper, the stable `App` handle primitive, plugin behavior in library mode (host-controlled by default; opt-in to standard discovery), bootstrap-level and lifecycle semantics for embedding hosts, resource ownership and `Scope` discipline, programmatic invocation of CLI command logic, the testing API surface, version compatibility, and the explicit non-goals.

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

The public API is **Effect-native only**. There is no Promise/async facade, synchronous wrapper, or parallel Effect-hiding surface. Hosts compose Effect programs with `Effect.gen`, run them with `Effect.runPromise` / `Effect.runFork` at the host's outer boundary, and propagate `Cause`/`Exit` through the host's preferred error story.

Public API surfaces (all exported from `@lando/core` per §2.7):

| Surface | Entry point | What it exports |
|---|---|---|
| Runtime factory + App handles | `@lando/core` | `makeLandoRuntime`, `openLandoRuntime`, `resolveApp`, `LandoRuntimeOptions`, `LandoRuntimeServices`, `LandoRuntime`, `BootstrapLevel`, `App`, `AppSelector`, `AppResolveError` |
| Service tags | `@lando/core/services` | `ConfigService`, `PathsService`, `LandofileService`, `PluginRegistry`, `CommandRegistry`, `ConfigTranslatorRegistry`, `TemplateEngineRegistry`, `TemplateRenderer`, `RuntimeProviderRegistry`, `AppPlanner`, `EventService`, `CacheService`, `StateStore`, `FileSystem`, `ProcessRunner`, `ShellRunner`, `BunSelfRunner`, `HttpClient`, `Downloader`, `PrivilegeService`, `EmbeddedAssetService`, `Logger`, `Renderer`, `InteractionService`, `RedactionService`, `Telemetry`, `DeprecationService`, `DoctorService`, `HostProxyService`, `TunnelService`, plus pluggable abstraction tags (§4.2) |
| Paths | `@lando/core/paths` | `resolveLandoRoots`, `makeLandoPaths`, `normalizeHostPlatform`, and the `LandoRoots` / `LandoPaths` / `RootOverrides` types — the Effect-free root/path resolver (§7.5.1). OCLIF-free and runtime-free, so hosts can resolve roots before constructing a runtime |
| Schemas | `@lando/core/schema` | Every schema in §7.8 (Landofile, ServiceConfig, expression AST/errors, ToolingConfig, ToolingInclude, RouteConfig, HealthcheckConfig, plugin manifest, event payloads, etc.) |
| Landofile serializer | `@lando/core/landofile` | `emitLandofileYaml`, `emitLandofileYamlEither`, `parseLandofile`, `LandofileEmitError` — the canonical block-style Landofile serializer pair (§7.8.1). Re-export of the pure `@lando/sdk/landofile` logic; hosts and config-translator plugins use it to emit, preview, and test Landofile fragments. |
| Secret redaction | `@lando/core/secrets` | Re-export of `@lando/sdk/secrets` (§3.7): `createRedactor`, `createSecretRedactor`, the `RedactionProfile` literal, the canonical pattern-class catalog, and the `REDACTED` sentinel. Pure and runtime-free — a host can redact log/diagnostic output for its own UI with the same coverage core uses, and the `RedactionService` tag supplies the live secret set when the host wants profile-driven redaction wired to the active `SecretStore`. |
| Tagged errors | `@lando/core/errors` | Every `Schema.TaggedError` subclass declared in `src/errors/tagged.ts` |
| Lifecycle | `@lando/core/events` | `EventService` (re-exported), event payload schemas, subscriber priority bands, the standard event sequence |
| Programmatic CLI | `@lando/core/cli` | Wrappers for invoking built-in command logic without OCLIF (§16.7) |
| Testing | `@lando/core/testing` | Test-Layer fixtures, in-memory `FileSystem` and `ProcessRunner`, `TestRuntimeProvider`, the `ScenarioContext` test runtime for executable guides and generated scenarios (§19.4), helpers for asserting against `Stream`s and `EventService` (§16.8) |
| Docs components | `@lando/core/docs/components` | JSX/Astro runtime + AST helpers for the executable-guide/scenario component vocabulary (`Guide`, `Scenario`, `Step`, `Run`, `Verify`, `Inspect`, `Hidden`, `Cleanup`, `Variable`, `Skip`, `Inline`, `UseFixture`, `Tabs`, `Tab`); contracts (prop schemas, frontmatter, `MatcherSchema`, `Transcript`, `TranscriptFrame`, `TabAxis`, `TabAxisValue`) live in `@lando/sdk/docs/components` (§19.3). |
| Docs redactions | `@lando/core/docs/redactions` | Re-export of the canonical transcript redaction list owned by `@lando/sdk/docs/redactions` (§19.6); consumed by both the docs build and the test-time transcript writer. |
| OCLIF adapter | `@lando/core/oclif` | The OCLIF-specific glue. Hosts MUST NOT import this unless they are building an alternate CLI distribution. |

Stability rules:

- The default entry (`@lando/core`), `@lando/core/services`, `@lando/core/schema`, `@lando/core/errors`, `@lando/core/events`, `@lando/core/paths`, `@lando/core/landofile`, and `@lando/core/cli` are **semver-stable** within a major version. Breaking changes bump the major. `@lando/core/landofile` re-exports the pure `@lando/sdk/landofile` serializer (§7.8.1); the `LandofileEmitError` it adds rides the subpath, not the frozen `@lando/core/errors` barrel.
- `@lando/core/testing` is API-stable and supported on the `next` channel for Beta 1; it is also published on `dev`, and it still follows §13.7 channel promotion, so it is not published on the `stable` release channel until v4.0.0 GA. After GA it follows the standard semver rule.
- `@lando/core/docs/components` is unstable until v4.0.0 GA; published only on the `next` and `dev` channels (§13.7). After GA it follows the standard semver rule.
- `@lando/core/docs/redactions` is unstable until v4.0.0 GA; published only on the `next` and `dev` channels (§13.7). After GA it follows the standard semver rule.
- `@lando/core/oclif` is **internal**. It is exported only because the OCLIF compiled-binary build needs it; embedding hosts MUST NOT import it. Tests enforce the boundary.
- Any symbol not listed above is internal and may change between patch versions.

### 16.3 The `LandoRuntime` factory

`makeLandoRuntime` returns an Effect `Layer` that an embedding host provides to its program. The factory accepts a typed options bag; every option has a documented default that mirrors the CLI's behavior, except where noted.

```ts
import { Context, Effect, Layer, Schema, Scope } from "effect";
import {
  makeLandoRuntime,
  type LandoRuntimeServices,
  AppPlanner,
  RuntimeProviderRegistry,
  LandofileService,
} from "@lando/core";

const runtime: Layer.Layer<LandoRuntimeServices, LandoRuntimeBootstrapError, Scope.Scope> =
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

  // Interaction policy (§8.10). Default mode = "non-interactive" in library mode (CLI = "auto").
  // A host MAY pass "auto"/"interactive" to opt into terminal prompting, or override the
  // InteractionService entirely via `overrides` to route prompts through its own transport.
  interaction: Schema.optional(Schema.Literal("auto", "interactive", "non-interactive")),

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

**Runtime reuse for performance.** A single runtime Layer acquisition or retained `LandoRuntime` object MAY be reused across many sequential Effect programs by the same host. This is the **recommended pattern** for embedding hosts that perform repeated small operations — TUIs, dashboards, IDE/editor extensions, long-lived web servers, monorepo orchestrators driving dozens of apps — and is the perf shape that closes the gap between transactional CLI invocations and the deferred persistent-agent decision (§14.2):

- Build the runtime once at host startup at the **lowest** `bootstrap` level the host needs (e.g., `tooling` for an editor extension that only triggers cached tooling tasks; reserve `app` for hosts that genuinely need full app planning).
- Provide it to every program with `Effect.provide` and run each program with `Effect.runPromise` / `Effect.runFork` against the same Layer instance.
- Close the host's outer scope only when the host shuts down.

Reuse skips bootstrap, plugin discovery, AOT layer instantiation, and cache loading on every operation past the first; in a warm host, sequential operations pay only the per-operation work the program itself does. The §2.1 hot-path budgets are written assuming this reuse pattern: an embedding host that constructs a fresh runtime per operation MUST budget for cold-start latency every time, while one that reuses a runtime hits the hot column. The library-API contract suite (§13.1) gates this with a reuse-mode perf test that asserts operations 2..N each meet the §2.1 hot budget at p95 against a single retained runtime.

Hosts that need *isolation* across operations (per-request isolation in a multi-tenant server, parallel-test isolation, scenarios that mutate `<userCacheRoot>`) construct multiple runtimes per §16.5's cache-root override. The two patterns are not in tension — the host picks one per logical context.

The bundled `HostProxyServiceLive` (§10.10) is itself an embedding host: it constructs one retained runtime acquisition at `app:start`, holds it in scope until `app:stop`, and dispatches every inbound `runLando` RPC through `@lando/core/cli` (§16.7) against that retained runtime. Hosts building an alternate `HostProxyService` MUST follow the same pattern so the in-container `lando` shim hits hot-path budgets on all calls past the first.

**Difference from CLI defaults:**

| Concern | CLI default | Embedding default |
|---|---|---|
| `logger` | `pretty` (TTY) / `json` (non-TTY) | `silent` |
| `renderer` | `lando` | `json` |
| `interaction` | `auto` (prompt when stdin is a TTY) | `non-interactive` (§8.10.3; unanswered prompts fail fast) |
| Plugin discovery | bundled + system + user + app | host-provided only (§16.4) |
| Telemetry | per global config, enabled by default | enabled by default unless `telemetry: false` or config disables reporting |
| Signal handlers | installed | not installed |
| `bootstrap` per command | declared by command | required option |

These differences are deliberate: an embedded host should be quiet and predictable by default, then opt into CLI-like behavior explicitly.

**App handle convenience API.** `makeLandoRuntime` remains the low-level Layer factory and is the right primitive for hosts that want to provide runtime services to arbitrary Effect programs. Most hosts that want to drive one resolved app use the stable `App` handle instead. The public type is named `App`; "App handle" describes its behavior and scope ownership rather than a separate exported `AppHandle` interface. The canonical contract types are published by `@lando/sdk` and re-exported by `@lando/core`; `@lando/core` owns the implementations returned by `openLandoRuntime` and `resolveApp`.

```ts
import { Effect } from "effect";
import { openLandoRuntime } from "@lando/core";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* openLandoRuntime({
        bootstrap: "app",
        cwd: process.cwd(),
        plugins: { discovery: { bundled: true } },
      });

      const app = yield* runtime.app({ cwd: process.cwd() });
      yield* app.start({ reconcile: false });
      const info = yield* app.info({ deep: true });
      yield* app.stop({});

      return info;
    }),
  ),
);
```

`openLandoRuntime(options)` acquires one runtime Layer inside the caller's `Scope` and returns an object whose methods are already bound to that retained runtime. It MUST NOT reacquire the scoped Layer per method call. The object exposes:

```ts
export interface LandoRuntime {
  readonly app: (selector?: AppSelector) => Effect.Effect<App, AppResolveError>;
  readonly scratch: (input: ScratchAcquireInput) => Effect.Effect<ScratchHandle, ScratchAcquireError, Scope.Scope>;
  readonly run: <A, E, R>(program: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, LandoRuntimeServices>>;
}
```

`resolveApp(selector)` is the Layer-native equivalent for hosts that already provide `makeLandoRuntime(...)` themselves. It resolves the app once, captures the app root and plan identity in the handle, and returns an `App` whose one-shot methods require no runtime services from the caller:

```ts
export type AppSelector =
  | { readonly id: string; readonly root?: AbsolutePath; readonly cwd?: AbsolutePath }
  | { readonly landofile: AbsolutePath; readonly root?: AbsolutePath; readonly cwd?: AbsolutePath }
  | { readonly landofile: LandofileShape; readonly root: AbsolutePath; readonly cwd?: AbsolutePath }
  | { readonly root: AbsolutePath; readonly cwd?: AbsolutePath }
  | { readonly cwd: AbsolutePath };

export interface App {
  readonly id: string;
  readonly ref: AppRef;
  readonly root: AbsolutePath;
  readonly plan: Effect.Effect<AppPlan, AppResolveError>;
  readonly start: (options?: StartAppOptions) => Effect.Effect<StartAppResult, StartAppError>;
  readonly stop: (options?: StopAppOptions) => Effect.Effect<StopAppResult, StopAppError>;
  readonly restart: (options?: RestartAppOptions) => Effect.Effect<RestartAppResult, RestartAppError>;
  readonly rebuild: (options?: RebuildAppOptions) => Effect.Effect<RebuildAppResult, RebuildAppError>;
  readonly destroy: (options?: DestroyAppOptions) => Effect.Effect<DestroyAppResult, DestroyAppError>;
  readonly info: (options?: InfoAppOptions) => Effect.Effect<InfoAppResult, InfoAppError>;
  readonly exec: (options: ExecAppOptions) => Effect.Effect<ExecAppResult, ExecAppError, Scope.Scope>;
  readonly share: (options?: ShareAppOptions) => Effect.Effect<TunnelSession, TunnelError, Scope.Scope>;
  readonly shareList: (filter?: TunnelSessionFilter) => Effect.Effect<ReadonlyArray<TunnelSession>, TunnelError>;
  readonly shareStop: (request: TunnelStopRequest) => Effect.Effect<void, TunnelError>;
  readonly tooling: (id: string, options?: ToolingOptions) => Effect.Effect<ToolingResult, ToolingError, Scope.Scope>;
  readonly logs: (options?: LogsAppOptions) => Stream.Stream<LogChunk, LogsAppError, Scope.Scope>;
  readonly config: AppConfigApi;
  readonly events: AppEventsApi;
}
```

`AppSelector` precedence is `id` > `landofile` > `root` > `cwd`. Passing more than one selector field is allowed only when the higher-precedence field can be validated against the lower-precedence field; a mismatch fails with `AppResolveError`. `cwd` follows the normal Landofile discovery walk from the retained runtime `cwd`, never from a later ambient `process.cwd()` after the handle has been created. `root` resolves a Landofile from an already-known app root and MUST NOT re-walk from the host's current working directory on later handle method calls. `landofile` accepts either an explicit file path or an already-decoded `LandofileShape`; a decoded `LandofileShape` MUST be paired with an explicit validated `root` so relative includes, mounts, tooling, and file reads have one authoritative base directory. `id` resolves through the app registry/cache when available and fails with a tagged `AppResolveError` when the id is unknown at the selected bootstrap level. A missing selector (`runtime.app()` or `resolveApp()`) resolves from the retained runtime `cwd`; if the runtime was constructed with the `scratch` option, the missing selector resolves to that acquired scratch app instead.

The `App` contract is SDK-published and the implementation returned by core is opaque/branded. Embedding hosts consume `App` values returned by `resolveApp`/`runtime.app`; they do not implement the interface structurally. This keeps future method additions non-breaking inside the 4.x line while preserving the `@lando/sdk` = contracts/types and `@lando/core` = implementations split.

Method inputs are option objects, never positional arguments. One-shot methods (`start`, `stop`, `info`, config reads/writes, `shareList`, `shareStop`, etc.) have `R = never` after binding because the handle already carries the runtime. Methods that expose live resources or subscriptions (`exec`, foreground `share`, `tooling`, `logs`, `events.subscribe`) keep `Scope.Scope` in `R` so the host owns the subscription lifetime. Detached share sessions return after the session is recorded in the `TunnelService` registry; foreground share sessions stay bound to the caller's scope exactly like foreground CLI `lando share`. The stable API returns typed Effect successes and tagged failures directly; it does not expose the internal command-operation `{ ok, value | error }` renderer envelope. `app.start()` defaults to `detached: false`; callers must opt into detached start-state explicitly with `app.start({ detached: true })`.

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
- An `App` handle has its own child scope under the runtime scope. `app.start()` and `app.start({ detached: false })` open a managed start scope that survives the `start()` method call, owns start-state resources such as host-proxy/file-sync sessions, and is closed by `app.stop()`, `app.restart()`, `app.destroy()`, or the outer runtime scope finalizer. `app.start({ detached: true })` starts provider resources without registering a start-state finalizer on the handle. Starting an already-managed app is idempotent unless the options request a reconcile/restart operation that changes the plan.
- A host MAY pass `scratch: { source, isolate, shareGlobalStorage }` to `makeLandoRuntime` to acquire a **scratch Lando app** (§21) under the runtime's `Scope`. The scratch is materialized at runtime construction; the runtime's `Scope` finalizer destroys the scratch on close exactly as a foreground CLI `apps:scratch:start` does on Ctrl+C. Hosts that drive many scratches in succession SHOULD reuse a single non-scratch runtime and call `runtime.scratch(input)` per scratch instead of constructing a fresh runtime for each (§21.12). The library-mode reuse-perf rule from §16.3 covers this case: per-scratch acquisition latency stays steady-state when the host reuses one runtime across many `acquire` calls.

### 16.7 Programmatic CLI invocation

The stable app-lifecycle embedding primitive is the `App` handle in §16.3. Embedding hosts that want to "run what `lando app start` runs" SHOULD call `app.start()`, `app.info()`, `app.stop()`, and sibling handle methods rather than naming command-operation functions directly.

`@lando/core/cli` remains the programmatic CLI entry point for hosts that need command-shaped behavior: argv parsing policy, canonical command ids, renderer-independent typed results, and the same dispatch surface used by the source and compiled CLIs. It does not require OCLIF for command effects. Lower-level operation modules such as `@lando/core/cli/operations` are building blocks for `@lando/core/cli`, `runCompiledCli`, and the `App` handle; they are not the preferred stable app-lifecycle API.

```ts
import { Effect } from "effect";
import { openLandoRuntime } from "@lando/core";
import { metaConfig } from "@lando/core/cli";

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* openLandoRuntime({ bootstrap: "app", cwd: process.cwd() });
      const app = yield* runtime.app();

      yield* app.start({ reconcile: false });
      const info = yield* app.info({ deep: true });
      const config = yield* runtime.run(metaConfig.get({ key: "telemetry" }));
      yield* app.stop({});

      return { info, config };
    }),
  ),
);
```

**Required behaviors:**

- Every built-in command in §8.2 has a corresponding exported Effect-returning command operation reachable through `@lando/core/cli` or its documented command-operation submodules except the installation/interactive diagnostics commands explicitly listed below. The operation input is an Effect-Schema-validated subset of the command's flags/args; its output is a typed result (the same data the CLI's renderer would format).
- Command-operation names follow `<namespace><PascalSegments…>` (e.g., `appStart`, `appsList`, `appsPoweroff`, `metaPluginAdd`) where they are exported directly. Top-level CLI aliases (`lando start` for `app:start`) do **not** create a separate library export. Hosts that need app lifecycle call `app.start()` and siblings; hosts that need command-shaped dispatch call the command operation.
- Sub-commands of `app config` and `meta config` (§8.2.1, §8.2.2) are exposed as nested function namespaces: `appConfig.get`, `appConfig.set`, `appConfig.unset`, `appConfig.view`, `metaConfig.get`, `metaConfig.set`, etc.
- These functions DO NOT touch `process.stdin`/`stdout`/`stderr` and DO NOT call OCLIF. Output is in the return value; logs go through the active `Logger`; rendering is the host's choice.
- Functions are pure Effect and inherit the runtime's services via the requirements channel. Hosts compose them like any other Effect.
- The compiled `lando` binary uses these same functions internally — there are no two implementations of "what `app:start` does."
- Tooling commands (Landofile-defined Lando tasks) are accessed via `@lando/core/cli`'s `runTooling(canonicalId, input)` function, which compiles and executes the cached `ToolingProgram` graph (§8.6). `canonicalId` is the namespaced id (e.g., `app:composer`, `app:db:wait`). The library API accepts the same args, flags, raw argv, vars, and stdio abstractions as the CLI path but does not depend on OCLIF.
- Config translators are accessed through `appConfig.translate`, `appConfig.detectTranslators`, and `appConfig.listTranslators`. These functions run translators explicitly, return the generated Landofile fragment plus diagnostics, and apply writes only when requested by the host.

**Not exported as functions:**

- `meta:setup` (interactive; host should construct equivalent flows from `@lando/core/services` and `PrivilegeService`).
- `apps:init` (interactive; uses `InitSource` plugins; host should drive `InitSource` directly if needed). A host that wants the full init flow non-interactively MAY provide an `InteractionService` Layer (or pass `interaction: "non-interactive"` with seeded answers, §8.10) so recipe prompts resolve from supplied answers instead of the terminal.
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
| `TestHttpClient` / `TestDownloader` | In-memory `HttpClient` / `Downloader` Layers that satisfy their §13.1 contract suites without touching the network. `TestHttpClient` returns pre-seeded responses/streams keyed by URL and records issued requests (redacted) for assertions; `TestDownloader` resolves seeded artifacts by checksum. They replace the ad-hoc `fetchImpl` injection the setup, update, file-sync, and runtime-bundle tests used before the egress chokepoint existed. |
| `withLandofile(yamlOrObject)` | Helper that injects a virtual Landofile into the in-memory `FileSystem` and returns a Layer that overrides `LandofileService.discover`. |
| `expectEvent(name, predicate)` | Awaits an event matching the predicate; fails the test with a useful diff if it doesn't arrive within a timeout. Thin wrapper over `EventService.waitFor` (§11.1) with a default test timeout. |
| `waitForEvent(name, options?)` | Lower-level await that mirrors `EventService.waitFor<E>` (typed `name`, optional `filter`/`timeout`) for tests that want to compose the await themselves rather than assert-and-diff. |
| `TestInteractionService` | An `InteractionService` Layer that returns pre-seeded answers (keyed by prompt `name`) and captures the prompt transcript for assertions; never opens stdin. Satisfies the §13.1 interaction contract suite and backs the executable-guide scenario answer flow (§19.4). |
| `recordedEvents()` | Returns the full event log captured during the test, for snapshot assertions. Backed by `EventService.query("*")` over the test runtime's history buffer (§11.1), so it returns the same redacted payloads a host would see. |
| `TestClock` / `TestRandom` | Re-exports of Effect's testing primitives, plumbed through the runtime. |

```ts
import { test, expect } from "bun:test";
import { Effect } from "effect";
import { RuntimeProvider } from "@lando/core/services";
import { TestRuntimeProvider, provideTestRuntime } from "@lando/core/testing";

test("injecting the test provider", async () => {
  const program = Effect.gen(function* () {
    const provider = yield* RuntimeProvider;
    return provider.id;
  });

  const providerId = await Effect.runPromise(
    program.pipe(
      Effect.provide(
        provideTestRuntime({
          bootstrap: "provider",
          with: { RuntimeProvider: TestRuntimeProvider },
        }),
      ),
    ),
  );

  expect(providerId).toBe("test");
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
- The `@lando/core/testing` API is stable and supported on the `next` channel for Beta 1, and is also published on `dev` (§13.7). It is not promoted to the `stable` release channel until v4.0.0 GA.

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
