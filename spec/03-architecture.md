# Lando v4 — Architecture, Lifecycle, and Events

> **Part 3 of 18** · [Index](./README.md)
> **Read next:** [04 Pluggability](./04-pluggability.md)

This part defines the runtime structure, bootstrap levels, core services, lifecycle taxonomy, event bus, and imperative shells.

---

## 3. Architecture

### 3.1 Four layers

Dependencies flow downward through four layers; reverse dependencies are forbidden.

| Layer | Responsibility |
|---|---|
| Imperative shell | CLI, embedding host, or test harness; input decoding, signals, output, and exit status |
| Effect runtime | AOT-composed layers, bootstrap orchestration, lifecycle publication, and tagged failures |
| Pluggable abstractions | `@lando/sdk` service tags and Effect Schema contracts, without implementations |
| Plugin implementations | Bun-loadable adapters, including bundled defaults and third-party additions |

The CLI and embedding hosts provide the same generated runtime layers and close them through `Scope`; no separate library-mode runtime, planner, provider, or plugin path exists (§16). Imperative shells, including MCP adapters, MUST NOT own business logic. Runtime layers MUST NOT import shell modules.

### 3.2 Bootstrap flow

The native dispatcher resolves routing metadata before constructing the Effect runtime: it checks the level-`none` fast path, loads embedded and cached command metadata, resolves the canonical command and effective `BootstrapLevel`, provides that level's AOT-composed Layer, then lazily imports and runs the command (§8.4.1, §17.2). The router phase is not a bootstrap level and MUST NOT parse Landofiles, import plugin contributions, initialize providers, construct the full subscriber graph, or run plugin subscribers; it MAY inspect known paths and versioned caches (§12).

Levels form a chain `none` → `minimal` → `plugins` → `commands`; `tooling` and `provider` each extend `commands` (`tooling` never loads a live provider or the full planner); `global` and `scratch` are sibling branches over `provider`; `app` extends `global`.

| Level | Meaning | Service membership |
|---|---|---|
| `none` | Command-base depth with no prebuilt runtime; the fast-path subset skips dispatcher and Effect entirely | none |
| `minimal` | Host configuration and safe local primitives | eager: `PathsService`, `ConfigService`, `FileSystem`, `ProcessRunner`, `EmbeddedAssetService`, `CacheService`, `StateStore`, `EventService`, `DeprecationService`, `RedactionService`, `TemplateEngineRegistry`, `TemplateRenderer`, `HttpClient`, `Downloader`; lazy: `Logger`, `Renderer`, `Telemetry`, `ShellRunner`, `BunSelfRunner`, `InteractionService`, `ManagedFileService` |
| `plugins` | Plugin discovery, manifest validation, and contribution graph | `minimal` + eager `PluginRegistry`, `ConfigTranslatorRegistry`, `DoctorService`, `FileSyncEngineRegistry`; lazy `PrivilegeService`; plugin implementations register here |
| `commands` | Complete native command registry and command-cache refresh | `plugins` + `CommandRegistry` |
| `tooling` | Command services plus cache-only `ToolingProgram` and app-plan access | `commands` + lazy selected `ToolingEngine`; no live provider or full planner |
| `provider` | Provider selection and provider-dependent subsystems | `commands` + eager `RuntimeProviderRegistry`; lazy `CertificateAuthority`, `RouterService`, `DataMover` |
| `global` | Global-app lifecycle (§20) | `provider` + eager `GlobalAppService` and global-root `LandofileService`; lazy `BuildOrchestrator`, `HealthcheckRunner`, `UrlScanner` |
| `scratch` | Scoped scratch-app lifecycle (§21) | `provider` + eager `ScratchAppService` and arbitrary-root `LandofileService`; lazy `AppPlanner`, `BuildOrchestrator`, `HealthcheckRunner`, `UrlScanner`, conditional `HostProxyService`, conditional `GlobalAppService` |
| `app` | Full user-app planning and lifecycle | `global` + eager user-root `AppPlanner` and `LandofileService`; lazy `HealthcheckRunner`, `UrlScanner`, `HostProxyService`, `TunnelService`, `BuildOrchestrator`, and the selected accelerated `FileSyncEngine` |

The `LandoCommandSpec` registry is canonical for command-to-level assignment (§8.3). Levels `minimal` through `app` emit `pre-bootstrap-<level>` and `post-bootstrap-<level>`, followed by `post-bootstrap` and `ready`; `none` emits no events through the command-base path.

**Level-`none` fast path:** `bin/lando.ts` MUST recognize only the fixed static version, top-level help, shellenv, and recipe-list argv shapes before importing the dispatcher, Effect, service tags, or plugin code. It MUST use embedded constants, perform no file or network IO, construct no service, and meet §2.1 budgets. Unrecognized flags MUST fall through to normal dispatch. Dispatcher-routed `none` commands MAY construct their own runtime and then emit events, but MUST NOT rely on command-base bootstrap; load-bearing safe-mode commands such as `meta:doctor` MUST remain exempt from bootstrap promotion.

Bootstrap levels are sequential. Independent IO-bound work within a level MUST run concurrently with Effect concurrency primitives; sequential work is a performance defect unless required by data dependency (§2.4). Tooling routing uses cached command indexes and `ToolingProgram`; provider initialization occurs only when a provider-backed step executes (§12.2, §12.5).

### 3.3 Source layout

```text
core/               public runtime, CLI shells, generated composition, docs/testing exports
engine/             private orchestration runtime, planner, lifecycle, providers, subsystems
sdk/                public schemas, tags, events, errors, and plugin contracts
container-runtime/  provider-neutral container helpers
landofile/          Landofile discovery, merge, expressions, and serialization
managed-file/       managed working-tree writes
paths/              pure root and path resolution
state-store/        durable state
redaction/          canonical redaction implementation
http-client/        outbound HTTP boundary
plugins/            bundled plugin packages
scripts/            codegen and repository gates
test/               cross-package tests
```

### 3.4 Core Effect services

All services are consumed through their tags inside Effect. Core-provided does not imply plugin-replaceable; §4.2 is the canonical replaceability catalog.

| Service tag | Architectural responsibility |
|---|---|
| `ConfigService` | Global config, environment overrides, and staged expression resolution (§7) |
| `LandofileService` | Discover, parse, merge, and validate Landofiles (§7) |
| `PluginRegistry` | Load manifests and assemble the contribution graph (§9) |
| `CommandRegistry` | Register and resolve canonical built-in, plugin, and tooling commands (§8) |
| `ConfigTranslatorRegistry` | Select plugin-contributed external config translators (§4, §7) |
| `TemplateEngineRegistry` | Select template engines; the built-in `lando` engine is always registered |
| `TemplateRenderer` | Render whole files and strings through the selected engine and cache (§7, §12) |
| `FileSyncEngineRegistry` | Select passthrough or accelerated mount realization (§10.6) |
| `ToolingEngine` | Execute compiled tooling programs against a selected target (§8.6) |
| `RuntimeProviderRegistry` | Discover and select the runtime provider (§5) |
| `CertificateAuthority` | Issue and trust development certificates (§10.3) |
| `RouterService` | Realize provider-neutral route plans (§10.2) |
| `HealthcheckRunner` | Run provider or host health probes (§10.5) |
| `UrlScanner` | Scan declared URLs through the canonical probe model (§10.5) |
| `AppPlanner` | Produce provider-neutral service, route, and app plans (§5–§7) |
| `BuildOrchestrator` | Build and execute the `BuildPlan` DAG, lifecycle, cache, transcripts, and progress (§6.13) |
| `EventService` | Typed lifecycle pub/sub, waiting, and bounded history (§11) |
| `CacheService` | Atomic ephemeral cache operations (§12) |
| `StateStore` | Durable, atomic, versioned, schema-validated, lockable state (§12.7); host/test-overridable, never plugin-replaceable |
| `ManagedFileService` | Canonical guarded working-tree writes (§10.13); host/test-overridable, never plugin-replaceable |
| `FileSystem` | Bun-first filesystem boundary |
| `ProcessRunner` | Exact argv subprocess execution through `Bun.spawn` |
| `ShellRunner` | Cross-platform shell-shaped execution through `Bun.$` |
| `BunSelfRunner` | Embedded Bun self-spawn through `BUN_BE_BUN=1` (§2.1) |
| `HttpClient` | Single Lando-owned network-egress boundary (§10.3.2) |
| `Downloader` | Verified artifact acquisition over `HttpClient` (§10.3.3) |
| `DataMover` | Canonical local/volume byte movement and snapshots (§10.11); not plugin-replaceable |
| `PrivilegeService` | Platform elevation boundary |
| `EmbeddedAssetService` | Unified compiled-binary and library asset access; host/test-overridable, never plugin-contributed |
| `PathsService` | Authoritative Lando roots and derived paths (§7.5.1) |
| `Logger` | Structured Effect logging |
| `Renderer` | User-facing output strategy (§8.9) |
| `InteractionService` | Typed prompt and answer-source resolution (§8.10) |
| `DeprecationService` | Record, deduplicate, publish, and query deprecated-surface use (§18) |
| `DoctorService` | Isolated host, app, provider, plugin, and deprecation diagnostics (§10.9) |
| `HostProxyService` | Authenticated per-app container-to-host RPC (§10.10) |
| `TunnelService` | Public sharing sessions; no always-on v4.0 default (§10.2.2) |
| `McpService` | Retained-runtime MCP projection and dispatch (§10.14); not plugin-replaceable in v4.0 |
| `GlobalAppService` | Global app regeneration, planning, lifecycle, and auto-start (§20) |
| `ScratchAppService` | Scoped scratch app acquisition, lifecycle, registry, and reap (§21) |
| `Telemetry` | Non-blocking usage telemetry (§2.4) |
| `RedactionService` | Canonical secret and PII masking (§3.7); never plugin-replaceable |

The replaceability and default Layers for all pluggable tags remain canonical in §4.2. Hosts enumerating runtime services SHOULD combine §3.4 and §4.2.

Use `ProcessRunner` for an exact binary and argv. Use `ShellRunner` for pipes, redirection, globs, substitutions, and portable shell built-ins. Core MUST NOT use either to imitate the other. Both MUST propagate interruption, reap children through `Scope`, publish their pre/post events, and expose only canonically redacted command data. `ShellRunner` MUST use `Bun.$`, escape interpolation by default, require explicit raw interpolation, contain script realpaths to permitted roots, and remain safe at `tooling` bootstrap without network, provider, or plugin initialization. Its failures are `ShellExecError` (non-zero exit unless the caller opts into no-throw semantics), `ShellInterpolationError` (raw interpolation where it is forbidden, with position and remediation), and `ShellRunnerUnavailableError` (the active Live Layer refuses the request).

`BunSelfRunner` MUST self-spawn `process.execPath` with `BUN_BE_BUN=1` and MUST NOT use `PATH` for embedded mode; library mode MAY use host Bun and MUST identify that mode, failing with `BunSelfHostFallbackUnavailableError` (carrying the resolved `process.execPath` and remediation) when neither host nor embedded Bun is available. It MUST prevent recursive self-spawn with `LANDO_DISALLOW_BUN_BE_BUN_REENTRY`, publish pre/post events with redacted data, pass credentials only through environment, propagate interruption, validate verb-specific argv, respect offline mode for uncached external `x` packages, and remain safe at `minimal` without eager network, provider, or plugin work. Executable-guide transcripts MUST observe the same redaction contract.

### 3.5 Lifecycle events

Events are typed, schema-validated, and drawn from a closed registry. Plugin subscribers register declaratively. CLI events use canonical command ids, not aliases. `pre-restart` and `post-restart` MUST bracket the inner stop/start events, which MUST still fire. Resolved tooling extends the valid set with `pre-<tool>` and `post-<tool>`; nested command-event recursion MUST be bounded and report the complete valid-name set on rejection (§8.5.7).

| Scope | Event names |
|---|---|
| Lando | `pre-bootstrap-<level>`, `post-bootstrap-<level>`, `post-bootstrap`, `ready`, `pre-setup`, `post-setup`, `before-exit` |
| App | `pre-init`, `post-init`, `pre-start`, `post-start`, `pre-stop`, `post-stop`, `pre-restart`, `post-restart`, `pre-rebuild`, `post-rebuild`, `pre-destroy`, `post-destroy` |
| Provider | `pre-provider-apply`, `post-provider-apply`, `pre-provider-exec`, `post-provider-exec`, `pre-provider-logs`, `post-provider-logs` |
| Process / shell / network | `pre-process-exec`, `post-process-exec`, `pre-shell-exec`, `post-shell-exec`, `pre-bun-self-exec`, `post-bun-self-exec`, `pre-http-call`, `post-http-call`, `pre-download`, `download-progress`, `post-download` |
| File sync | `pre-file-sync-create`, `post-file-sync-create`, `pre-file-sync-pause`, `post-file-sync-pause`, `pre-file-sync-resume`, `post-file-sync-resume`, `pre-file-sync-terminate`, `post-file-sync-terminate`, `file-sync-conflict-detected`, `file-sync-progress` |
| Host proxy | `pre-host-proxy-call`, `post-host-proxy-call` |
| MCP | `pre-mcp-call`, `post-mcp-call` |
| Open | `pre-open-url`, `post-open-url` |
| Tunnel | `pre-tunnel-start`, `post-tunnel-start`, `tunnel-ready`, `pre-tunnel-stop`, `post-tunnel-stop`, `tunnel-status` |
| Data | `pre-data-transfer`, `data-transfer-progress`, `post-data-transfer`, `pre-volume-snapshot`, `post-volume-snapshot` |
| Managed file | `pre-managed-file-write`, `post-managed-file-write`, `managed-file-conflict-detected`, `managed-file-skipped` |
| Build | `pre-build`, `post-build`, `pre-build-phase`, `post-build-phase`, `build-step-start`, `build-step-progress`, `build-step-complete`, `build-step-skip`, `build-step-fail` |
| Tooling | `pre-<tool>`, `post-<tool>`, `tooling-step-start`, `tooling-step-complete`, `tooling-step-skip`, `tooling-step-fail` |
| CLI | `cli-<canonical-id>-init`, `cli-<canonical-id>-run`, `cli-<canonical-id>-error` |
| Global | `pre-global-start`, `post-global-start`, `pre-global-stop`, `post-global-stop`, `pre-global-rebuild`, `post-global-rebuild`, `pre-global-destroy`, `post-global-destroy`, `pre-global-dist-regenerate`, `post-global-dist-regenerate` |
| Scratch | `pre-scratch-acquire`, `post-scratch-acquire`, `pre-scratch-materialize`, `post-scratch-materialize`, `pre-scratch-start`, `post-scratch-start`, `pre-scratch-stop`, `post-scratch-stop`, `pre-scratch-destroy`, `post-scratch-destroy`, `pre-scratch-gc`, `post-scratch-gc` |
| Sync | `pre-pull`, `post-pull`, `pre-push`, `post-push`, `pre-dataset-fetch`, `post-dataset-fetch`, `pre-dataset-apply`, `post-dataset-apply`, `pre-dataset-capture`, `post-dataset-capture`, `pre-dataset-send`, `post-dataset-send` |
| Cross-cutting | `deprecation-used` |

`LandoEvent` is the closed union of these events and generated CLI lifecycle events. Plugins MUST NOT add schemas, arbitrary names, or wider publish authority; their only publish seam is the closed `RenderEvent` subset (§9.8). For a resolved command, `-init` fires after bootstrap and before the body; exactly one of `-run` or `-error` follows before scope finalization. Unknown commands do not emit `-init`.

CLI payloads carry `CommandInvocationCorrelation`: an outer invocation has a unique `invocationId` and no parent; nested canonical dispatch has its own id and the enclosing `parentInvocationId`. All phases of one invocation share the pair. Only the outer invocation is eligible for foreground notification, though nested terminal events remain observable.

### 3.6 Imperative shells

| Shell | Responsibilities |
|---|---|
| CLI | Native dispatch, argv/help, lifecycle hooks, `SIGINT` to `Effect.interrupt`, rendering, and exit status (§8) |
| Embedding host | Host-defined input, output, and signal policy over `@lando/core` (§16) |

Both shells MUST provide the generated layer for the resolved level, run with scoped Effect ownership, and honor the same levels, lifecycle sequence, and plugin graph. They are the only production boundaries where Effect crosses into Promise or forked execution. CLI requirements apply symmetrically unless §16 states otherwise. Tests use the embedding surface rather than a third runtime architecture.

### 3.7 Secret redaction

Redaction is one non-replaceable security invariant shared by logs, events, runners, network and data movement, managed files, build and doctor output, telemetry, config translation, caches, and executable-guide transcripts.

1. The value layer masks known resolved secrets, registry tokens, proxy credentials, and caller-supplied tokens by literal longest-first match.
2. The pattern layer then masks the canonical secret classes (`secretAssignment`, `urlUserinfo`, `bearerToken`, `signedQueryParam`, `secretKeyedField`) and, where the selected profile requires it, the normalization classes `url`, `email`, `uuid`, `hostname`, `posixPath`, `windowsPath`, `uncPath`, `homeAlias`, `port`, `containerId`, `digest`, `highEntropyToken`, `user`, `host`, and `root`.

| Profile | Contract |
|---|---|
| `secrets` | value layer plus secret classes and deep key masking; emits `[redacted]` |
| `telemetry` | `secrets` plus low-cardinality normalization placeholders |
| `transcript` | `secrets` plus deterministic `<HOME>`, `<TMP>`, `<PORT>`, `<CONTAINER_ID>`, `<DIGEST>`, `<PROVIDER_ID>`, `<USER>`, and `<HOST>` placeholders |

`@lando/sdk/secrets` owns the pure `createSecretRedactor`, `createRedactor`, pattern catalog, profiles, `REDACTED`, deep `redactValue`, and the `redactString`, optional bounded-string, and structured-value operations. A consumer requiring bounded output MUST fail closed when bounded redaction is unavailable. `RedactionService` supplies the live value set and profile redactors without network, provider, or plugin access and is eager at `minimal`.

Consumers MUST compose this redactor and MUST NOT replace, weaken, or reimplement it. `redactValue` MUST preserve structure and MUST NOT throw on cyclic or exotic input. The lowercase `[redacted]` sentinel is canonical; transcript placeholders are a separate byte-stable contract. Boundary and fixture gates enforce this ownership (§13.1, §13.4).

---

## 11. Lifecycle and Events

### 11.1 The event service

`EventService` is an Effect-backed typed bus. `publish` validates and delivers an event; `subscribe` returns a scoped live stream; `subscribeQueue` eagerly acquires a scoped queue; `waitFor` and `waitForAny` await matching future events with optional Effect-clock deadlines; `query` scans bounded redacted history without blocking.

Plugins never receive the full service. Their narrow render publisher redacts and decodes before delegating to `publish` (§9.8).

- Subscriber indexes are priority-sorted at registration and keyed by concrete event name. `publish` MUST short-circuit before validation and scheduling when no subscriber exists.
- `EventService` is eager at `minimal`; plugin subscribers populate it at `plugins`. A subscriber whose declared bootstrap level exceeds the event's level is rejected at manifest validation with `SubscriberLevelMismatchError`; plugins MUST NOT subscribe to `pre-bootstrap-tooling` / `post-bootstrap-tooling` unless they declare `bootstrap: tooling`, so the tooling fast path's subscriber map stays empty by construction in the common case (§9.5).
- Delivery queues and retained history MUST be bounded. Publishing MUST NOT block on a slow consumer; overflow MUST be observable. History stores redacted payloads only and MAY be disabled by embedding hosts.
- `waitFor` and `waitForAny` MUST fail with timeout `EventError` when their Effect-clock deadline expires. `query` MUST return only retained matches and MUST NOT block.

### 11.2 Event payloads

Every event payload is an Effect Schema in `@lando/sdk`, and `publish` accepts only the closed typed union. The payload registry includes `AppRef`, `CommandInvocationCorrelation`, `PreStartEvent`, `PreRestartEvent`, `PostRestartEvent`, `PreScratchStartEvent`, `PreGlobalStartEvent`, `DeprecationUsedEvent`, `ShellExecEvent`, `BunSelfExecEvent`, `HostProxyCallEvent`, `ToolingStepEvent`, `ToolingStepResultEvent`, `BuildPhaseEvent`, `BuildStepEvent`, `BuildStepProgressEvent`, `BuildStepResultEvent`, `FileSyncSessionEvent`, `FileSyncConflictEvent`, and `FileSyncProgressEvent`, plus the corresponding sibling schemas for every name in §3.5.

`AppRef.kind` distinguishes `user`, `global`, and `scratch`; subscribers MUST branch on kind when behavior differs. Restart payloads MUST match start payload shape apart from tags. Global start events always emit and distinguish warm from cold through `cached`. Tooling and build terminal families share discriminated result schemas. An up-to-date build step MUST emit `build-step-skip` with reason `up-to-date`. Event payloads expose only redacted command, path, token, and output data; full sensitive data never reaches subscribers.

### 11.3 Subscriber priority

Lower priority runs first.

| Band | Range | Use |
|---|---|---|
| `critical` | 0–9 | critical-path setup |
| `early` | 10–99 | core early work |
| `default` | 100–999 | user and plugin subscribers |
| `late` | 1000–9999 | housekeeping and scanners |
| `final` | 10000+ | final cleanup |

Built-in subscribers use `critical` and `late`; plugins default to `default`.

### 11.3.1 Subscriber selectors and factories

`SubscriberSelector` is a frozen Effect Schema union: either one exact known event or the single `cli-command-terminal` family. The family expands to every canonical command's `-run` and `-error` events, never `-init`. Regex, glob, prefix, partial, unknown-family, and plugin-defined selectors are forbidden.

Manifest decode validates entry shape, local identity, containment, and selector syntax before plugin import. After all commands and subscribers register, semantic validation closes the event registry, rejects unknown exact names, expands families once, sorts concrete indexes, and populates the zero-subscriber map. Publish-time selector matching is forbidden.

A subscriber module exports a `SubscriberFactory` that receives constrained `LandoPluginContext` and, when declared, only its decoded config slice. The loader MUST import and invoke the factory lazily on first matching delivery, exactly once per entry, then cache its handler. The factory MUST NOT perform IO until the returned handler runs. Priority and `abortOnError` come only from the manifest.

### 11.4 Standard event sequence

A cold `app:start` follows this canonical order; optional global and build detail remains inside the named brackets.

1. `pre-bootstrap-minimal`, `post-bootstrap-minimal`
2. `pre-bootstrap-plugins`, `post-bootstrap-plugins`
3. `pre-bootstrap-commands`, `post-bootstrap-commands`
4. `pre-bootstrap-provider`, `post-bootstrap-provider`
5. `pre-bootstrap-app`, `post-bootstrap-app`
6. `post-bootstrap`, `ready`
7. `cli-app:start-init`
8. `pre-init`, `post-init`
9. `pre-start`, whose body nests, in order: the global bracket `pre-global-start` … `post-global-start` (with an optional nested global `pre-build` … `post-build`) whenever `AppFeature.requires.globalServices` yields a non-empty set, then the user-app build bracket `pre-build`, ordered artifact then app `pre-build-phase`/step events/`post-build-phase`, `post-build`
10. `post-start` (running-state check, healthchecks, url scan by priority), `ready-app`
11. exactly one of `cli-app:start-run` or `cli-app:start-error`
12. `before-exit`

The global bracket MUST emit on every required-service check; `cached` distinguishes warm no-op from cold work. Build phases remain ordered while sibling steps run concurrently (§6.13). Stop, rebuild, and destroy use analogous pairs. Restart MUST order `pre-restart`, stop pair, start pair, `post-restart`; `post-restart` MUST NOT report success after either body fails.

### 11.5 Hot-path events

Tooling fast path emits `cli-<canonical-id>-init`, `pre-<tool>`, optional `tooling-step-*`, `post-<tool>`, then `cli-<canonical-id>-run` or `cli-<canonical-id>-error`. Plugins MUST tolerate omitted app/provider lifecycle events. Tooling dependency graphs MUST NOT promote to `app` solely to publish step events.

### 11.6 Subscriber failure handling

- Subscriber errors at `pre-*` abort the lifecycle step with the tagged error.
- Subscriber errors at `post-*` log at warn and do not abort unless the manifest sets `abortOnError: true`.
- Subscriber errors at `cli-*` log at debug and MUST NOT change exit status.

---
