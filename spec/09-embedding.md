# Lando v4 — Embedding and Library Use

> **Part 9 of 18** · [Index](./README.md)
> **Read next:** [10 Plugins](./10-plugins.md)

An embedding host is a Bun program that uses the same Effect runtime, planner, providers, plugins, and lifecycle bus as the CLI (§3.6), with resource lifetime owned by `Scope`.

---

## 16. Embedding and Library Use

### 16.1 Concept and use cases

Embedding is first-class for:

| Use case | Supported purpose |
|---|---|
| Test frameworks | Provision, inspect, execute in, and scope-teardown apps. |
| CI and automation | Plan, validate, and apply Landofiles without invoking the binary. |
| IDE/editor extensions | Subscribe to events, query state, and drive lifecycle operations. |
| Web UIs and dashboards | Expose typed Lando operations through a host transport. |
| Custom CLIs and wrappers | Pair core with curated plugins and host-owned UX. |
| Monorepo orchestrators | Drive multiple apps within one fiber tree. |
| Config translation tools | Explicitly invoke contributed translators and emit v4 authoring fragments. |

Hosts MUST use core’s provider registry rather than wrapping Docker or Podman directly. They MAY replace abstractions declared pluggable in §4, but non-pluggable service contracts remain private. Parsing CLI output is not an embedding API.

### 16.2 Public API surface

The public API is Effect-native only. There is no Promise facade, synchronous wrapper, or parallel Effect-hiding API; hosts run Effects only at their outer boundary and retain typed successes, failures, streams, causes, and scopes.

| Entry point | Stable surface |
|---|---|
| `@lando/core` | `makeLandoRuntime`, `openLandoRuntime`, `resolveApp`, `LandoRuntimeOptions`, `LandoRuntimeServices`, `LandoRuntime`, `BootstrapLevel`, `App`, `AppSelector`, `AppResolveError`. |
| `@lando/core/services` | Public service tags from §3.4, including registries, planning, lifecycle, IO, rendering, interaction, redaction, telemetry, diagnostics, host-proxy, tunnel, and MCP services plus §4.2 pluggable tags. |
| `@lando/core/paths` | `resolveLandoRoots`, `makeLandoPaths`, `normalizeHostPlatform`, `LandoRoots`, `LandoPaths`, and `RootOverrides` (§7.5.1). |
| `@lando/core/schema` | Published schemas from §7.8. |
| `@lando/core/landofile` | `emitLandofileYaml`, `emitLandofileYamlEither`, `parseLandofile`, and `LandofileEmitError` (§7.8.1). |
| `@lando/core/secrets` | `createRedactor`, `createSecretRedactor`, `RedactionProfile`, the canonical pattern catalog, and `REDACTED` (§3.7). |
| `@lando/core/errors` | Published tagged errors. |
| `@lando/core/events` | `EventService`, event schemas, priority bands, and standard sequences. |
| `@lando/core/cli` | Programmatic built-in command operations (§16.7). |
| `@lando/core/testing` | Supported deterministic test fixtures (§16.8). |
| `@lando/core/docs/components` | Executable-guide JSX/Astro runtime and AST helpers (§19.3); unstable until GA. |
| `@lando/core/docs/redactions` | Canonical transcript redactions (§19.6); unstable until GA. |

The removed `@lando/core/oclif` adapter is not public. Anything not listed above is internal and MAY change between patch versions. Public schema types are inferred from schemas; parallel hand-written public types MUST NOT be introduced. The renderer, event, subscriber, and plugin-context additions named in §8.9 and §9 remain additive compatibility-governed SDK surfaces. `RemoteSource` and `Dataset` remain contract-only for Beta 1, do not sync application code, and are deferred to the 4.1 feature wave (§10.12).

### 16.3 The `LandoRuntime` factory

`makeLandoRuntime(options)` returns one scoped Layer satisfying the requested runtime services. Its options name `bootstrap`, `cwd`, `plugins`, `config`, `overrides`, `logger`, `renderer`, `interaction`, `telemetry`, `cacheRoot`, `installSignalHandlers`, and optional `scratch` acquisition (§21).

Required behavior:

- Options MUST be schema-validated, and bootstrap failures MUST remain tagged by stage.
- Each call MUST create an independent cache, plugin registry, and event bus.
- Construction MUST NOT mutate environment variables, current working directory, or signal handlers unless `installSignalHandlers` is true.
- Bootstrap MUST follow §3.2 through the selected level and emit the same lifecycle events as the CLI.
- The outer `Scope` owns all runtime resources and teardown.
- Host overrides MAY replace only §4 pluggable abstractions and take precedence over defaults.
- Library defaults are `bootstrap: app`, `silent` logging, `json` rendering, non-interactive prompts, host-provided plugins only, telemetry enabled unless disabled, and no signal handlers. App bootstrap requires an authoritative cwd. Unanswered non-interactive prompts fail fast (§8.10.3).

`openLandoRuntime(options)` acquires one runtime in the caller’s scope and returns retained methods `app`, `scratch`, and `run`. It MUST NOT reacquire the runtime per call.

`resolveApp(selector)` is the Layer-native equivalent of `runtime.app(selector)`. Selector precedence is `id` > `landofile` > `root` > `cwd`; lower-precedence fields MAY accompany a selector only when they validate against it. Unknown ids and mismatches fail with `AppResolveError`. A decoded Landofile MUST include an authoritative root. Resolution MUST use retained roots and cwd, never a later ambient `process.cwd()`. With no selector, resolution uses the runtime cwd or its configured scratch app.

The returned opaque, SDK-published `App` handle captures app identity and runtime services. Hosts consume handles and MUST NOT implement them structurally.

| `App` member | Contract |
|---|---|
| `id`, `ref`, `root`, `plan` | Stable app identity, root, and planned state. |
| `start`, `stop`, `restart`, `rebuild`, `destroy` | Typed lifecycle operations. |
| `info` | Typed app and service information. |
| `exec`, `tooling`, `logs` | Scoped execution and streaming operations. |
| `share`, `shareList`, `shareStop` | Scoped or detached tunnel operations (§10.2.2). |
| `pull`, `push`, `remote` | Frozen remote-sync contract; connector wiring is deferred to 4.1 (§10.12). |
| `config`, `events` | App-scoped configuration and lifecycle access. |

Inputs are option objects. One-shot methods require no runtime services after binding; live resources and subscriptions retain `Scope.Scope`. Typed Effects are returned directly, not renderer envelopes. `app.start()` is managed by default; detached behavior requires explicit opt-in.

**Runtime reuse is the required performance shape for long-lived hosts.** Hosts SHOULD acquire one runtime at the lowest sufficient bootstrap level, reuse it across sequential programs, and close it only at host shutdown. Reuse avoids repeated bootstrap, discovery, and cache loading and is the basis of the §2.1 hot-path budgets. Isolation-sensitive tenants or tests use separate roots and runtimes. Hosts driving many scratch apps SHOULD reuse one non-scratch runtime and call `runtime.scratch` (§21.12).

### 16.4 Plugin behavior in library mode

Library runtimes discover no plugins by default. Hosts explicitly contribute direct Layers, pre-resolved manifests and entries, or independently enable bundled, system, user, and app discovery.

- All sources form one contribution graph under §4.3 precedence and §9 conflict rules.
- Direct Layers and manifests MAY be mixed; manifest contributions outrank raw Layers only through declared selection metadata.
- Bundled discovery uses statically included modules. System, user, and app discovery use validated external imports and require external imports to be enabled.
- `disable` applies last and removes a plugin regardless of source.
- Requesting a provider without contributing or discovering one MUST fail with `NoProviderInstalledError`.
- CLI mode enables bundled, system, user, and app discovery; library mode defaults each to false.

### 16.5 Configuration in library mode

Configuration precedence is built-in defaults, optional user configuration, optional environment overrides, host `config`, then the Landofile at app bootstrap. Host configuration is schema-validated and invalid values fail with `ConfigError`.

Hosts MAY skip user configuration and environment input for hermetic operation. Multiple runtimes in one process MUST use distinct environment prefixes and SHOULD use isolated cache, configuration, data, and plugin roots.

### 16.6 Lifecycle and scopes

Bootstrap, event order, payload schemas, subscriber priorities, and subscriber failure policy are identical in CLI and library modes (§3.2, §11). Event subscriptions complete when their runtime scope closes; hosts MUST scope or supervise subscriber fibers.

- `makeLandoRuntime` returns a scoped Layer and MUST run under a scope-bearing context.
- Provider connections, watchers, streams, listeners, and plugin handles belong to that scope and finalize in LIFO order.
- Interruption MUST propagate through provider operations and finalize the runtime.
- An `App` handle owns a child scope for managed start-state resources. `stop`, `restart`, `destroy`, or outer runtime closure ends it. Repeated managed starts are idempotent unless options request plan-changing reconciliation.
- Configured scratch apps are materialized in runtime scope and destroyed when it closes (§21). Imperatively acquired scratches retain their returned scope contract.

Hosts MAY register programmatic event subscribers, but manifest-declared subscribers are the recommended extension path. `EventService` itself is not replaceable.

### 16.7 Programmatic CLI invocation

App lifecycle hosts SHOULD use `App` methods. `@lando/core/cli` is the stable command-shaped surface for hosts needing canonical ids, argv policy, schema-validated command input, renderer-independent typed results, or the same native dispatch behavior as the binary (§8.4.1).

- Built-in commands in §8.2 expose Effect operations except installation and interactive diagnostics explicitly omitted below.
- Direct export names follow namespace plus Pascal-cased segments; top-level CLI aliases do not create duplicate exports.
- `appConfig` and `metaConfig` expose their subcommands as nested function namespaces.
- Operations MUST NOT access process stdio or invoke OCLIF. They inherit runtime services through the Effect requirements channel.
- The binary MUST use the same operations; there is no second implementation.
- `runTooling(canonicalId, input)` invokes cached tooling programs with the CLI’s normalized input semantics (§8.6).
- `appConfig.translate`, `appConfig.detectTranslators`, and `appConfig.listTranslators` invoke translation only on explicit request and write only when requested.

`meta:setup`, `apps:init`, `meta:events:follow`, `meta:shellenv`, and `meta:uninstall` are not exported as command functions. Hosts compose their underlying services, provide `InteractionService` for init, subscribe to `EventService`, or keep installation concerns outside the runtime as applicable.

### 16.8 Testing

`@lando/core/testing` is supported for core and embedding hosts.

| Export | Contract |
|---|---|
| `TestRuntime` | Deterministic runtime satisfying every default §3.4 service with in-memory implementations. |
| `provideTestRuntime` | Builds a test runtime with explicit service overrides. |
| `TestRuntimeProvider` | Inspectable in-memory provider satisfying the §13.1 provider contract suite. |
| `TestManagedFileStore` | In-memory managed-file fixture. |
| `TestHttpClient` | Seeded, recording, redacting HTTP fixture with no network access. |
| `TestDownloader` | Checksum-addressed in-memory artifact fixture. |
| `withLandofile` | Injects decoded or textual Landofile input into the test runtime. |
| `expectEvent` | Asserts that a matching event arrives. |
| `waitForEvent` | Typed composable wrapper over `EventService.waitFor`. |
| `TestInteractionService` | Supplies seeded answers, records prompts, and never reads stdin. |
| `recordedEvents` | Returns captured redacted lifecycle events. |
| `ScenarioContext` | Runtime for executable guides and generated scenarios (§19.4). |
| `TestClock`, `TestRandom` | Effect test primitives wired through the runtime. |

`TestRuntime` MUST NOT touch the host filesystem without an explicit override and MUST NOT make network calls. Every export MUST carry API documentation. `@lando/core/testing` is API-stable on `next` during Beta 1, also ships on `dev`, and joins `stable` at v4.0.0 GA.

### 16.9 Versioning and compatibility

- `@lando/core` follows strict semver (§13.7); listed public entry points bound the major version.
- Hosts pin a compatible major; patch and minor releases are non-breaking.
- Manifest plugins are compatibility-checked through `requires."@lando/core"`; hosts supplying raw Layers own compatibility.
- Persisted schemas and caches carry version discriminators; hosts retaining caches across versions MUST honor §12.2.
- Docs component/redaction entry points remain unstable until GA; the core runtime, services, schema, errors, events, paths, landofile, and CLI entry points are semver-stable within a major.

### 16.10 Non-goals

v4.0.0 does not provide a Promise facade, synchronous API, browser build, Node runtime compatibility, cross-runtime resource sharing, plugin hot reload, stable access to unlisted internals, or a replaceable `EventService`. Multiple isolated runtimes MAY coexist, but changing a plugin set requires closing and rebuilding its runtime scope.

---
