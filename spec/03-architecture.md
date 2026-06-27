# Lando v4 — Architecture, Lifecycle, and Events

> **Part 3 of 18** · [Index](./README.md)
> **Read next:** [04 Pluggability](./04-pluggability.md)

This part wires up the runtime. It covers the four concentric layers (imperative shell → Effect runtime → pluggable abstractions → plugin implementations), the bootstrap flow with its declared `BootstrapLevel`s, the on-disk source layout, the catalog of core Effect services, and the lifecycle event scopes published through the runtime.

§3 (Architecture) and §11 (Lifecycle and Events) are paired here because §3.5 introduces the event taxonomy and §11 specifies the `EventService`, payload schemas, subscriber priority bands, the standard cold-start event sequence, the hot-path event subset for tooling commands, and subscriber failure handling. Treat §3 as the structural map and §11 as the dynamic behavior of the bus that runs through it.

---

## 3. Architecture

### 3.1 Four layers

Lando v4 is organized into four concentric layers. Code at any layer may depend on layers below it; the reverse is forbidden.

```text
+----------------------------------------------------------+
|  Imperative Shell (one-of-many)                          |
|  - bin/lando entry point (the CLI shell)                 |
|  - OR: an embedding host (Bun program importing core)    |
|  - OR: a test harness (e.g. test/integration/*)          |
|  - Argv/input parsing, signal handling, exit codes       |
+----------------------------------------------------------+
|  Effect Runtime                                          |
|  - Composed LandoRuntimeLive Layer                       |
|  - Bootstrap orchestration                               |
|  - Lifecycle event publishing                            |
|  - Tagged error propagation                              |
+----------------------------------------------------------+
|  Pluggable Abstractions (the "ports")                    |
|  - Service tags + interfaces, defined in @lando/sdk      |
|  - Effect Schemas for every contract                     |
|  - No implementations — only the shape                   |
+----------------------------------------------------------+
|  Plugin Implementations (the "adapters")                 |
|  - RuntimeProvider, ProxyService, CertificateAuthority,  |
|    Logger, Renderer, ToolingEngine, etc.                 |
|  - Each is a Bun-loadable package                        |
|  - Bundled defaults + third-party additions              |
+----------------------------------------------------------+
```

The pattern is "ports and adapters" with Effect's Layer system as the wiring mechanism.

The CLI is *one* imperative shell; an embedding host is another. Both build the same `LandoRuntimeLive` Layer at their boundary, run an Effect program against it, and tear down through `Scope`. The three layers below the imperative shell are identical in both modes — there is no "library mode" branch in the runtime, the planner, the providers, or the plugins. See §3.6 and §16 ([09 Embedding and Library Use](./09-embedding.md)).

### 3.2 Bootstrap flow

The CLI uses a router-first bootstrap with a pre-OCLIF fast path for level-`none` commands. OCLIF must resolve a command before Lando can know that command's required `BootstrapLevel`, so the OCLIF `init` hook is limited to routing metadata and cache reads. The Effect runtime is built only after command resolution.

```text
$ lando <cmd>
  |
  +-- bin/lando (compiled binary or `bun run bin/lando.ts`)
       |
       +-- 0. Pre-OCLIF level-`none` fast path
            |    (sniffs argv for `--version`/`-v`/top-level `--help`/`shellenv`/
            |     `version`/`recipes`/`recipes:list` shortcuts; on match, prints
            |     embedded data via direct stdout writes and exits BEFORE any
            |     OCLIF, Effect runtime, or plugin code is imported)
       |
       +-- OCLIF init hook fires [router phase]
            |
            +-- 1. Load embedded core command manifest
            +-- 2. Load plugin command index from cache
            +-- 3. Locate app root by `cwd-app-map` cache lookup, falling back to
            |     stat-walk on miss/staleness (§12.1)
            +-- 4. Load app command index from cache when fresh
            +-- 5. Register OCLIF command shims + aliases from cached metadata
            +-- 6. OCLIF resolves the command to a canonical id
            +-- 7. Read command's required/effective BootstrapLevel
            +-- 8. Provide the AOT-composed bootstrap layer for that level
            |     (§17.2 codegen output; no runtime Layer.merge/provide chain)
            +-- 9. Lazy-import the command implementation and run its Effect program
```

The router phase is not a `BootstrapLevel`: it does not parse Landofiles, import plugin contribution modules, initialize providers, build the full `EventService`, or run plugin subscribers. It MAY stat known Landofile paths, consult the `cwd-app-map` cache (§12.1), and read versioned command caches so help and command resolution stay fast. Router-phase reads against the command + plan caches use the binary cache encoding rules in §12.2.

**Bootstrap levels** (each strictly extends the previous, and each starts after command resolution):

| Level | Adds | Used by |
|---|---|---|
| `none` | *Nothing.* No Effect runtime, no Layer construction, no `@oclif/core` import. Direct argv sniff in `bin/lando.ts`, embedded-data print, exit. | `meta:version` (alias `version`), `meta:shellenv` (alias `shellenv`), `meta:recipes:list` (alias `recipes`), top-level `--help` (no command), `--version`, `-V`, `-v` |
| `minimal` | Config, env, platform info, cache, logging, event service (lazy per §2.4) | `meta:config`, `meta:plugin:login`, `meta:plugin:logout`, `meta:recipes:describe`, `meta:recipes:validate`, `meta:uninstall`, `meta:events:follow`, `apps:init`, `apps:list` |
| `plugins` | Plugin discovery, manifest validation, contribution graph | `meta:plugin:add`, `meta:plugin:remove`, `meta:doctor`, `meta:update` |
| `commands` | Lando command registry services and command-cache refresh ability | command-management and docs/reference commands |
| `tooling` | Commands plus a cache-only app plan / `ToolingProgram` read | Landofile-defined tooling commands that do not need full app planning |
| `provider` | Provider selection and adapter initialization | `meta:setup`, `apps:poweroff`, `apps:list --all` |
| `global` | `provider` + `GlobalAppService` and the global Landofile parser bound to `<userDataRoot>/global/.lando.yml`; `BuildOrchestrator` (lazy via `Layer.suspend` per the §6.13 lifecycle) for the global app's plan | `meta:global:start`, `meta:global:stop`, `meta:global:restart`, `meta:global:rebuild`, `meta:global:destroy`, `meta:global:info`, `meta:global:logs`, `meta:global:install`, `meta:global:uninstall` |
| `scratch` | `provider` + `ScratchAppService`; `LandofileService` constructible against an arbitrary scratch root; `AppPlanner` and `BuildOrchestrator` lazy via `Layer.suspend` (§21.6.1). Does NOT eagerly include `global`; scratch apps that activate `AppFeature.requires.globalServices` lazy-construct `GlobalAppService` exactly as user apps do | `apps:scratch:start`, `apps:scratch:stop`, `apps:scratch:destroy`, `apps:scratch:list`, `apps:scratch:info`, `apps:scratch:logs`, `apps:scratch:gc` |
| `app` | level `global` plus `AppPlanner`, `LandofileService` for the user app (includes `global` because `app:start` may need to call `GlobalAppService.ensureRunning` per §20.6.3) | `app:start`, `app:stop`, `app:info`, `app:rebuild`, `app:destroy`, `app:cache:refresh` |

Levels `minimal` through `app` each emit `pre-bootstrap-<level>` and `post-bootstrap-<level>` lifecycle events through the Effect event service. After all required levels complete, core emits `post-bootstrap` and `ready`. Level `none` emits NO lifecycle events: it is below the EventService construction threshold by design.

**Level `none` rules** — the pre-OCLIF fast path:

- `bin/lando.ts` MUST sniff `process.argv` before any `import` of `@oclif/core`, the Effect runtime, or any module that builds a `Context.Service`. Argv matching uses a hand-rolled string scan, not a parser.
- The set of level-`none` argv shapes is fixed and exhaustive: `--version`, `-V`, `-v`, `version`, top-level `--help` / `-h` (i.e. `--help` with no preceding command), `shellenv`, `recipes`, `recipes list`, plus the canonical `meta:version`, `meta:shellenv`, `meta:recipes:list` invocations and the `meta version|shellenv|recipes …` flexible-taxonomy variants.
- Output is generated from compile-time embedded constants (version string, shellenv snippet templates, the canonical recipe registry) read via `EmbeddedAssetService` mechanism A (static JSON import; §17.3). No `Bun.file`, no `fetch`, no plugin discovery.
- A level-`none` command MUST exit within its end-to-end budget (§2.1) without constructing any `Context.Service` instance.
- An argv shape that *looks* like a level-`none` command but carries unrecognized flags (e.g., `lando version --json` if `meta:version` ever grows a flag) falls through to the OCLIF router phase. The fast path is an optimization, never a correctness shortcut.

**Intra-level concurrency.** Bootstrap levels are sequential — `plugins` runs strictly after `minimal` completes. Independent IO-bound steps *within* a level MUST run concurrently via `Effect.all({ concurrency: "unbounded" })` or `Effect.forEach({ concurrency })` per the §2.4 rule. Examples:

- At level `plugins`: validate every cached plugin manifest in parallel; load every plugin's contribution metadata in parallel.
- At level `provider`: probe provider availability in parallel with reading the app-plan cache; warm the CA cert store in parallel with the provider's `getStatus`.
- At level `app`: parse the Landofile, decode the app-plan cache, and stat the lockfile concurrently; only assemble the merged tree once all three resolve.

Sequential intra-level chains are a perf bug unless data dependencies require them.

**Hot-path optimization.** Tooling commands (`lando <something>` defined in a Landofile's `tooling:` block) route from the app command index generated during full app planning. A tooling command's effective bootstrap level is stored in that index and in the cached `ToolingProgram`. The provider is *not* initialized until the command actually executes a provider-backed step. This preserves v3's fast-path performance without parsing Landofiles during routing. Both the app command index read and the `ToolingProgram` decode use the binary cache encoding rules in §12.2 to stay inside the §12.5 read budget.

### 3.3 Source layout

```text
core/
├── bin/
│   └── lando.ts                    # CLI entry (compiled to binary)
├── src/
│   ├── cli/
│   │   ├── oclif/                  # OCLIF adapters; only place that imports @oclif/core
│   │   │   ├── command-base.ts     # OclifCommand subclass adapting Effect → OCLIF
│   │   │   ├── hooks/              # init, prerun, postrun, command_not_found
│   │   │   ├── manifest.ts         # Generated/loaded manifest helpers
│   │   │   └── topics.ts
│   │   ├── commands/               # Built-in command Effect implementations
│   │   │   ├── start.ts
│   │   │   ├── stop.ts
│   │   │   └── ... (one per built-in)
│   │   └── index.ts
│   ├── runtime/
│   │   ├── layer.ts                # LandoRuntimeLive composition
│   │   ├── bootstrap.ts            # Bootstrap level orchestration
│   │   └── interrupt.ts            # SIGINT → Effect.interrupt
│   ├── config/
│   │   ├── service.ts              # ConfigService (Context.Service)
│   │   ├── schema.ts               # Effect Schema for global config
│   │   └── env.ts                  # Env-var override decoding
│   ├── landofile/
│   │   ├── service.ts              # LandofileService
│   │   ├── parser.ts               # YAML parser (load/import are expression helpers, §7.3)
│   │   ├── merge.ts                # Layered Landofile merge
│   │   └── schema.ts               # Effect Schema for Landofile shape
│   ├── plugins/
│   │   ├── registry.ts             # PluginRegistry service
│   │   ├── manifest.ts             # Plugin manifest schema + loader
│   │   ├── source/                 # PluginSource adapters (registry, git, local, tarball)
│   │   └── bundled.ts              # GENERATED — static imports of bundled plugins
│   ├── providers/
│   │   ├── registry.ts             # RuntimeProviderRegistry
│   │   ├── api.ts                  # RuntimeProvider service interface (Schema)
│   │   ├── capabilities.ts         # Capability schema and matchers
│   │   └── plan.ts                 # AppPlan schema
│   ├── services/                   # v4 service planner
│   │   ├── planner.ts              # AppPlanner service
│   │   ├── base/
│   │   │   ├── l337.ts             # L337 base contract
│   │   │   └── lando.ts            # Lando base contract
│   │   ├── feature.ts              # ServiceFeature schema + composer
│   │   └── schema.ts
│   ├── templates/
│   │   ├── registry.ts             # TemplateEngineRegistry — engine selection by id/extension
│   │   ├── renderer.ts             # TemplateRenderer — front-door for all render sites
│   │   ├── context.ts              # TemplateRenderContext schema (§7.3.2)
│   │   ├── ast.ts                  # AST schema for `{{ … }}` and `${…}` forms (§7.3.1)
│   │   ├── parser.ts               # Parser for the `lando` engine grammar
│   │   ├── resolver.ts             # Staged, bootstrap-level-aware AST resolution
│   │   ├── functions.ts            # The portable §7.3.1 function set
│   │   └── engines/
│   │       └── lando.ts            # Built-in `lando` engine (always available)
│   ├── recipes/
│   │   ├── manifest.ts             # RecipeManifest schema (recipe.yml shape)
│   │   ├── render.ts               # Recipe scaffold orchestrator — calls TemplateRenderer with recipe-scope context
│   │   ├── prompts.ts              # Prompt types (text/select/multiselect/confirm/number/secret/path/editor)
│   │   ├── runner.ts               # Init flow orchestrator (§8.8.9)
│   │   └── bundled.ts              # Generated by scripts/build-bundled-recipes.ts
│   ├── includes/
│   │   ├── api.ts                  # IncludeRef schema (§7.7)
│   │   ├── resolver.ts             # Source resolution (local/git/npm/registry) + cache + lockfile
│   │   └── merge.ts                # Fragment merge into Landofile tree
│   ├── tooling/
│   │   ├── compiler.ts             # Tooling YAML → OCLIF command spec
│   │   ├── engine.ts               # ToolingEngine service contract
│   │   └── schema.ts
│   ├── lifecycle/
│   │   ├── events.ts               # EventService (Effect.PubSub-backed)
│   │   ├── subscribers.ts          # Plugin subscriber registry
│   │   └── schema.ts               # Event payload schemas
│   ├── cache/
│   │   ├── service.ts              # CacheService (atomic read/write)
│   │   └── schemas.ts
│   ├── subsystems/
│   │   ├── proxy/
│   │   │   ├── api.ts              # ProxyService interface
│   │   │   ├── route.ts            # Route schema
│   │   │   └── filter.ts           # RouteFilter contract
│   │   ├── certs/
│   │   │   └── api.ts              # CertificateAuthority interface
│   │   ├── ssh/
│   │   ├── healthcheck/
│   │   ├── scanner/
│   │   └── networking.ts
│   ├── platform/                   # Bun primitive wrappers
│   │   ├── filesystem.ts           # FileSystem service (Bun.file/Bun.write)
│   │   ├── process.ts              # ProcessRunner service (Bun.spawn)
│   │   ├── bun-self.ts             # BunSelfRunner service (BUN_BE_BUN self-spawn)
│   │   ├── shell.ts                # ShellRunner service (Bun.$ / Bun Shell)
│   │   ├── privilege.ts            # PrivilegeService (sudo/UAC adapter)
│   │   └── tty.ts                  # Terminal capability detection
│   ├── logging/
│   │   ├── service.ts              # Lando Logger service
│   │   ├── effect-logger.ts        # Effect Logger glue
│   │   └── renderer.ts             # Renderer service contract
│   ├── errors/
│   │   └── tagged.ts               # All TaggedError classes
│   ├── schema/
│   │   └── index.ts                # Re-export of all public schemas
│   └── utils/
│       └── (small pure helpers)
├── plugins/                         # Bundled plugins (separate packages)
│   ├── service-lando/
│   ├── provider-lando/
│   ├── provider-docker/
│   ├── provider-podman/
│   ├── proxy-traefik/
│   ├── ca-mkcert/
│   ├── logger-pretty/
│   └── renderer-lando/
├── sdk/                             # @lando/sdk — what plugins import
│   └── src/
│       ├── index.ts                 # Schemas + tags + types only
│       └── ...
├── test/
│   ├── unit/
│   ├── contract/                    # Provider contract suites
│   └── integration/
├── package.json
├── bun.lock
├── tsconfig.json
└── oclif.manifest.json              # Generated at build time
```

### 3.4 Core Effect services

The following services are provided by core. Each has a `Live` Layer in core and may be replaced by a plugin Layer at runtime.

| Service tag | Responsibility | Default Live Layer |
|---|---|---|
| `ConfigService` | Global config + env overrides; expression AST resolution with staged, bootstrap-level-aware evaluation (§7.3.1) | `ConfigServiceLive` |
| `LandofileService` | Discovery, parse, merge, validate; produces the AST for every embedded `{{ … }}` and `${…}` form (§7.3.1) | `LandofileServiceLive` |
| `PluginRegistry` | Manifest loading, contribution graph | `PluginRegistryLive` |
| `CommandRegistry` | OCLIF + tooling registration | `CommandRegistryLive` |
| `ConfigTranslatorRegistry` | Plugin-contributed external config translators | `ConfigTranslatorRegistryLive` |
| `TemplateEngineRegistry` | Discovery and selection of `TemplateEngine` implementations (§4.2, §7.3.2). Built-in `lando` engine registered eagerly; plugin engines registered when the plugin contribution graph loads | `TemplateEngineRegistryLive` |
| `TemplateRenderer` | Front-door for whole-file and string template rendering. Resolves engine via the registry, builds the canonical `TemplateRenderContext`, calls the engine, and writes the content-addressed render cache (§12.1 `template-render`). Used by the mount materializer, the recipe scaffold, and `ConfigService` for string-value interpolation | `TemplateRendererLive` |
| `FileSyncEngineRegistry` | Discovery and selection of `FileSyncEngine` implementations (§4.2, §10.6). Built-in `passthrough` engine (no-op; the active provider's native bind mount realizes the `MountPlan` directly) registered eagerly; plugin engines (e.g., the bundled `@lando/file-sync-mutagen`) register when the plugin contribution graph loads. The selected engine's Live Layer is `Layer.suspend`-wrapped and constructed only when the active app plan contains at least one mount the planner has marked `realization: "accelerated"` per §6.4 | `FileSyncEngineRegistryLive` |
| `RuntimeProviderRegistry` | Provider discovery, selection | `RuntimeProviderRegistryLive` |
| `AppPlanner` | Service plan, route plan | `AppPlannerLive` |
| `BuildOrchestrator` | Compiles the resolved `AppPlan` into a `BuildPlan` DAG (artifact-build phase + per-service app-build phase, with cross-service `depends_on:` edges), runs siblings concurrently per the §6.13 caps, drives the build lifecycle (`pre-build`, `build-step-*`, `post-build`) through `EventService`, owns the per-step transcript writer (`<userDataRoot>/builds/<app-id>/<buildKey>.log`; §12.4), and surfaces task-tree progress to the active `Renderer` via the §8.9.2 events. Up-to-date checks consult the planner-stamped `buildKey` against the `build-results` cache (§12.1) so unchanged steps short-circuit to `build-step-skip { reason: "up-to-date" }`. | `BuildOrchestratorLive` (constructed at level `app`; `Layer.suspend`-wrapped — `lando info`, `lando logs`, and most tooling commands never construct it) |
| `EventService` | Pub/sub over typed lifecycle events | `EventServiceLive` |
| `CacheService` | Atomic cache reads/writes, invalidation | `CacheServiceLive` |
| `StateStore` | Durable, atomic, schema-validated, versioned, optionally cross-process-locked on-disk document store (§12.7) — the durable peer of `CacheService`'s in-memory memo. Mints `StateBucket` handles (one file each) with `json`/`binary`/custom codecs, advisory file locking, corruption quarantine, and version migration. The single owner of every Lando-owned durable write (scratch registry §21.11, include lockfile §7.7.4, plugin/host/translator state). **Not a §4.2 plugin abstraction — a state-integrity invariant** (like `EmbeddedAssetService`); host/test-overridable, never plugin-replaceable | `StateStoreLive` (constructed eagerly at level `minimal`; root resolution via the §7.5.1 Paths primitive; touches no network/provider/plugin module) |
| `ManagedFileService` | The single chokepoint for Lando-owned writes into the user's working tree (§10.13): renders file/block managed content, applies ownership markers, records drift/adoption in a `StateStore` ledger resolved by `PathsService.managedFileLedger(appId)`, rejects path escapes via the shared containment helper, writes atomically via the shared streaming-hash helper, and publishes redacted `ManagedFile` lifecycle events. **Not a §4.2 plugin abstraction — a working-tree-integrity invariant**; host/test-overridable, never plugin-replaceable | `ManagedFileServiceLive` (constructed at level `minimal`; `Layer.suspend`-wrapped; composes `StateStore`, `PathsService`, `TemplateRenderer`, `RedactionService`, and `EventService`; touches no provider/network/plugin module) |
| `FileSystem` | `Bun.file` / `Bun.write` wrapper | `FileSystemBunLive` |
| `ProcessRunner` | Argv-precise subprocess spawn (`Bun.spawn`) | `ProcessRunnerBunLive` |
| `ShellRunner` | Cross-platform shell-shaped execution (pipes, redirection, globs, built-ins) via `Bun.$` (Bun Shell) | `ShellRunnerBunLive` |
| `BunSelfRunner` | Self-spawn the compiled `lando` binary with `BUN_BE_BUN=1` so it acts as the upstream `bun` CLI; the only place in core that constructs a `BUN_BE_BUN=1` child. Backs plugin install/update (§9.6), `lando bun` / `lando x` (§8.2.4), recipe `bun:` post-init action verbs `install` / `add` / `create` / `run` / `x` (§8.8.8), the plugin authoring toolkit (§9.10), and `includes:` materialization for `npm:` / `registry:` schemes (§7.7). Library-mode fallback spawns a system `bun` when one is on PATH | `BunSelfRunnerBunLive` |
| `HttpClient` | Single outbound-egress chokepoint for all Lando-owned network access (§10.3.2): resolves proxy/CA trust via the canonical §10.3.1 resolver, performs streaming request/response and upload, redacts credentials, publishes `pre-/post-http-call` events, and honors cancellation. Consumed by `Downloader`, hosting push/pull, telemetry delivery, the update-manifest fetch, plugin-registry queries, tunnel/share control planes, the in-process MCP surface, and the `UrlScanner`. Deliberately NOT a REST framework, retry engine, or verification layer | `HttpClientLive` (constructed eagerly at level `minimal`; plugin-contributed implementations register at level `plugins` and replace the default per §4.2/§4.3) |
| `Downloader` | Verified-artifact specialization layered over `HttpClient` (§10.3.3): issues its byte-fetch through `HttpClient.stream`, then verifies SHA-256/size, streams to memory or an atomic file destination, enforces scheme and path-containment policy, emits `download-progress`, and cooperates with cache/offline mode. Used by runtime bundles, Mutagen/helper downloads, recipe/include tarballs, and self-update artifacts; the tool-provisioning helper (§10.3.4) installs pinned host binaries over it | `DownloaderLive` (constructed eagerly at level `minimal`, depends on `HttpClient`; plugin-contributed implementations register at level `plugins` and replace the default per §4.2/§4.3) |
| `DataMover` | The single chokepoint for **local/volume byte movement** (§10.11) — the on-host counterpart to `HttpClient`'s network egress. Moves bytes between five typed endpoints (host path/archive, in-process stream, named volume, service path/command, built artifact); owns snapshot/restore over a `PathsService`-resolved snapshot store indexed in a `StateStore` bucket, streaming + interruption, SHA-256 verification (via the shared `@lando/sdk` streaming-hash helper that also backs `Downloader`), `tar`/gz/zst archiving, and the `Data` lifecycle events. Dispatches to a provider data-plane method when the matching capability is `native`, else a generic helper-container fallback (§5.3/§5.4). Composes `RedactionService`; emits no raw secrets/host paths. Backs DB import/export/snapshot, hosting pull/push (local half), scratch `--isolate=full`, disposable toolbox seeding, and `image save/load` | `DataMoverLive` (constructed at level `provider`, `Layer.suspend`-wrapped; not plugin-replaceable — the pluggable seam is the `RuntimeProvider` data plane, §4.2) |
| `PrivilegeService` | sudo/UAC dispatch | `PrivilegeServiceLive` (platform-specific) |
| `EmbeddedAssetService` | Unified access to build-embedded assets and library-mode package assets | `EmbeddedAssetServiceLive` |
| `PathsService` | Authoritative resolution of the four Lando roots (`userConfRoot`, `userCacheRoot`, `userDataRoot`, `systemPluginRoot`) and every path derived from them (plugin store, `bin/`, `certs/`, `runtime/`, `keys/`, logs, scratch root, app caches, config files) per the §7.5 precedence and platform-default matrix. Backed by the Effect-free `@lando/core/paths` resolver so the tag is a thin runtime wrapper that never depends on `ConfigService`; the same resolver serves the level-`none` fast path and embedding hosts (§7.5.1) | `PathsServiceLive` (constructed eagerly at level `minimal`) |
| `Logger` | Structured logging through Effect | `LoggerLive` (Effect `Logger.pretty` by default; `Layer.suspend`-wrapped — built on first `yield* Logger`) |
| `Renderer` | CLI output strategy | `RendererLive` (default Lando renderer; `Layer.suspend`-wrapped, with a pre-bootstrap direct-write fallback for first-paint banners; §8.9) |
| `InteractionService` | The input peer of `Renderer` (§8.10): resolves a typed `PromptSpec` (or ordered batch) against the active answer source — explicit answer → recipe/caller default (`--yes`) → interactive prompt → fail — using the published prompt vocabulary (text/select/multiselect/confirm/number/secret/path/editor); owns interactivity-mode resolution (`auto`/`interactive`/`non-interactive`), `secret`/redaction guarantees, and dynamic `choicesFrom` resolution. Used by `apps:init` recipe prompts, `meta:plugin:new`, the `meta:plugin:add` trust gate, `meta:setup` confirmations, and `lando doctor --fix` | `InteractionServiceLive` (`Layer.suspend`-wrapped — built only when a command actually prompts; default `auto` mode in CLI, `non-interactive` in library mode; plugin-contributed implementations register at level `plugins` and replace the default per §4.2/§4.3) |
| `DeprecationService` | Records deprecated-surface usage, dedupes per process, publishes `deprecation-used` events, and answers lookups for `lando doctor` / `lando config` / docs build (§18) | `DeprecationServiceLive` (constructed eagerly at level `minimal`; registry index populated at level `plugins`) |
| `DoctorService` | Runs host/app/provider diagnostics and exposes automated or manual remediations; aggregates plugin-contributed `doctorChecks` (§9.5); also records deprecation entries surfaced by `lando doctor --deprecations` (§18.6) | `DoctorServiceLive` (constructed at level `plugins` so plugin-contributed checks register; transcripts captured via `ShellRunner` per §10.9) |
| `HostProxyService` | Per-app container→host RPC: opens `<userDataRoot>/run/<app-id>/host-proxy.sock`, dispatches the full §10.10.2 message set — `openUrl` (host browser open), `openPath` (host-side path open), `runLando` (in-process re-entry into `@lando/core/cli` against a retained runtime), `runBun` (read-only Bun verbs forwarded to host `BunSelfRunner`; verb allowlist in §10.10.2), `notify` (host notification), `clipboardCopy` (host clipboard write) — enforces token auth and the §10.10 allowlists, publishes `pre-host-proxy-call` / `post-host-proxy-call` lifecycle events | `HostProxyServiceLive` (lazy via `Layer.suspend`; only constructed when the active app plan includes the `lando.host-proxy` feature, §6.11) |
| `TunnelService` | Public app/service sharing (§10.2.2): resolves a `RoutePlan` or service endpoint target, performs provider control-plane calls through `HttpClient`, provisions any connector binary through the tool-provisioning helper over `Downloader`, supervises connector processes through `ProcessRunner`, persists detached session state through `StateStore`, waits for readiness with the probe primitive, publishes tunnel lifecycle events, and composes `InteractionService` + `RedactionService`. It is not a data-transfer primitive and does not use `DataMover` except in higher-level features that also move bytes | No always-on default in v4.0; plugin-contributed `TunnelService` implementations register at level `plugins` and are constructed lazily when `app:share` / `App.share` asks for one (§4.2/§4.3) |
| `GlobalAppService` | The global Lando app: regenerates `<userDataRoot>/global/.lando.dist.yml` from `globalServices:` manifest contributions, manages the `global` app's plan, lifecycle, and auto-start (§20). Reuses the same `RuntimeProvider`, `AppPlanner`, and `BuildOrchestrator` user apps use; only the `<app-id>` is fixed to `global`. | `GlobalAppServiceLive` (constructed at level `global`; `Layer.suspend`-wrapped — `lando info` against an already-running user app whose features require no global services pays zero cost) |
| `ScratchAppService` | Scratch apps (§21): acquires, starts, stops, destroys, lists, and reaps short-lived Lando apps whose lifetime is bound to an Effect `Scope`. Owns materialization of the scratch root under `<userCacheRoot>/scratch/<id>/`, the scratch registry at `<userCacheRoot>/scratch/registry.bin`, and the orphan-reap protocol that combines the registry walk with a provider-label scan (`dev.lando.scratch: "TRUE"`). Reuses every other core service a normal user app uses — `LandofileService`, `AppPlanner`, `BuildOrchestrator`, `RuntimeProvider`, `ProxyService`, `CertificateAuthority` — with the §21.7–§21.9 plan-time transformations applied (mount isolation, `scope: global` shadowing, hostname auto-suffix). | `ScratchAppServiceLive` (constructed at level `scratch`; `Layer.suspend`-wrapped — `lando info` against a user app pays zero `ScratchAppService` cost) |
| `Telemetry` | Core usage stats, enabled by default unless disabled by config/env | `TelemetryLive` (fire-and-forget; never blocks command exit; §2.4) |
| `RedactionService` | The single owner of secret and PII masking (§3.7). Builds a request-scoped redactor from the active `SecretStore` resolutions, known token env (`BUN_AUTH_TOKEN`, scoped `_authToken`, resolved proxy credentials), and per-call redaction tokens, then exposes `forProfile(profile)` returning a canonical `Redactor`. Consumed by `Logger`, `EventService`, `ProcessRunner` / `ShellRunner` / `BunSelfRunner`, `HttpClient` / `Downloader`, `TunnelService`, `DataMover`, `BuildOrchestrator`, `HostProxyService`, `Telemetry`, the build/doctor/guide transcript writers, and the CLI failure formatter so every surface "observes redacted forms only". **Not a §4.2 plugin abstraction — a non-replaceable security invariant** (like `EmbeddedAssetService`); audited/sandboxed runner, downloader, and tunnel plugins *compose* it, they never replace or weaken it. | `RedactionServiceLive` (constructed eagerly at level `minimal`; backed by the pure, dependency-free `@lando/sdk/secrets` functions so the telemetry hot-enqueue path and the docs build redact without constructing a runtime) |

Every service is consumed via `yield* ServiceTag` inside `Effect.gen`. Type errors at the Layer composition boundary catch missing services at compile time. Services in this table are core-provided runtime services; not every one is plugin-replaceable. Plugin-replaceable abstractions are enumerated in §4.2. `EmbeddedAssetService` is overrideable by tests and embedding hosts, but is not a plugin contribution surface because it protects binary/package asset integrity.

**`ProcessRunner` vs `ShellRunner` — when to use which.** Both spawn host processes; they exist for distinct shapes of work and are deliberately complementary, not redundant.

| Concern | `ProcessRunner` | `ShellRunner` |
|---|---|---|
| Primitive | `Bun.spawn(argv, opts)` | `` Bun.$`…` `` (Bun Shell, in-process bash-like interpreter) |
| Input shape | Exact `argv: string[]` plus options | Tagged template literal with safe-by-default interpolation |
| Shell features | None — no parsing, no expansion, no built-ins | Pipes (`\|`), redirection (`<`, `>`, `2>&1`), globs (`*`, `**`, `{a,b}`), command substitution (`$(…)`), built-in `cd`/`ls`/`rm`/`mkdir`/`cat`/`mv`/`which`, env var expansion |
| Cross-platform on Windows | Whatever the spawned binary supports | Built-ins are reimplemented in Bun, so `rm -rf` / `mkdir -p` / globs work on Windows without `rimraf` / `cross-env` |
| Typical callers | Provider exec (`docker exec`, `podman exec`), signing tools (`codesign`, `signtool`, `cosign`), `bun add`, plugin-supplied external binaries | The `host` ToolingEngine (§8.6), tooling `vars.<name>.sh:` for `service: :host` (§8.5.3), `.bun.sh` scripts (§8.5.9), the `lando shell` REPL (§8.2), host-side healthcheck/url-scanner plugins (§10.5), recipe `bun: { verb: script }` post-init (§8.8.8) |
| Injection risk | Minimal (no shell parses the argv) | Mitigated by Bun Shell's automatic escaping of interpolated values; explicit `{ raw: "…" }` is required to opt out |
| Cancellation | `Effect.interrupt` → `proc.kill(SIGTERM)` then `SIGKILL` | `Effect.interrupt` → `proc.kill()` on the underlying Bun Shell process; scope finalizers reap any spawned children |

A simple rule: if the work is "spawn this exact binary with these exact arguments," use `ProcessRunner`. If the work would naturally be a one-liner in `bash` and you want it to also work on Windows, use `ShellRunner`. Core code MUST NOT use one to imitate the other: no `ProcessRunner.run(["sh", "-c", "…"])`, and no `ShellRunner` calls that just re-encode argv as a literal string.

Both services flow logs through the same `Logger`, redact `${secret:…}` values identically (§7.3.1, §11), publish lifecycle events (`pre-process-exec` / `post-process-exec` for `ProcessRunner`, `pre-shell-exec` / `post-shell-exec` for `ShellRunner`; §3.5/§11), and honor the same `PrivilegeService` for elevation. Telemetry, dry-run, and audited variants are plugin-replaceable for both (§4.2).

**`ShellRunner` interface (illustrative; canonical schema in `@lando/sdk`):**

```ts
export class ShellRunner extends Context.Service<ShellRunner, {
  readonly id: string;

  // One-shot run. Resolves to ShellResult on success; fails the Effect with a tagged
  // ShellExecError on non-zero exit by default. Use `.nothrow()` semantics by passing
  // `{ throwOnNonZero: false }` to inspect exitCode without an Effect failure.
  readonly run:    (script: ShellScript, options?: ShellRunOptions) => Effect.Effect<ShellResult, ShellExecError, Scope.Scope>;

  // Streaming variants for long-running output. The Stream completes when the underlying
  // process exits; `Effect.interrupt` propagates to `proc.kill()` and finalizers reap children.
  readonly stream: (script: ShellScript, options?: ShellRunOptions) => Stream.Stream<Uint8Array, ShellExecError, Scope.Scope>;
  readonly lines:  (script: ShellScript, options?: ShellRunOptions) => Stream.Stream<string,    ShellExecError, Scope.Scope>;

  // Run a `.bun.sh` file resolved against an explicit base directory. Used by the host
  // ToolingEngine for §8.5.9 script-backed tasks and by the recipe `bun: { verb: script }` action (§8.8.8).
  readonly runScript: (file: ResolvedScriptRef, options?: ShellRunOptions) => Effect.Effect<ShellResult, ShellExecError, Scope.Scope>;

  // Bun.$ utilities, exposed for callers that need raw escape semantics or brace expansion.
  readonly escape:   (input: string) => string;
  readonly braces:   (template: string) => ReadonlyArray<string>;
}>()("@lando/core/ShellRunner") {}

export interface ShellScript {
  readonly template: ReadonlyArray<string>;          // template literal strings
  readonly values:   ReadonlyArray<unknown>;         // interpolated values; escaped automatically
}

export interface ShellRunOptions {
  readonly cwd?: AbsolutePath;
  readonly env?: Record<string, string>;
  readonly stdin?: ShellInput;                       // string | Uint8Array | ReadableStream | Bun.file ref
  readonly timeout?: DurationInput;
  readonly throwOnNonZero?: boolean;                 // default true
  readonly redact?: ReadonlyArray<string>;           // additional redaction tokens for logs
}

export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly signal?: NodeJS.Signals;
  readonly durationMs: number;
}
```

Required `ShellRunner` behaviors:

- The default `ShellRunnerBunLive` MUST use `Bun.$` as its execution engine — no system shell (`/bin/sh`, `cmd.exe`, `powershell.exe`) is invoked.
- Interpolated values in a `ShellScript` MUST be escaped per Bun Shell's default rules; opting out requires an explicit `{ raw: "…" }` wrapper at the call site (mirroring Bun's API).
- `${secret:…}` references resolved by `SecretStore` (§4.2) MUST be passed as escaped values and redacted from log/event output — the `Logger` and `EventService` MUST observe redacted forms only.
- `pre-shell-exec` / `post-shell-exec` events publish a `ShellExecEvent` payload with the canonical id of the calling subsystem (e.g., `tooling-engine:host`, `recipe:bun:script`, `lando-shell`), the redacted command shape, the cwd, and the result summary; full unredacted output is available only to the active `Logger` at debug level.
- `Effect.interrupt` MUST propagate to `proc.kill()` and the service's `Scope` MUST reap any child processes spawned from inside the shell template.
- `runScript(file)` MUST verify the file resides under a permitted base (the app root, the user-config root's `recipes/` cache, or an explicitly opted-in include root) and MUST refuse to execute scripts whose realpath escapes those bases. Symlink traversal is rejected with `ShellScriptOutsideRootError`.
- The service MUST be safe to use from inside `bootstrap: tooling` commands; instantiating the default Live Layer MUST NOT touch the network, the provider, or any plugin module.

Tagged errors live in `@lando/core/errors`:

- `ShellExecError` — non-zero exit, signal kill, timeout, or shell-parse failure. Payload includes redacted command, exitCode, signal, stdout/stderr (truncated and redacted), and remediation.
- `ShellInterpolationError` — a `{ raw: … }` wrapper used in a context where unsafe interpolation is forbidden (e.g., recipe `bun: { verb: script }`). Includes the offending position and remediation.
- `ShellScriptOutsideRootError` — `runScript` rejected because the file's realpath escapes the permitted base. Includes both paths.
- `ShellRunnerUnavailableError` — the active Live Layer cannot satisfy the request (e.g., a dry-run plugin that refuses real execution outside an allowlist).

**`BunSelfRunner` interface (illustrative; canonical schema in `@lando/sdk`):**

```ts
export class BunSelfRunner extends Context.Service<BunSelfRunner, {
  readonly id: string;

  // Run the embedded Bun CLI with the given argv. Resolves to a BunSelfResult
  // on exit code 0; fails the Effect with a tagged BunSelfExecError on non-zero
  // unless `{ throwOnNonZero: false }` is passed. Equivalent to
  // `bun <args>` with the user's PATH and the supplied options.
  readonly run:    (args: ReadonlyArray<string>, options?: BunSelfRunOptions) => Effect.Effect<BunSelfResult,  BunSelfExecError, Scope.Scope>;

  // Streaming variants for long-running output (e.g., bun install logs, bun build progress).
  readonly stream: (args: ReadonlyArray<string>, options?: BunSelfRunOptions) => Stream.Stream<Uint8Array, BunSelfExecError, Scope.Scope>;
  readonly lines:  (args: ReadonlyArray<string>, options?: BunSelfRunOptions) => Stream.Stream<string,    BunSelfExecError, Scope.Scope>;

  // Convenience verbs over `run`. Each enforces the verb's known argv shape
  // and refuses a freeform `args[0]` that contradicts the chosen verb.
  readonly install: (options?: BunInstallOptions)     => Effect.Effect<BunSelfResult, BunSelfExecError, Scope.Scope>;
  readonly add:     (specs: ReadonlyArray<string>,
                     options?: BunAddOptions)         => Effect.Effect<BunSelfResult, BunSelfExecError, Scope.Scope>;
  readonly remove:  (names: ReadonlyArray<string>,
                     options?: BunRemoveOptions)      => Effect.Effect<BunSelfResult, BunSelfExecError, Scope.Scope>;
  readonly x:       (spec: string,
                     argv: ReadonlyArray<string>,
                     options?: BunXOptions)           => Effect.Effect<BunSelfResult, BunSelfExecError, Scope.Scope>;
  readonly create:  (template: string,
                     dest: AbsolutePath,
                     options?: BunCreateOptions)      => Effect.Effect<BunSelfResult, BunSelfExecError, Scope.Scope>;
  readonly runScript: (scriptName: string,
                       options?: BunRunOptions)       => Effect.Effect<BunSelfResult, BunSelfExecError, Scope.Scope>;
  readonly buildLib:  (options: BunBuildOptions)      => Effect.Effect<BunSelfResult, BunSelfExecError, Scope.Scope>;
  readonly publishPkg: (options?: BunPublishOptions)  => Effect.Effect<BunSelfResult, BunSelfExecError, Scope.Scope>;

  // Diagnostic — returns the embedded Bun's reported version (the same string
  // a user would see from `bun --version`). Cached per process; no spawn after
  // the first call.
  readonly version: Effect.Effect<string, BunSelfExecError>;
}>()("@lando/core/BunSelfRunner") {}

export interface BunSelfRunOptions {
  readonly cwd?: AbsolutePath;
  readonly env?: Record<string, string>;        // merged onto the inherited env; `BUN_BE_BUN` is always set
  readonly stdin?: BunSelfInput;                // string | Uint8Array | ReadableStream | "inherit" | "ignore"
  readonly timeout?: DurationInput;
  readonly throwOnNonZero?: boolean;            // default true
  readonly redact?: ReadonlyArray<string>;      // additional redaction tokens for logs/events
  readonly registry?: BunSelfRegistryConfig;    // `bun install`-style registry overrides without writing a temp .npmrc
  readonly mode?: "embedded" | "host";          // default "embedded"; "host" forces a system `bun` lookup (library-mode escape hatch)
}

export interface BunSelfResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly signal?: NodeJS.Signals;
  readonly durationMs: number;
  readonly bunVersion: string;                  // the embedded Bun's version that handled the call
}
```

Required `BunSelfRunner` behaviors:

- The default `BunSelfRunnerBunLive` MUST self-spawn the running binary by `process.execPath` with `BUN_BE_BUN: "1"` set in the child's environment. It MUST NOT resolve a `bun` binary from `PATH` for the embedded path. Library-mode fallback (`mode: "host"` or no embedded Bun at runtime — i.e., `process.execPath` is not the Lando-compiled binary) MAY shell out to a system `bun`; the resulting `bunVersion` field carries the host's version and a `bun-self-exec` event is published with `mode: "host"` so observers can tell which path executed.
- Self-spawn MUST NOT recurse: the dispatcher MUST set `LANDO_DISALLOW_BUN_BE_BUN_REENTRY=1` in the child env; if a `BunSelfRunner` finds that env on entry it MUST refuse with `BunSelfReentryError` instead of starting a third level. This prevents a misbehaving plugin or post-install script from forking unbounded `BUN_BE_BUN` chains.
- Every invocation MUST publish `pre-bun-self-exec` and `post-bun-self-exec` lifecycle events (§3.5/§11.2) with the redacted argv shape, the calling subsystem id (e.g., `plugin-install:meta:plugin:add`, `recipe:bun:create:vite`, `tooling-engine:bun-x`), the `cwd`, the registry summary (host + scope, never tokens), the `mode` (`embedded` | `host`), and the result summary.
- `secret`-resolved values from `SecretStore` (§4.2) and `registry.token` values MUST be passed through env vars (`BUN_AUTH_TOKEN`, scoped `_authToken` entries) and redacted from log/event output. The `Logger` and `EventService` MUST observe redacted forms only.
- `Effect.interrupt` MUST propagate to `proc.kill()` and the service's `Scope` MUST reap the spawned Bun process before resolving.
- `install`, `add`, `remove`, `x`, `create`, `runScript`, `buildLib`, `publishPkg` MUST validate their argv before dispatch; passing `{ args: ["install", "--global"] }` to `install()` is rejected with `BunSelfArgvShapeError` because the verb-specific contract forbids `--global` writes outside the plugin install dir. Freeform escape hatch is `run(args)`.
- `x` (bunx-equivalent) MUST refuse to run an external package when the active runtime is in offline mode (§1.4 disconnectable local-dev) unless the package is already cached in Bun's bunx cache; this prevents a `lando x` call from silently breaching the offline contract.
- The service MUST be safe to use from `bootstrap: minimal`. Constructing the default Live Layer MUST NOT touch the network, the provider, or any plugin module. The first `version` access spawns once and caches the result for the rest of the process.
- Executable-guide scenario transcripts (§19.6) capture `pre-bun-self-exec` / `post-bun-self-exec` event payloads through the same lifecycle-event redaction policy applied here: registry tokens, secret-resolved env values, and the `LANDO_DISALLOW_BUN_BE_BUN_REENTRY` re-entry marker are redacted before they reach the transcript writer. Guide authors who reference `lando bun` or `lando x` invocations through `<Run>` (§19.3) get the same self-spawn behavior the CLI gets, and the `<Verify event="post-bun-self-exec" …/>` matcher exposes the redacted payload exactly as observed by the active `Logger` at info level.

Tagged errors live in `@lando/core/errors`:

- `BunSelfExecError` — non-zero exit, signal kill, timeout, or process-spawn failure. Payload includes redacted argv, exitCode, signal, stdout/stderr (truncated and redacted), `bunVersion` if known, the dispatch `mode`, and remediation.
- `BunSelfArgvShapeError` — a verb-specific call (`install`, `add`, …) was given argv that contradicts its allowed shape. Payload includes the offending verb, the rejected argv, and the contract that was violated.
- `BunSelfReentryError` — the dispatcher detected `LANDO_DISALLOW_BUN_BE_BUN_REENTRY=1` in its inbound env and refused to fork. Payload includes the inbound argv and the upstream caller id.
- `BunSelfRunnerUnavailableError` — the active Live Layer cannot satisfy the request (e.g., a sandboxed plugin that allowlists specific verbs only). Payload includes the rejected verb and the list of allowed verbs.
- `BunSelfHostFallbackUnavailableError` — `mode: "host"` was requested (or implied by library-mode use) but no `bun` was found on PATH and no embedded Bun is available. Payload includes the resolved `process.execPath` and remediation.

**Service membership per bootstrap level.** Each `BootstrapLevel` (§3.2) corresponds to an AOT-composed layer (§17.2 codegen, "Bootstrap layers"). The composition is:

| Level | Services included (eager) | Services included (`Layer.suspend`-wrapped, lazy on first access) | Services NOT in this layer |
|---|---|---|---|
| `none` | *none* — no Effect runtime constructed | *none* | every service |
| `minimal` | `PathsService`, `ConfigService`, `FileSystem`, `ProcessRunner`, `EmbeddedAssetService`, `CacheService`, `StateStore`, `EventService`, `DeprecationService`, `RedactionService`, `TemplateEngineRegistry` (built-in `lando` engine pre-registered), `TemplateRenderer`, `HttpClient`, `Downloader` (default implementations; `Downloader` depends on `HttpClient`) | `Logger`, `Renderer`, `Telemetry`, `ShellRunner`, `BunSelfRunner`, `InteractionService`, `ManagedFileService` (§10.13; forced on first plan/apply/status) | plugins, commands, providers, app planner, networking subsystems |
| `plugins` | `minimal` + `PluginRegistry`, `ConfigTranslatorRegistry`, `DoctorService`, `FileSyncEngineRegistry` (built-in `passthrough` engine pre-registered); plugin-contributed `TemplateEngine`, `FileSyncEngine`, `HttpClient`, `Downloader`, `TunnelService`, and `InteractionService` impls register here | `minimal`'s lazy + `PrivilegeService` | commands beyond registry, providers, app planner |
| `commands` | `plugins` + `CommandRegistry` | `plugins`'s lazy | providers, app planner |
| `tooling` | `commands` + cached `ToolingProgram` reader | `commands`'s lazy + `ToolingEngine` (resolved from cache) | live providers, full app planner |
| `provider` | `commands` + `RuntimeProviderRegistry` (selected adapter constructed) | `commands`'s lazy + `CertificateAuthority`, `ProxyService`, `DataMover` (§10.11; forced on first `transfer`/`snapshot`) | full app planner |
| `global` | `provider`'s eager + `GlobalAppService`; the global app's `LandofileService` instance | `provider`'s lazy + `BuildOrchestrator` (lazy per §6.13), `HealthcheckRunner`, `UrlScanner` | full user-app planner |
| `scratch` | `provider`'s eager + `ScratchAppService`; `LandofileService` constructible against an arbitrary scratch root; the scratch registry reader/writer | `provider`'s lazy + `AppPlanner`, `BuildOrchestrator` (lazy per §6.13), `HealthcheckRunner`, `UrlScanner`, `HostProxyService` (when the resolved scratch plan declares the `lando.host-proxy` feature), `GlobalAppService` (when the scratch's `AppFeature` activations declare `requires.globalServices`) | full user-app planner bound to a discoverable cwd app root |
| `app` | level `global`'s eager (so `GlobalAppService.ensureRunning` is callable from `pre-start`) + `AppPlanner`, `LandofileService` for the user app | `provider`'s lazy + `HealthcheckRunner`, `UrlScanner`, `HostProxyService`, `TunnelService`, `BuildOrchestrator`, the active `FileSyncEngine` Live Layer (e.g., `FileSyncEngineMutagenLive`) when the resolved app plan contains at least one mount marked `realization: "accelerated"` per §6.4 | *(none — this is the maximal layer)* |

**Cross-table note.** `CertificateAuthority`, `ProxyService`, `TunnelService`, `HealthcheckRunner`, and `UrlScanner` are pluggable abstractions whose canonical declarations live in §4.2 rather than the §3.4 services table above. Their default Live Layers ship in core when applicable (built-in CA stub, default `fetch`-based scanner, default `RuntimeProvider.exec`-backed healthcheck runner; no always-on `TunnelService` default in v4.0) so they are members of the AOT-composed bootstrap layers per the membership-per-level table here. When a plugin contributes an alternate Layer (`@lando/ca-mkcert`, `@lando/proxy-traefik`, `@lando/tunnel-*`, etc.), the contributed Layer replaces the default at the same level. Embedding hosts that need to enumerate every service in the runtime SHOULD treat the §4.2 catalog and the §3.4 services table together as the authoritative service registry.

The "lazy" column lists services that the codegen wraps in `Layer.suspend` so their `Live` body never executes unless something at runtime actually requests them. This keeps cold-path overhead off the hot path: a `lando list` at level `minimal` doesn't construct `Telemetry` unless a subscriber actually publishes a telemetry event during the run, doesn't construct `ShellRunner` unless something at runtime actually shells out (the same caller that needs the host engine, a `vars.sh:` evaluator, or a `.bun.sh` script), and doesn't construct `BunSelfRunner` unless something at runtime self-spawns Bun (the same caller that runs `lando bun`, `lando x`, plugin install, recipe `bun: { verb: install }`, or `includes:` materialization). The two runner services share the lazy bucket because most level-`minimal` invocations need neither. The active `FileSyncEngine` Live Layer follows the same pattern at level `app`: a `lando start` against an app whose plan contains zero accelerated mounts (every mount is `realization: "passthrough"`) MUST NOT spawn the Mutagen daemon, allocate a sync session, or import the gRPC client; the `Layer.suspend` wrapper holds construction until the planner emits the first `FileSyncEngine.createSession` call. `BuildOrchestrator` follows the same pattern: a `lando info` or a `lando logs` against an already-running app does not need it; the `Layer.suspend` wrapper holds construction until a lifecycle command (`app:start`, `app:rebuild`, `app:cache:refresh --rebuild`) actually drives a build phase.

`Renderer`'s Layer.suspend wrapping cooperates with the first-paint contract in §8.9 — a pre-bootstrap direct-write fallback prints the initial banner before the suspended `Renderer` Layer is forced.

### 3.5 Lifecycle events

Events are typed and validated. Subscribers register through plugin manifests.

| Scope | Standard events |
|---|---|
| Lando | `pre-bootstrap-<level>`, `post-bootstrap-<level>`, `post-bootstrap`, `ready`, `pre-setup`, `post-setup`, `before-exit` |
| App | `pre-init`, `post-init`, `pre-start`, `post-start`, `pre-stop`, `post-stop`, `pre-rebuild`, `post-rebuild`, `pre-destroy`, `post-destroy` |
| Provider | `pre-provider-apply`, `post-provider-apply`, `pre-provider-exec`, `post-provider-exec`, `pre-provider-logs`, `post-provider-logs` |
| Process / Shell / Network | `pre-process-exec`, `post-process-exec`, `pre-shell-exec`, `post-shell-exec`, `pre-bun-self-exec`, `post-bun-self-exec`, `pre-http-call`, `post-http-call`, `pre-download`, `download-progress`, `post-download` |
| File sync | `pre-file-sync-create`, `post-file-sync-create`, `pre-file-sync-pause`, `post-file-sync-pause`, `pre-file-sync-resume`, `post-file-sync-resume`, `pre-file-sync-terminate`, `post-file-sync-terminate`, `file-sync-conflict-detected`, `file-sync-progress` (published for every `FileSyncEngine` session lifecycle transition and conflict/progress frame; §10.6) |
| Host proxy | `pre-host-proxy-call`, `post-host-proxy-call` (published for every container→host RPC dispatched by `HostProxyService`; §10.10) |
| Tunnel | `pre-tunnel-start`, `post-tunnel-start`, `tunnel-ready`, `pre-tunnel-stop`, `post-tunnel-stop`, `tunnel-status` (published by `TunnelService` for foreground and detached public sharing sessions; §10.2.2) |
| Data | `pre-data-transfer`, `data-transfer-progress`, `post-data-transfer`, `pre-volume-snapshot`, `post-volume-snapshot` (published by `DataMover` for every local/volume byte-movement and snapshot/restore operation; §10.11) |
| ManagedFile | `pre-managed-file-write`, `post-managed-file-write`, `managed-file-conflict-detected`, `managed-file-skipped` (published by `ManagedFileService` for every managed working-tree file write/skip/conflict decision; §10.13) |
| Build | `pre-build`, `post-build`, `pre-build-phase`, `post-build-phase`, `build-step-start`, `build-step-progress`, `build-step-complete`, `build-step-skip`, `build-step-fail` (published by `BuildOrchestrator` for every node in the `BuildPlan` DAG; §6.13) |
| Tooling | `pre-<tool>`, `post-<tool>`, `tooling-step-start`, `tooling-step-complete`, `tooling-step-skip`, `tooling-step-fail` |
| CLI | `cli-<canonical-id>-init`, `cli-<canonical-id>-run`, `cli-<canonical-id>-error` (e.g. `cli-app:start-init`, `cli-app:start-run`, `cli-meta:plugin:add-run`) |
| Global | `pre-global-start`, `post-global-start`, `pre-global-stop`, `post-global-stop`, `pre-global-rebuild`, `post-global-rebuild`, `pre-global-destroy`, `post-global-destroy`, `pre-global-dist-regenerate`, `post-global-dist-regenerate` (published by `GlobalAppService` for every state transition of the global app and every plugin-contribution-driven `dist` regeneration; §20.6.2) |
| Scratch | `pre-scratch-acquire`, `post-scratch-acquire`, `pre-scratch-materialize`, `post-scratch-materialize`, `pre-scratch-start`, `post-scratch-start`, `pre-scratch-stop`, `post-scratch-stop`, `pre-scratch-destroy`, `post-scratch-destroy`, `pre-scratch-gc`, `post-scratch-gc` (published by `ScratchAppService` for every state transition of a scratch app; §21.6.2). The `App` scope events still fire from inside the scratch app's lifecycle with `app.kind === "scratch"`. |
| Sync | `pre-pull`, `post-pull`, `pre-push`, `post-push`, `pre-dataset-fetch`, `post-dataset-fetch`, `pre-dataset-apply`, `post-dataset-apply`, `pre-dataset-capture`, `post-dataset-capture`, `pre-dataset-send`, `post-dataset-send` (published by the `pull`/`push` orchestration over `RemoteSource` + `Dataset`; §10.12. A pull/push envelope wraps the composed `pre-/post-http-call` and `pre-/post-data-transfer` events) |
| Cross-cutting | `deprecation-used` (published whenever a registered deprecated surface is used at runtime; §18.4) |

CLI event names use the **canonical command id** (§8.1.1), not the top-level alias the user typed. Subscribing to `cli-app:start-run` catches the event whether the user invoked `lando app start` or `lando start`.

**CLI event mapping to OCLIF lifecycle:**

| Event suffix | Fires when | OCLIF hook |
|---|---|---|
| `-init` | The runtime has resolved which canonical command will run, but before its `run()` body executes. Bootstrap up to the command's declared `BootstrapLevel` is complete; argv is parsed; lifecycle and plugin subscribers are registered. | Command base after OCLIF resolution and runtime bootstrap |
| `-run` | The command's `run()` body has returned successfully. Fires before `Scope` finalizers run, so subscribers may inspect runtime services and the command's typed result. | OCLIF `postrun` |
| `-error` | The command's `run()` body raised a tagged error or was interrupted. The error is published as the event payload. Fires before `Scope` finalization. | OCLIF error path / `command_not_found` |

Exactly one of `-run` or `-error` fires for any given invocation; `-init` always fires first when the command is resolved (it does not fire for `command_not_found`).

Subscriber registration is declarative (manifest + subscriber module path). Runtime registration outside declared plugin entry points is not a public extension mechanism. The internal core code may register inline subscribers, but plugins always go through the manifest.

Every event payload is an Effect Schema. Subscribers receive a decoded, validated payload. Subscribers return `Effect.Effect<void, E>`; failures bubble up through the event service and (depending on the event) either abort the lifecycle step or are reported as warnings.

### 3.6 Imperative shells

The architecture supports any number of imperative shells over the runtime. Two are first-class in v4.0.0:

| Shell | Source | Imperative responsibilities |
|---|---|---|
| **CLI** | `src/cli/oclif/` + `bin/lando.ts` | argv parsing, help rendering, OCLIF hooks, `SIGINT` → `Effect.interrupt`, exit codes |
| **Embedding host** | A consumer's program importing `@lando/core` | Whatever input/output/signal model the host uses — core's runtime is signal-agnostic |

Both shells:

- Provide the AOT-composed bootstrap layer (§17.2 codegen, "Bootstrap layers") for the resolved `BootstrapLevel`. The embedding host calls `makeLandoRuntime({ bootstrapLevel })` (§16.3), which under the hood imports the same generated layer module the CLI command base uses. Runtime `Layer.merge` / `Layer.provide` chains in core are forbidden outside the codegen output (see §2.4).
- Run their program against that Layer with `Effect.provide` + `Effect.scoped`.
- Honor the same `BootstrapLevel` semantics, the same lifecycle event sequence, and the same plugin contribution graph.
- Are the *only* places where Effect crosses into Promise land via `Effect.runPromise`/`Effect.runFork`. The runtime itself is pure Effect.

Anything spec'd elsewhere as "the CLI does X" applies symmetrically to embedding hosts unless the spec explicitly says otherwise. The embedding part (§16) catalogs the differences.

A test harness is a third imperative shell, but `test/` consumes core through the same library entry point as embedding hosts; it is not separately spec'd.

### 3.7 Secret redaction

Redaction is a cross-cutting security invariant, not a per-surface convenience. The spec mandates "the same redaction" in many places — `${secret:…}` resolution (§7.3.1), `ProcessRunner` / `ShellRunner` / `BunSelfRunner` logs and events (§3.4), build-step transcripts (§6.13.6), host-proxy payloads (§10.10), file-sync events (§10.6), telemetry (§2.4 + the telemetry inventory), executable-guide and doctor transcripts (§19.6, §10.9), tooling caches (§12), and config-translator output (§7.4.1). This subsection is the **single canonical owner** those references resolve to. There is exactly one redaction implementation in v4; no surface ships its own regexes or sentinels.

**Two redaction layers, always composed in this order.** Redaction has two inputs that MUST combine, value-set first:

1. **Value layer (authoritative).** The set of *known* sensitive values for the current operation — every `${secret:…}` value the active `SecretStore` resolved, registry tokens (`BUN_AUTH_TOKEN`, scoped `_authToken`), resolved proxy credentials, and any per-call `redact:` tokens. These are masked by **literal** match, **longest-first**, so a shorter secret that is a substring of a longer one cannot leave the longer value's tail exposed. The value layer runs **before** the pattern layer; otherwise a normalizing pattern could rewrite the context around a literal secret and let the secret survive.
2. **Pattern layer (defense-in-depth).** A fixed catalog of pattern classes catches sensitive data that was never registered as a known value. Secret classes: `secretAssignment` (`FOO_TOKEN=…`, `token …`), `urlUserinfo` (`scheme://user:pass@`), `bearerToken`, `signedQueryParam` (`?token=`, `&X-Amz-Signature=`), and `secretKeyedField` (object keys matching `password|secret|token|credential|bearer|api[-_]?key|authorization`). Normalizing classes (privacy / determinism): `url`, `email`, `uuid`, `hostname`, `posixPath` / `windowsPath` / `uncPath` / `homeAlias`, `port`, `containerId`, `digest`, `highEntropyToken`, and literal `user` / `host` / `root` substitution.

**Profiles** select which pattern classes apply and the placeholder vocabulary; all profiles compose the value layer first:

| Profile | Classes | Output vocabulary | Consumers |
|---|---|---|---|
| `secrets` | value-set + the five secret classes + deep object key-name masking | single `[redacted]` sentinel | `Logger`, `EventService` payloads, `ProcessRunner`/`ShellRunner`/`BunSelfRunner`, `BuildOrchestrator`, `HostProxyService`, `TunnelService`, `ManagedFileService`, the CLI failure formatter / bug report |
| `telemetry` | `secrets` + the normalizing classes (low cardinality) | class placeholders `[path]`/`[url]`/`[host]`/`[email]`/`[id]` + `[redacted]` | `Telemetry` value scrub (the event-inventory allowlist is layered on top in core, not here) |
| `transcript` | `secrets` + the normalizing classes (byte-stable determinism) | deterministic placeholders `<HOME>`/`<TMP>`/`<PORT>`/`<CONTAINER_ID>`/`<DIGEST>`/`<PROVIDER_ID>`/`<USER>`/`<HOST>` | executable-guide public transcripts (§19.6), `lando doctor` transcripts (§10.9) |

**Layering: pure functions in the SDK, a thin service in core.**

- `@lando/sdk/secrets` ships the **pure, dependency-free** primitives: `createSecretRedactor(values)` (the value layer), the pattern-class catalog, the three profiles, the canonical `REDACTED` sentinel, and `createRedactor(profile, { secrets, env })` returning `{ redactString, redactValue }` (`redactValue` is the deep walker that also masks `secretKeyedField` object keys). Purity is required: the telemetry hot-enqueue path and the docs build call these without constructing a `LandoRuntime`.
- `@lando/core` ships `RedactionService` (§3.4), a thin Effect service that supplies the *live* value set (resolved secrets + token env + per-call tokens) and exposes `forProfile(profile) → Redactor`. Runner, event, build, and host-proxy surfaces consume it so they "observe redacted forms only."
- Core consumers that already own their value set or have none (the telemetry scrub, the docs transcript writer, the CLI bug-report formatter) call the pure `@lando/sdk/secrets` functions directly. The telemetry **event-inventory allowlist** and the transcript **frame walker** stay in core and compose the shared scrub — the primitive owns *string redaction*, those modules own their structural policy.

**Required behaviors.**

- `RedactionService` is constructed eagerly at level `minimal` and MUST NOT touch the network, the provider, or any plugin module.
- It is **not** a §4.2 pluggable abstraction. There is no `redactors:` contribution surface. Audited / sandboxed / mirror-aware `ShellRunner`, `BunSelfRunner`, `HostProxyService`, `FileSyncEngine`, `HttpClient`, `Downloader`, `TunnelService`, `DataMover`, and `ManagedFileService` consumers MUST compose the canonical redactor and MUST NOT weaken it; the relevant contract suites (§13.1) check this.
- The canonical sentinel is `[redacted]` (lowercase). The `transcript` profile's `<HOME>`/`<PORT>`/… placeholders are a separate normalizing vocabulary and are part of the published transcript redaction contract (§19.6); they are byte-stable and gated.
- `redactValue` preserves structure (arrays, objects, `Error` shape) and never throws on cyclic or exotic input.
- A merge-blocking lint gate (§13.4) forbids new `[redacted]`/`[REDACTED]` string literals and ad-hoc secret-matching regexes outside `@lando/sdk/secrets`, mirroring the §13.4 renderer-boundary gate; a fixture-based contract test asserts each profile redacts a canonical "secret soup" input byte-identically (§13.1).

---

## 11. Lifecycle and Events

### 11.1 The event service

`EventService` is an Effect-backed pub/sub bus. Subscribers register declaratively. Events propagate through `Effect.PubSub` so multi-subscriber concurrency is handled by Effect.

```ts
export class EventService extends Context.Service<EventService, {
  readonly publish: <E extends LandoEvent>(event: E) => Effect.Effect<void, EventError>;
  readonly subscribe: <E extends LandoEvent>(name: E["name"]) => Stream.Stream<E, EventError, Scope.Scope>;

  // Eagerly acquires a `PubSub` subscription queue in the caller's `Scope` so a consumer that
  // must not miss the first event subscribes *before* the producer runs (vs. the lazy `subscribe` stream).
  readonly subscribeQueue: Effect.Effect<Queue.Dequeue<LandoEvent>, never, Scope.Scope>;

  // Await the next matching event. `timeout` bounds the wait; on expiry the Effect fails with
  // `EventError` (`reason: "timeout"`) rather than blocking forever.
  readonly waitFor: <E extends LandoEvent>(
    name: E["name"],
    options?: { readonly filter?: (e: E) => boolean; readonly timeout?: DurationInput },
  ) => Effect.Effect<E, EventError>;

  // Await the next event matching ANY of several specs; resolves with the first to arrive.
  readonly waitForAny: <E extends LandoEvent>(
    specs: ReadonlyArray<{ readonly name: E["name"]; readonly filter?: (e: E) => boolean }>,
    options?: { readonly timeout?: DurationInput },
  ) => Effect.Effect<E, EventError>;

  // Scan the bounded in-memory event history for events ALREADY published this run that match
  // `name`/`filter`. Never blocks; returns redacted payloads only. Powers host "what already
  // happened" queries and `lando events` snapshots without racing the live stream.
  readonly query: <E extends LandoEvent>(
    name: E["name"] | "*",
    filter?: (e: E) => boolean,
  ) => Effect.Effect<ReadonlyArray<E>, EventError>;
}>()("@lando/core/EventService") {}
```

**Hot-path performance rules:**

- Subscriber lists are pre-sorted by priority (§11.3) **at registration time**, indexed by event name. `publish` does an O(1) lookup followed by an O(N) call over the already-sorted slice — no per-publish sort, no per-publish allocation of a filtered list.
- `publish` MUST short-circuit to a no-op when the event name has zero registered subscribers in the current runtime. This is the common case for `pre-bootstrap-*` events at level `tooling`: there are typically no plugin subscribers, and the no-op path skips payload schema validation, `Effect.PubSub` enqueue, and fiber scheduling entirely. The check is a single Map-keyed boolean (`hasSubscribers[eventName]`) populated at registration and at plugin install/remove.
- `EventService` is constructed eagerly at level `minimal` so that `publish` is callable from level-`minimal` code paths, but its internal subscriber index is empty until level `plugins` populates it. Calling `publish` at level `minimal` therefore always hits the zero-subscriber short-circuit unless core itself registered an internal subscriber (rare; see §11.3 priority bands).
- Plugins MUST NOT register subscribers for `pre-bootstrap-tooling` / `post-bootstrap-tooling` unless they declare `bootstrap: tooling` themselves; subscriber registrations whose declared bootstrap level exceeds the event's level are rejected at manifest validation with `SubscriberLevelMismatchError`. This keeps the tooling fast path's `hasSubscribers` map empty by construction in the common case.

**Query, timeout, and history.** `subscribe` is the live stream; `waitFor` / `waitForAny` are the one-shot awaits; `query` is the retrospective scan. They share one bounded history buffer:

- `EventService` retains a bounded in-memory ring buffer of recently published events (default cap is small and fixed; the oldest entries are evicted first). The buffer holds **redacted** payloads only — events are redacted through the canonical `RedactionService` (§3.7) *before* they are buffered, so `query`, host snapshots, and the executable-guide transcript writer can never observe an un-redacted payload. The buffer is a zero-allocation no-op when history is disabled (library hosts MAY set the cap to 0).
- `waitFor(name, { timeout })` MUST resolve from the live stream and MUST fail with `EventError` (`reason: "timeout"`) when the deadline elapses, driven through Effect's `Clock` so tests assert it under `TestClock`. Without `timeout` it waits indefinitely (the prior behavior). `waitForAny` resolves with the first matching event across its specs and honors the same timeout contract.
- `query(name, filter?)` scans the history buffer and returns matching events **without blocking** — it answers "did this already happen?" for a host or a guide assertion, where `waitFor` would race or hang because the event fired before the caller subscribed. `query` never observes events evicted from the buffer; a host that needs the full log subscribes early instead.
- These members are the runtime counterpart of the `@lando/core/testing` event helpers (§16.8): `expectEvent` / `waitForEvent` are thin wrappers over `waitFor`, and `recordedEvents` is `query("*")` over the test runtime's history. The typed generic signatures (`subscribe<E>` / `waitFor<E>` / `query<E>` narrowing on `E["name"]`) are normative here and enforced by `expectTypeOf` tests in `test/types/`.

### 11.2 Event payloads

Every event has a typed payload defined in `@lando/sdk` as an Effect Schema.

`AppRef` is the shared identity field on every App, Global, and Scratch scope payload. Since v4.0 it carries a `kind` discriminator that splits the identifier namespace across user, global, and scratch apps; subscribers MUST switch on `kind` (or on the per-scope `_tag`) when their behavior depends on which kind of app the event describes.

```ts
export const AppRef = Schema.Struct({
  kind: Schema.Literal("user", "global", "scratch"),
  id:   Schema.String,                                       // user slug, literal "global", or scratch id
  root: AbsolutePath,                                        // user app root, `<userDataRoot>/global/`, or `<userCacheRoot>/scratch/<id>/root/`
});
export type AppRef = Schema.Schema.Type<typeof AppRef>;

export const PreStartEvent = Schema.TaggedStruct("pre-start", {
  app: AppRef,
  plan: AppPlan,
  triggeredBy: Schema.String,
  timestamp: Schema.DateTimeUtc,
});
export type PreStartEvent = Schema.Schema.Type<typeof PreStartEvent>;
```

`PreScratchStartEvent` illustrates the Scratch-scope payload shape (§21.6.2 is canonical; remaining Scratch-scope events follow the same pattern):

```ts
export const PreScratchStartEvent = Schema.TaggedStruct("pre-scratch-start", {
  app: AppRef,                                               // .kind === "scratch"
  plan: AppPlan,
  source: ScratchSource,                                     // §21.4
  isolate: Schema.Literal("full", "baked", "cwd"),
  shareGlobalStorage: Schema.Boolean,
  detached: Schema.Boolean,
  triggeredBy: Schema.Union(
    Schema.Literal("apps:scratch:start"),
    Schema.Literal("scratch-acquire"),
    Schema.Literal("apps:scratch:gc"),
  ),
  timestamp: Schema.DateTimeUtc,
});
export type PreScratchStartEvent = Schema.Schema.Type<typeof PreScratchStartEvent>;
```

The `EventService.publish` signature is type-narrowed to the exact union of known event payloads; publishing an unknown event is a compile error.

`PreGlobalStartEvent` illustrates the Global-scope payload schema (§20.6.2 is canonical; remaining Global-scope events follow the same shape):

```ts
export const PreGlobalStartEvent = Schema.TaggedStruct("pre-global-start", {
  app: AppRef,                                            // .id is literally "global"
  plan: AppPlan,
  triggeredBy: Schema.Union(
    Schema.Literal("meta:global:start"),
    Schema.Literal("apps:poweroff"),
    Schema.Literal("ensure-running"),                     // auto-start from a user app's AppFeature dependency
    Schema.Literal("meta:setup"),
  ),
  ensuringServices: Schema.Array(Schema.String),          // services this invocation is checking; empty when not ensure-running
  cached: Schema.Boolean,                                 // true iff every service in ensuringServices was already running+healthy and no work was performed
  timestamp: Schema.DateTimeUtc,
});
export type PreGlobalStartEvent = Schema.Schema.Type<typeof PreGlobalStartEvent>;
```

`pre-global-start` and `post-global-start` follow always-emit semantics (§20.6.2): they fire for every `GlobalAppService.ensureRunning` invocation, distinguishing warm from cold via the `cached` field, so subscribers (telemetry, audit, executable-guide scenario transcripts) get a predictable "every user-app start emits exactly this sequence" contract. Sibling Global-scope payload schemas (`PostGlobalStartEvent`, `PreGlobalStopEvent`, `PreGlobalDistRegenerateEvent`, etc.) are enumerated in §20.6.2 and registered in `@lando/sdk` alongside the App scope's payloads.

`DeprecationUsedEvent` is a cross-cutting event in the same registry. Its payload schema and publication rules are spec'd in §18.4; it is part of the standard event taxonomy here so subscribers can discover it through the same `EventService.subscribe<DeprecationUsedEvent>("deprecation-used")` API as any other event.

`HostProxyCallEvent` is published for every container→host RPC dispatched by `HostProxyService` (§10.10). Both `pre-host-proxy-call` and `post-host-proxy-call` carry the redacted request shape, the calling service id, the inbound `LANDO_HOST_PROXY_DEPTH` value, and (for `post-`) the result summary and dispatch latency. Full unredacted payloads are available only to the active `Logger` at debug level; URL query strings, `runLando` argv tail values, and any `${secret:…}`-resolved tokens are redacted from the event payload identically to `pre-shell-exec` / `post-shell-exec` (§3.4).

```ts
export const HostProxyCallEvent = Schema.TaggedStruct("pre-host-proxy-call", {
  app: AppRef,
  callId: Schema.String,                                  // ULID; correlation key with the post- event
  request: HostProxyRequestRedacted,                      // shape matches §10.10.2 Wire protocol
  callerService: Schema.String,                           // resolved Lando service id of the caller
  depth: Schema.Number,                                   // inbound LANDO_HOST_PROXY_DEPTH
  timestamp: Schema.DateTimeUtc,
});
export type HostProxyCallEvent = Schema.Schema.Type<typeof HostProxyCallEvent>;
```

`BunSelfExecEvent` is published for every `BunSelfRunner` dispatch (§3.4). The `pre-` event fires before the child process is forked; the `post-` event fires after exit and includes the result summary. Both carry the redacted argv shape (verb-known calls store the structured verb plus its arguments; `run()` calls store the raw argv with secret-resolved values and `--*-token` values masked), the calling subsystem id, the registry summary (host + scope, never tokens), the dispatch `mode` (`embedded` for the BUN_BE_BUN self-spawn or `host` for the library-mode fallback), and the embedded Bun version. Argv values that resolve through `SecretStore` (§4.2) are redacted from the event payload and observable in full only by the active `Logger` at debug level, identical to `pre-shell-exec` / `post-shell-exec`.

```ts
export const BunSelfExecEvent = Schema.TaggedStruct("pre-bun-self-exec", {
  callId: Schema.String,                                  // ULID; correlation key with the post- event
  verb: Schema.Union(                                     // structured verb when known
    Schema.Literal("install"),
    Schema.Literal("add"),
    Schema.Literal("remove"),
    Schema.Literal("x"),
    Schema.Literal("create"),
    Schema.Literal("run-script"),
    Schema.Literal("build"),
    Schema.Literal("publish"),
    Schema.Literal("raw"),                                // freeform run() invocation
  ),
  argv: Schema.Array(Schema.String),                      // redacted argv as it would appear with BUN_BE_BUN=1
  cwd: AbsolutePath,
  callerSubsystem: Schema.String,                         // e.g. "plugin-install:meta:plugin:add", "recipe:bun:create:vite", "tooling-engine:bun-x"
  mode: Schema.Union(Schema.Literal("embedded"), Schema.Literal("host")),
  bunVersion: Schema.String,                              // version reported by the dispatched Bun
  registry: Schema.optional(Schema.Struct({
    host: Schema.String,                                  // never includes the auth token
    scope: Schema.optional(Schema.String),                // e.g. "@lando" for scoped registries
  })),
  timestamp: Schema.DateTimeUtc,
});
export type BunSelfExecEvent = Schema.Schema.Type<typeof BunSelfExecEvent>;
```

`ToolingStepEvent` and `ToolingStepResultEvent` cover the `tooling-step-*` family. They publish for every step in a compiled `ToolingProgram` (§8.5 / §8.6) at level `tooling` or higher; their `pre-<tool>` / `post-<tool>` siblings publish around the whole task and reuse the same payload shapes with `stepIndex: -1` to denote task-boundary frames. Step events carry the canonical task id, the step index and id, the step kind (`shell`, `command`, `engine-exec`, `script`), the resolved service target, and (for `complete`/`fail`) the exit code, duration, and a redacted reason.

```ts
export const ToolingStepEvent = Schema.TaggedStruct("tooling-step-start", {
  task: Schema.String,                                    // canonical id, e.g. "app:composer", "app:db:wait"
  stepIndex: Schema.Number,                               // 0-based position; -1 for the task-boundary frame
  stepId: Schema.optional(Schema.String),                 // user-supplied step name when present
  kind: Schema.Union(
    Schema.Literal("shell"),                              // ShellRunner-backed (host engine, .bun.sh, vars.sh)
    Schema.Literal("command"),                            // command: <canonical-id> step
    Schema.Literal("engine-exec"),                        // ToolingEngine.execute step (e.g., providerExec)
    Schema.Literal("script"),                             // recipe bun: { verb: script } / .bun.sh
  ),
  service: Schema.optional(Schema.String),                // resolved service target (`:host` for host-mode)
  timestamp: Schema.DateTimeUtc,
});
export type ToolingStepEvent = Schema.Schema.Type<typeof ToolingStepEvent>;

export const ToolingStepResultEvent = Schema.TaggedStruct("tooling-step-complete", {
  task: Schema.String,
  stepIndex: Schema.Number,
  stepId: Schema.optional(Schema.String),
  outcome: Schema.Union(
    Schema.Literal("complete"),                           // tooling-step-complete
    Schema.Literal("skip"),                               // tooling-step-skip (status/precondition)
    Schema.Literal("fail"),                               // tooling-step-fail
  ),
  exitCode: Schema.optional(Schema.Number),               // present for `complete`/`fail`
  durationMs: Schema.Number,
  reason: Schema.optional(Schema.String),                 // skip/fail remediation summary, redacted per §3.4
  timestamp: Schema.DateTimeUtc,
});
export type ToolingStepResultEvent = Schema.Schema.Type<typeof ToolingStepResultEvent>;
```

The `tooling-step-skip`, `tooling-step-complete`, and `tooling-step-fail` events all share the `ToolingStepResultEvent` payload via the discriminated `outcome` field; only the event `_tag` differs. `EventService.publish` is signature-narrowed to each `_tag`, so subscribers may type-discriminate on either the event name or the `outcome` field.

`BuildPhaseEvent`, `BuildStepEvent`, `BuildStepProgressEvent`, and `BuildStepResultEvent` cover the `Build` event scope (§3.5). They publish for every node in the `BuildPlan` DAG that `BuildOrchestrator` (§3.4) drives at level `app`. The `pre-build` / `post-build` pair brackets the whole DAG; `pre-build-phase` / `post-build-phase` brackets each of the two phases (`artifact`, `app`); `build-step-*` events fire for individual steps. Step events carry the resolved app and service ids, the phase, the planner-stamped `buildKey` (the SHA-256 over the resolved build script and its inputs that drives the up-to-date check; §6.13), the user-facing `stepId`, the `dependsOn` predecessor ids, and the redacted command shape. `build-step-progress` carries truncated streaming chunks tailed off the per-step transcript; the renderer's "tail" view (§8.9.2) is driven by these events. `build-step-skip` MUST fire (with `reason: "up-to-date"`) when the orchestrator short-circuits an unchanged step against the `build-results` cache (§12.1).

```ts
export const BuildPhaseEvent = Schema.TaggedStruct("pre-build-phase", {
  app: AppRef,
  phase: Schema.Literal("artifact", "app"),
  steps: Schema.Array(Schema.String),                     // stepIds in this phase
  failFast: Schema.Boolean,                               // resolved per-phase failure policy
  concurrency: Schema.Number,                             // resolved cap for this phase
  timestamp: Schema.DateTimeUtc,
});
export type BuildPhaseEvent = Schema.Schema.Type<typeof BuildPhaseEvent>;

export const BuildStepEvent = Schema.TaggedStruct("build-step-start", {
  app: AppRef,
  phase: Schema.Literal("artifact", "app"),
  service: ServiceName,
  stepId: Schema.String,                                  // e.g. "appserver:composer-install"
  buildKey: Schema.String,                                // content-hash; correlation key for transcripts and cache
  parentId: Schema.optional(Schema.String),               // task-tree parent (the phase node)
  dependsOn: Schema.Array(Schema.String),                 // predecessor stepIds in the BuildPlan DAG
  command: BuildCommandRedacted,                          // redacted argv/script shape
  transcriptPath: AbsolutePath,                           // path the orchestrator is writing to
  timestamp: Schema.DateTimeUtc,
});
export type BuildStepEvent = Schema.Schema.Type<typeof BuildStepEvent>;

export const BuildStepProgressEvent = Schema.TaggedStruct("build-step-progress", {
  stepId: Schema.String,
  buildKey: Schema.String,
  stream: Schema.Literal("stdout", "stderr"),
  data: Schema.Uint8ArrayFromBase64,                      // chunk; bounded by the orchestrator's per-event cap
  byteOffset: Schema.Number,                              // offset into the per-step transcript file
  parsed: Schema.optional(Schema.Unknown),                // optional structured projection (e.g., npm install --json)
  timestamp: Schema.DateTimeUtc,
});
export type BuildStepProgressEvent = Schema.Schema.Type<typeof BuildStepProgressEvent>;

export const BuildStepResultEvent = Schema.TaggedStruct("build-step-complete", {
  app: AppRef,
  phase: Schema.Literal("artifact", "app"),
  service: ServiceName,
  stepId: Schema.String,
  buildKey: Schema.String,
  outcome: Schema.Union(
    Schema.Literal("complete"),                           // build-step-complete
    Schema.Literal("skip"),                               // build-step-skip (up-to-date or precondition)
    Schema.Literal("fail"),                               // build-step-fail
  ),
  exitCode: Schema.optional(Schema.Number),               // present for `complete`/`fail`
  durationMs: Schema.Number,
  cached: Schema.Boolean,                                 // true when up-to-date short-circuit fired
  reason: Schema.optional(Schema.String),                 // "up-to-date" | redacted failure summary
  transcriptPath: Schema.optional(AbsolutePath),          // present for `complete`/`fail`; omitted for cached skips
  timestamp: Schema.DateTimeUtc,
});
export type BuildStepResultEvent = Schema.Schema.Type<typeof BuildStepResultEvent>;
```

The `build-step-skip`, `build-step-complete`, and `build-step-fail` events all share the `BuildStepResultEvent` payload via the discriminated `outcome` field; only the event `_tag` differs (mirrors the tooling-step pattern above). `BuildCommandRedacted` is shaped after the redacted command schema used by `pre-process-exec` / `pre-shell-exec`: `${secret:…}`-resolved values, registry tokens, and additional `redact:` tokens declared on the build script are masked before they reach the event payload, identical to §3.4. Full unredacted output is available only to the active `Logger` at debug level and to the per-step transcript file (§12.4) — never to subscribers.

`FileSyncSessionEvent` covers the `pre-/post-file-sync-create`, `pre-/post-file-sync-pause`, `pre-/post-file-sync-resume`, and `pre-/post-file-sync-terminate` family. They publish for every `FileSyncEngine` session-lifecycle transition (§10.6) and carry the resolved app and service ids, the engine id (`passthrough`, `mutagen`, plugin-supplied), the session id, the source/target shape (host path → volume name or service path), the canonical mount-source pair from §6.4 (so subscribers can correlate back to the user's Landofile entry), the sync mode, and the redacted excludes hash. Source paths under the host user's home directory are surfaced as-is to the active `Logger` at debug level and as a stable `${HOME}/<...>` shape to all other subscribers and the recorded transcript.

```ts
export const FileSyncSessionEvent = Schema.TaggedStruct("pre-file-sync-create", {
  callId: Schema.String,                                  // ULID; correlation key with the post- event
  app: AppRef,
  service: ServiceName,
  engine: Schema.String,                                  // resolved FileSyncEngine id
  sessionId: Schema.String,                               // engine-issued session id (e.g., Mutagen session id)
  source: AbsolutePath,                                   // host-side source; ${HOME} normalized for non-debug subscribers
  target: Schema.Union(
    Schema.TaggedStruct("volume",  { name: Schema.String, path: PortablePath }),
    Schema.TaggedStruct("service", { service: ServiceName,  path: PortablePath }),
  ),
  mode: Schema.Union(
    Schema.Literal("two-way-safe"),
    Schema.Literal("two-way-resolved"),
    Schema.Literal("one-way-safe"),
    Schema.Literal("one-way-replica"),
  ),
  excludesHash: Schema.String,                            // SHA-256 over the canonicalized excludes list
  mountKey: Schema.String,                                // stable id matching the §6.4 MountPlan it realizes
  timestamp: Schema.DateTimeUtc,
});
export type FileSyncSessionEvent = Schema.Schema.Type<typeof FileSyncSessionEvent>;
```

`FileSyncConflictEvent` (`file-sync-conflict-detected`) and `FileSyncProgressEvent` (`file-sync-progress`) carry per-frame data streamed from the engine. Conflicts include the affected paths and the conflict kind (`both-modified`, `delete-modify`, `permissions-divergence`); progress frames include byte counts and an opaque `phase` token so the renderer can drive a deterministic spinner without parsing engine-specific shape.

```ts
export const FileSyncConflictEvent = Schema.TaggedStruct("file-sync-conflict-detected", {
  app: AppRef,
  sessionId: Schema.String,
  paths: Schema.Array(PortablePath),
  kind: Schema.Union(
    Schema.Literal("both-modified"),
    Schema.Literal("delete-modify"),
    Schema.Literal("permissions-divergence"),
    Schema.Literal("symlink-divergence"),
  ),
  remediation: Schema.optional(Schema.String),
  timestamp: Schema.DateTimeUtc,
});
export type FileSyncConflictEvent = Schema.Schema.Type<typeof FileSyncConflictEvent>;

export const FileSyncProgressEvent = Schema.TaggedStruct("file-sync-progress", {
  app: AppRef,
  sessionId: Schema.String,
  phase: Schema.Union(
    Schema.Literal("initial-scan"),
    Schema.Literal("staging"),
    Schema.Literal("transitioning"),
    Schema.Literal("watching"),                            // steady-state; emitted at most once per session
  ),
  bytesPending: Schema.Number,                              // bytes left to transfer in the current phase
  bytesTotal: Schema.optional(Schema.Number),               // populated for `staging` / `transitioning`
  timestamp: Schema.DateTimeUtc,
});
export type FileSyncProgressEvent = Schema.Schema.Type<typeof FileSyncProgressEvent>;
```

The `FileSyncEngine` Live Layer is responsible for translating engine-native progress streams (Mutagen's `Synchronization.List` watch stream, in the bundled implementation) into these events; the Renderer consumes them through the standard `EventService.subscribe` path so accelerated mounts get the same first-paint and spinner treatment as any other long-running operation (§8.9).

### 11.3 Subscriber priority

Subscribers register a priority (lower runs first). Priority bands are:

| Band | Range | Use |
|---|---|---|
| `critical` | 0–9 | Critical-path setup |
| `early` | 10–99 | Core early work |
| `default` | 100–999 | Default for user/plugin subscribers |
| `late` | 1000–9999 | Late housekeeping, scanner |
| `final` | 10000+ | Final cleanup |

Built-in core subscribers are placed in `critical` and `late`. Plugin subscribers default to `default`.

### 11.4 Standard event sequence

Cold `lando start` event sequence (illustrative; canonical id `app:start`):

```text
pre-bootstrap-minimal      → config/cache/event services warm
post-bootstrap-minimal
pre-bootstrap-plugins      → plugin manifests loaded
post-bootstrap-plugins
pre-bootstrap-commands     → command registry service available
post-bootstrap-commands
pre-bootstrap-provider     → provider selected, capability check
post-bootstrap-provider
pre-bootstrap-app          → Landofile parsed, plan assembled
post-bootstrap-app
post-bootstrap
ready
cli-app:start-init         → command resolved, runtime ready, run() not yet called
pre-init                   → app instance created
post-init
pre-start                  → user-defined pre-start subscribers
  pre-global-start { triggeredBy: "ensure-running", ensuringServices: [...] }
                           → only when AppFeature.requires.globalServices yields a non-empty service set
                           → warm path emits with cached: true and no nested global build block
    pre-build (global)                                        → BuildOrchestrator (§6.13) for the global app's plan
      …                                                        (analogous to user-app build phases below)
    post-build (global)
  post-global-start
  pre-build                                                 → BuildOrchestrator entered (§6.13) for the user app
    pre-build-phase { phase: "artifact" }                   → DAG nodes for build.artifact + group-weighted instructions
      build-step-start  { service: "appserver", buildKey, … }   ┐
      build-step-start  { service: "node",      buildKey, … }   │  (concurrent siblings; cap = build.concurrency.artifact)
      build-step-start  { service: "db",        buildKey, … }   │  failFast: true — first failure interrupts siblings
      build-step-progress { stepId, stream: "stdout"|"stderr" }*│  (streamed chunks drive renderer §8.9.2 tail)
      build-step-complete | build-step-skip | build-step-fail   ┘
    post-build-phase { phase: "artifact" }
    pre-build-phase { phase: "app" }                        → DAG nodes for build.app (composer install, npm ci, …)
      build-step-start  { service: "appserver", buildKey, … }   ┐
      build-step-start  { service: "node",      buildKey, … }   │  (concurrent siblings; cap = build.concurrency.app)
      build-step-progress { stepId, stream, … }*                │  failFast: false — every sibling runs to completion
      build-step-complete | build-step-skip | build-step-fail   ┘  (failures aggregated, surfaced after the phase)
    post-build-phase { phase: "app" }
  post-build                                                → all phases drained; aggregated failures (if any) raise
post-start
  (priority 1) running-state check
  (priority 2) healthchecks
  (priority 10) url scan
ready-app
cli-app:start-run          → OCLIF postrun: run() returned successfully
                              (or cli-app:start-error if run() raised; mutually exclusive)
before-exit
```

The `pre-global-start` … `post-global-start` block ALWAYS fires inside `pre-start` when the planner's `AppFeature.requires.globalServices` aggregation yields a non-empty set, regardless of whether those services are already running (§20.6.2 always-emit semantics). The payload's `cached:` field distinguishes warm (`true` — fast no-op body, no `pre-build` block) from cold (`false` — full `start({ services: needed })` plus any non-up-to-date `pre-build` activity). Subscribers that want to act only on cold-path starts gate their work on `event.cached === false`; the §11.1 zero-subscriber short-circuit makes the warm publish essentially free when nothing is listening.

The `Build` scope replaces the v1 of this section's "(priority 100) artifact build / (priority 110) per-service app build" prose. The two phases remain ordered (artifact → app, per service) — the priority numbers survive as the *phase boundaries* the event sequence renders — but siblings inside a phase run concurrently per the §6.13 DAG semantics. Within a service the orchestrator still serializes `artifact` → `app` (the `lando.boot` scaffolding lives inside the built artifact). Compose `depends_on:` flows through into app-build ordering so an `npm run seed` step that needs the db waits for `db` to come up before it runs.

`lando stop`, `rebuild`, and `destroy` follow analogous sequences with their own `pre-*`/`post-*` pairs and their own `cli-<canonical-id>-init`/`-run`/`-error` triplet at the same positions relative to bootstrap.

### 11.5 Hot-path events

Tooling commands at `bootstrap: tooling` skip most of the sequence above. A top-level tooling task emits the CLI and task boundary events below; dependency and command-step progress is emitted as renderer events and the optional typed tooling-step events from §3.5/§8.5. CLI event names use the canonical command id (§8.1.1) — for a tooling task `composer` the canonical id is `app:composer` regardless of whether the user invoked `lando app composer` or `lando composer` via a top-level alias.

```text
cli-<canonical-id>-init
pre-<tool>
  tooling-step-start / tooling-step-skip / tooling-step-complete / tooling-step-fail
post-<tool>
cli-<canonical-id>-run
```

Plugins that need to react to lifecycle changes for caching or telemetry MUST handle missing app/provider pre-/post- events gracefully when running in tooling fast path. Tooling dependency graphs MUST NOT force `bootstrap: app` merely to publish step events; step payloads are derived from the cached `ToolingProgram` and invocation input.

### 11.6 Subscriber failure handling

- Subscriber errors at `pre-*` events abort the lifecycle step with the subscriber's tagged error.
- Subscriber errors at `post-*` events are logged at warn level and do not abort.
- Subscriber errors at `cli-*` events are logged at debug level; they don't change exit codes.
- Subscribers may opt into "abort on error" at `post-*` events via `manifest.subscribers[].abortOnError: true`.

---
