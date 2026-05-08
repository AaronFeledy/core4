# Lando v4 — Architecture, Lifecycle, and Events

> **Part 3 of 16** · [Index](./README.md)
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
| `app` | Landofile parse, includes resolution, service plan, app state | `app:start`, `app:stop`, `app:info`, `app:rebuild`, `app:destroy`, `app:cache:refresh` |

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
│   └── renderer-listr/
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
| `RuntimeProviderRegistry` | Provider discovery, selection | `RuntimeProviderRegistryLive` |
| `AppPlanner` | Service plan, route plan | `AppPlannerLive` |
| `EventService` | Pub/sub over typed lifecycle events | `EventServiceLive` |
| `CacheService` | Atomic cache reads/writes, invalidation | `CacheServiceLive` |
| `FileSystem` | `Bun.file` / `Bun.write` wrapper | `FileSystemBunLive` |
| `ProcessRunner` | Argv-precise subprocess spawn (`Bun.spawn`) | `ProcessRunnerBunLive` |
| `ShellRunner` | Cross-platform shell-shaped execution (pipes, redirection, globs, built-ins) via `Bun.$` (Bun Shell) | `ShellRunnerBunLive` |
| `PrivilegeService` | sudo/UAC dispatch | `PrivilegeServiceLive` (platform-specific) |
| `EmbeddedAssetService` | Unified access to build-embedded assets and library-mode package assets | `EmbeddedAssetServiceLive` |
| `Logger` | Structured logging through Effect | `LoggerLive` (Effect `Logger.pretty` by default; `Layer.suspend`-wrapped — built on first `yield* Logger`) |
| `Renderer` | CLI output strategy | `RendererLive` (default Lando renderer; `Layer.suspend`-wrapped, with a pre-bootstrap direct-write fallback for first-paint banners; §8.9) |
| `DeprecationService` | Records deprecated-surface usage, dedupes per process, publishes `deprecation-used` events, and answers lookups for `lando doctor` / `lando config` / docs build (§18) | `DeprecationServiceLive` (constructed eagerly at level `minimal`; registry index populated at level `plugins`) |
| `HostProxyService` | Per-app container→host RPC: opens `<userDataRoot>/run/<app-id>/host-proxy.sock`, dispatches `openUrl` (host browser open) and `runLando` (in-process re-entry into `@lando/core/cli`) requests from in-container shims, enforces token auth and the §10.10 message allowlist, publishes `pre-host-proxy-call` / `post-host-proxy-call` lifecycle events | `HostProxyServiceLive` (lazy via `Layer.suspend`; only constructed when the active app plan includes the `lando.host-proxy` feature, §6.11) |
| `Telemetry` | Core usage stats, enabled by default unless disabled by config/env | `TelemetryLive` (fire-and-forget; never blocks command exit; §2.4) |

Every service is consumed via `yield* ServiceTag` inside `Effect.gen`. Type errors at the Layer composition boundary catch missing services at compile time. Services in this table are core-provided runtime services; not every one is plugin-replaceable. Plugin-replaceable abstractions are enumerated in §4.2. `EmbeddedAssetService` is overrideable by tests and embedding hosts, but is not a plugin contribution surface because it protects binary/package asset integrity.

**`ProcessRunner` vs `ShellRunner` — when to use which.** Both spawn host processes; they exist for distinct shapes of work and are deliberately complementary, not redundant.

| Concern | `ProcessRunner` | `ShellRunner` |
|---|---|---|
| Primitive | `Bun.spawn(argv, opts)` | `` Bun.$`…` `` (Bun Shell, in-process bash-like interpreter) |
| Input shape | Exact `argv: string[]` plus options | Tagged template literal with safe-by-default interpolation |
| Shell features | None — no parsing, no expansion, no built-ins | Pipes (`\|`), redirection (`<`, `>`, `2>&1`), globs (`*`, `**`, `{a,b}`), command substitution (`$(…)`), built-in `cd`/`ls`/`rm`/`mkdir`/`cat`/`mv`/`which`, env var expansion |
| Cross-platform on Windows | Whatever the spawned binary supports | Built-ins are reimplemented in Bun, so `rm -rf` / `mkdir -p` / globs work on Windows without `rimraf` / `cross-env` |
| Typical callers | Provider exec (`docker exec`, `podman exec`), signing tools (`codesign`, `signtool`, `cosign`), `bun add`, plugin-supplied external binaries | The `host` ToolingEngine (§8.6), tooling `vars.<name>.sh:` for `service: :host` (§8.5.3), `.bun.sh` scripts (§8.5.9), the `lando shell` REPL (§8.2), host-side healthcheck/url-scanner plugins (§10.5), recipe `bunScript:` post-init (§8.8.8) |
| Injection risk | Minimal (no shell parses the argv) | Mitigated by Bun Shell's automatic escaping of interpolated values; explicit `{ raw: "…" }` is required to opt out |
| Cancellation | `Effect.interrupt` → `proc.kill(SIGTERM)` then `SIGKILL` | `Effect.interrupt` → `proc.kill()` on the underlying Bun Shell process; scope finalizers reap any spawned children |

A simple rule: if the work is "spawn this exact binary with these exact arguments," use `ProcessRunner`. If the work would naturally be a one-liner in `bash` and you want it to also work on Windows, use `ShellRunner`. Core code MUST NOT use one to imitate the other (no `ProcessRunner.run(["sh", "-c", "…"])`, no `ShellRunner` calls that just re-encode argv as a literal string).

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
  // ToolingEngine for §8.5.9 script-backed tasks and by the recipe `bunScript:` action (§8.8.8).
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
- `pre-shell-exec` / `post-shell-exec` events publish a `ShellExecEvent` payload with the canonical id of the calling subsystem (e.g., `tooling-engine:host`, `recipe:bunScript`, `lando-shell`), the redacted command shape, the cwd, and the result summary; full unredacted output is available only to the active `Logger` at debug level.
- `Effect.interrupt` MUST propagate to `proc.kill()` and the service's `Scope` MUST reap any child processes spawned from inside the shell template.
- `runScript(file)` MUST verify the file resides under a permitted base (the app root, the user-config root's `recipes/` cache, or an explicitly opted-in include root) and MUST refuse to execute scripts whose realpath escapes those bases. Symlink traversal is rejected with `ShellScriptOutsideRootError`.
- The service MUST be safe to use from inside `bootstrap: tooling` commands; instantiating the default Live Layer MUST NOT touch the network, the provider, or any plugin module.

Tagged errors live in `@lando/core/errors`:

- `ShellExecError` — non-zero exit, signal kill, timeout, or shell-parse failure. Payload includes redacted command, exitCode, signal, stdout/stderr (truncated and redacted), and remediation.
- `ShellInterpolationError` — a `{ raw: … }` wrapper used in a context where unsafe interpolation is forbidden (e.g., recipe `bunScript:`). Includes the offending position and remediation.
- `ShellScriptOutsideRootError` — `runScript` rejected because the file's realpath escapes the permitted base. Includes both paths.
- `ShellRunnerUnavailableError` — the active Live Layer cannot satisfy the request (e.g., a dry-run plugin that refuses real execution outside an allowlist).

**Service membership per bootstrap level.** Each `BootstrapLevel` (§3.2) corresponds to an AOT-composed layer (§17.2 codegen, "Bootstrap layers"). The composition is:

| Level | Services included (eager) | Services included (`Layer.suspend`-wrapped, lazy on first access) | Services NOT in this layer |
|---|---|---|---|
| `none` | *none* — no Effect runtime constructed | *none* | every service |
| `minimal` | `ConfigService`, `FileSystem`, `ProcessRunner`, `EmbeddedAssetService`, `CacheService`, `EventService`, `DeprecationService`, `TemplateEngineRegistry` (built-in `lando` engine pre-registered), `TemplateRenderer` | `Logger`, `Renderer`, `Telemetry`, `ShellRunner` | plugins, commands, providers, app planner, networking subsystems |
| `plugins` | `minimal` + `PluginRegistry`, `ConfigTranslatorRegistry`; plugin-contributed `TemplateEngine` impls register here | `minimal`'s lazy + `PrivilegeService` | commands beyond registry, providers, app planner |
| `commands` | `plugins` + `CommandRegistry` | `plugins`'s lazy | providers, app planner |
| `tooling` | `commands` + cached `ToolingProgram` reader | `commands`'s lazy + `ToolingEngine` (resolved from cache) | live providers, full app planner |
| `provider` | `commands` + `RuntimeProviderRegistry` (selected adapter constructed) | `commands`'s lazy + `CertificateAuthority`, `ProxyService` | full app planner |
| `app` | `provider` + `AppPlanner`, `LandofileService` | `provider`'s lazy + `HealthcheckRunner`, `UrlScanner`, `HostProxyService` | *(none — this is the maximal layer)* |

The "lazy" column lists services that the codegen wraps in `Layer.suspend` so their `Live` body never executes unless something at runtime actually requests them. This keeps cold-path overhead off the hot path: a `lando list` at level `minimal` doesn't construct `Telemetry` unless a subscriber actually publishes a telemetry event during the run, and doesn't construct `ShellRunner` unless something at runtime actually shells out (the same caller that needs the host engine, a `vars.sh:` evaluator, or a `.bun.sh` script).

`Renderer`'s Layer.suspend wrapping cooperates with the first-paint contract in §8.9 — a pre-bootstrap direct-write fallback prints the initial banner before the suspended `Renderer` Layer is forced.

### 3.5 Lifecycle events

Events are typed and validated. Subscribers register through plugin manifests.

| Scope | Standard events |
|---|---|
| Lando | `pre-bootstrap-<level>`, `post-bootstrap-<level>`, `post-bootstrap`, `ready`, `pre-setup`, `post-setup`, `before-exit` |
| App | `pre-init`, `post-init`, `pre-start`, `post-start`, `pre-stop`, `post-stop`, `pre-rebuild`, `post-rebuild`, `pre-destroy`, `post-destroy` |
| Provider | `pre-provider-apply`, `post-provider-apply`, `pre-provider-exec`, `post-provider-exec`, `pre-provider-logs`, `post-provider-logs` |
| Process / Shell | `pre-process-exec`, `post-process-exec`, `pre-shell-exec`, `post-shell-exec` |
| Host proxy | `pre-host-proxy-call`, `post-host-proxy-call` (published for every container→host RPC dispatched by `HostProxyService`; §10.10) |
| Tooling | `pre-<tool>`, `post-<tool>`, `tooling-step-start`, `tooling-step-complete`, `tooling-step-skip`, `tooling-step-fail` |
| CLI | `cli-<canonical-id>-init`, `cli-<canonical-id>-run`, `cli-<canonical-id>-error` (e.g. `cli-app:start-init`, `cli-app:start-run`, `cli-meta:plugin:add-run`) |

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

---

## 11. Lifecycle and Events

### 11.1 The event service

`EventService` is an Effect-backed pub/sub bus. Subscribers register declaratively. Events propagate through `Effect.PubSub` so multi-subscriber concurrency is handled by Effect.

```ts
export class EventService extends Context.Service<EventService, {
  readonly publish: <E extends LandoEvent>(event: E) => Effect.Effect<void, EventError>;
  readonly subscribe: <E extends LandoEvent>(name: E["name"]) => Stream.Stream<E, EventError, Scope.Scope>;
  readonly waitFor: <E extends LandoEvent>(name: E["name"], filter?: (e: E) => boolean) => Effect.Effect<E, EventError>;
}>()("@lando/core/EventService") {}
```

**Hot-path performance rules:**

- Subscriber lists are pre-sorted by priority (§11.3) **at registration time**, indexed by event name. `publish` does an O(1) lookup followed by an O(N) call over the already-sorted slice — no per-publish sort, no per-publish allocation of a filtered list.
- `publish` MUST short-circuit to a no-op when the event name has zero registered subscribers in the current runtime. This is the common case for `pre-bootstrap-*` events at level `tooling`: there are typically no plugin subscribers, and the no-op path skips payload schema validation, `Effect.PubSub` enqueue, and fiber scheduling entirely. The check is a single Map-keyed boolean (`hasSubscribers[eventName]`) populated at registration and at plugin install/remove.
- `EventService` is constructed eagerly at level `minimal` so that `publish` is callable from level-`minimal` code paths, but its internal subscriber index is empty until level `plugins` populates it. Calling `publish` at level `minimal` therefore always hits the zero-subscriber short-circuit unless core itself registered an internal subscriber (rare; see §11.3 priority bands).
- Plugins MUST NOT register subscribers for `pre-bootstrap-tooling` / `post-bootstrap-tooling` unless they declare `bootstrap: tooling` themselves; subscriber registrations whose declared bootstrap level exceeds the event's level are rejected at manifest validation with `SubscriberLevelMismatchError`. This keeps the tooling fast path's `hasSubscribers` map empty by construction in the common case.

### 11.2 Event payloads

Every event has a typed payload defined in `@lando/sdk` as an Effect Schema.

```ts
export const PreStartEvent = Schema.TaggedStruct("pre-start", {
  app: AppRef,
  plan: AppPlan,
  triggeredBy: Schema.String,
  timestamp: Schema.DateTimeUtc,
});
export type PreStartEvent = Schema.Schema.Type<typeof PreStartEvent>;
```

The `EventService.publish` signature is type-narrowed to the exact union of known event payloads; publishing an unknown event is a compile error.


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
  (priority 100) artifact build
  (priority 110) per-service app build
post-start
  (priority 1) running-state check
  (priority 2) healthchecks
  (priority 10) url scan
ready-app
cli-app:start-run          → OCLIF postrun: run() returned successfully
                              (or cli-app:start-error if run() raised; mutually exclusive)
before-exit
```

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
