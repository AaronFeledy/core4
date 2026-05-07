# Lando v4 — Toolchain

> **Part 2 of 15** · [Index](./README.md)
> **Read next:** [03 Architecture](./03-architecture.md)

This part defines the technology stack and the rules each piece imposes. Bun is the runtime, package manager, test runner, subprocess driver, file IO layer, and bundler. TypeScript runs natively under Bun with strict settings. OCLIF is the bundled CLI framework. Effect is the runtime model for every meaningful operation in core. Effect Schema is the single source of truth for every external contract. The section also lists the runtime dependencies that are forbidden in core source.

---

## 2. Toolchain

### 2.1 Bun

Bun is the runtime, the package manager, the test runner, the bundler, and the binary packager. Lando v4 takes maximum advantage of Bun's native primitives.

**Required policies:**

- `bun.lock` is the lockfile. `package-lock.json` and `yarn.lock` are forbidden.
- `bun install` is the dependency installer. Plugin install hooks use `Bun.spawn` to invoke it.
- `bun test` is the unit test runner. Vitest, Jest, and Mocha are forbidden in core (plugins may use what they like).
- `Bun.spawn` is the subprocess primitive everywhere. `node:child_process` is forbidden in core except behind a `ProcessRunner` adapter that may need it for plugin compatibility.
- `Bun.file` and `Bun.write` are the filesystem primitives. `node:fs` is allowed only inside the `FileSystem` adapter implementation when Bun lacks a primitive (e.g., `fs.watch` parity).
- TypeScript executes natively. No `tsc` build step in the development loop. `tsc --noEmit` is allowed for type-checking gates.
- ESM only. CommonJS is rejected in core source. Plugins may publish CJS; the plugin loader handles the interop.

**Bun version floor:** TBD (§14). Aim for the latest stable Bun at the moment of v4.0.0 GA, with a documented minimum.

**Single-executable distribution.** The default Lando v4 binary is built with `bun build --compile`:

```bash
bun build ./bin/lando.ts \
  --compile \
  --bytecode \
  --target=bun-${TARGET} \
  --outfile=dist/lando-${TARGET} \
  --minify \
  --sourcemap=external
```

`--bytecode` is REQUIRED. It precompiles JavaScript to V8 bytecode at build time and embeds the bytecode in the binary, eliminating per-invocation parse cost on cold start. The resulting binary is ~30% larger but starts measurably faster — the cold-start budgets below assume bytecode caching is on. If a future Bun version regresses or removes `--bytecode`, the build floor moves with it; the flag is not optional. The Bun version floor for v4.0.0 GA is tracked in §14.2 and MUST be one that supports stable `--bytecode` for every cross-compile target listed below.

Cross-compilation targets: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, `bun-windows-x64`. Each release ships all five.

The build invocation above is one stage of the larger release pipeline (codegen, type-check, lint, test, compile, sign, notarize, manifest, provenance, publish). The full ordered pipeline, the orchestrator script, signing/notarization rules, supply-chain artifacts, and the self-update mechanism live in §17 ([15 Binary Build and Release Engineering](./15-binary-build-and-release.md)).

**Compiled-binary constraints.** Bun-compiled binaries only embed modules and assets that are visible to the build graph. Build-known code and data therefore must be statically imported or explicitly embedded. Runtime-installed plugin code is different: it intentionally lives outside the binary and is loaded from Lando-managed disk locations through absolute `file://` dynamic imports after validation and lockfile checks (§9.7). This forces two architectural choices:

1. **Bundled plugins are statically imported.** The build emits a generated `src/plugins/bundled.ts` that imports each bundled plugin's entry point. These plugins are part of the binary's build graph and never require runtime filesystem discovery.
2. **External plugins are loaded from locked stores.** User, system, and app-scoped plugins are resolved to concrete package roots under Lando-controlled plugin stores (or trusted local `pluginDirs:`), validated, compatibility-checked, root-contained, and then imported by absolute `file://` URL. They are not embedded in the binary.
3. **OCLIF manifests must be precomputed.** `oclif.manifest.json` is generated at build time and embedded as an asset import. Lazy command discovery from installed plugins happens from Lando's validated command cache, not via a directory walk inside the binary.

The asset-embedding policy (which mechanism core uses for which kind of data, and the unifying `EmbeddedAssetService` API) is specified in §17.3.

**Performance commitments.** Lando v4 must beat v3 startup time on equivalent commands. Two budget tables apply: an **end-to-end budget** (process spawn through final exit) and a **perceived-performance budget** (when the user actually sees output). Both are enforced by the per-PR perf-budget test layer (§13.1) and the §13.4 merge gate.

End-to-end targets:

| Command | v4 budget (cold) | v4 budget (hot) |
|---|---|---|
| `lando --version` / `lando version` (alias of `meta:version`, level `none`; §3.2) | < 50 ms | < 30 ms |
| `lando shellenv` (alias of `meta:shellenv`, level `none`) | < 50 ms | < 30 ms |
| `lando recipes` (alias of `meta:recipes:list`, level `none`) | < 80 ms | < 50 ms |
| `lando list` (alias of `apps:list`, no apps; level `minimal`) | < 200 ms | < 100 ms |
| `lando <tooling-cmd>` (running app; level `tooling` hot path) | < 600 ms (incl. provider exec) | < 250 ms (incl. provider exec) |

Perceived-performance targets — measured from process spawn to the corresponding stdout/stderr write:

| Signal | Budget (cold) | Applies to |
|---|---|---|
| First byte to stdout/stderr | < 50 ms | every command whose end-to-end budget exceeds 100 ms |
| First meaningful line (banner, action verb, app name) | < 80 ms | every command at level ≥ `plugins` |
| Spinner / progress visible | within 100 ms of starting any operation expected to exceed 200 ms | renderers |
| Final completion line | within 50 ms of the last work step finishing | every renderer |

The perceived-performance budget exists because a 250 ms blank terminal feels slower than 250 ms of "Starting myapp…" followed by streaming progress. The Renderer contract (§8.9) enforces these timings for TTY output; non-TTY (CI, JSON) output is exempt from the spinner/progress rule but MUST still emit the first line within 80 ms when the end-to-end budget exceeds 100 ms.

Level-`none` commands have no first-paint requirement separate from their end-to-end budget — by definition they print and exit in under 80 ms cold. They MUST NOT construct an Effect runtime (§3.2) or import `@oclif/core`; the `bin/lando.ts` entry sniffs argv and short-circuits to a static print path before any heavyweight import resolves.

### 2.2 TypeScript

The implementation language is TypeScript with the strictest reasonable settings.

**Required `tsconfig.json` flags:**

```json
{
  "compilerOptions": {
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "moduleResolution": "bundler",
    "module": "esnext",
    "target": "esnext",
    "lib": ["esnext"],
    "types": ["bun-types"],
    "isolatedModules": true,
    "skipLibCheck": false
  }
}
```

`exactOptionalPropertyTypes` is required because Effect Schema relies on it for accurate optional-property semantics.

**Public API discipline:**

- All public types are *inferred* from Effect Schema. Direct `interface` and `type` declarations on public boundaries are forbidden where a schema can be the source of truth.
- Internal types may use plain `interface`/`type` freely.
- The plugin SDK (`@lando/sdk`) re-exports the schemas plus their inferred types so plugin authors get one source of truth.

**Module hygiene:**

- One public symbol per file is preferred for top-level exports.
- Barrel files (`index.ts`) only at package boundaries, never inside packages.
- Side-effect imports are forbidden in core. Every module must be tree-shakeable.

### 2.3 OCLIF

OCLIF is the bundled CLI framework. We considered `@effect/cli` and decided against making it the default. The reasoning is documented in §15.D.

**Why OCLIF stays the default:**

- The plugin manifest model (`oclif.manifest.json`) gives Lando the fast-startup behavior it needs without re-inventing it.
- Plugin discovery, install, update, and friendly-name registries are battle-tested across Heroku and Salesforce.
- The `flexibleTaxonomy` and topic system map directly onto Lando's command + tooling + topic surface.
- Hooks (`init`, `prerun`, `postrun`, `command_not_found`) are exactly the right shape for our bootstrap and event system.

**Required OCLIF policies:**

- Every plugin contributes its commands through the Lando manifest. The OCLIF adapter compiles that cached command metadata into OCLIF command shims; Lando does not use OCLIF's user plugin loader as the source of truth. Plugins may also define richer Lando-specific contributions (service types, features, providers, proxies, renderers, etc.) through the same manifest. Recipes are not a plugin contribution surface in v4 — they are init-time scaffolds (§8.8) consumed once and never referenced again.
- `oclif.manifest.json` is generated at build time for built-ins and bundled command shims. Plugin install regenerates Lando's plugin command index and the OCLIF adapter shim cache.
- Lazy command loading is mandatory. A command's `run()` is the only place its module body executes.
- Hooks: `init` runs router bootstrap only. After command resolution, the command base builds the Effect runtime at the command's declared/effective `BootstrapLevel`. `postrun` raises success lifecycle events. `command_not_found` consults cached command indexes before falling through to OCLIF's default.
- Flexible taxonomy is enabled. `lando app logs --service web` and `lando app:logs --service web` are both legal; top-level aliases (§8.1.2) like `lando logs --service web` resolve to the same command.
- Topics map to namespaces (§8.1.1): `app:`, `apps:`, `meta:` are the three core topics; plugins MAY register their own top-level topics under their `cspace:`. Topic separators (`:` and ` `) are interchangeable in input.

**OCLIF-as-pluggable.** The `CommandFramework` abstraction (§4) wraps OCLIF behind an interface. A plugin author who wants to ship a Lando distribution backed by `@effect/cli` may do so. Core does not promise it will be easy. Core *does* promise the abstraction exists and that no core module imports from `@oclif/core` outside `src/cli/oclif/`.

### 2.4 Effect

Effect is the runtime model. Every meaningful operation in core returns an `Effect.Effect<A, E, R>`.

**Required Effect policies:**

- Services are defined with `Context.Service` (the 3.0+ pattern). The older `Context.Tag()()` pattern is forbidden in new code.
- Services are consumed via `yield* ServiceTag` inside `Effect.gen`.
- All services are provided by `Layer`s. Layers compose with `Layer.merge`, `Layer.provide`, and `Layer.scoped`.
- **Bootstrap layers are AOT-composed at build time.** A codegen step (§17.2, "Bootstrap layers") emits one prebuilt static layer per `BootstrapLevel` (§3.2): `src/runtime/generated/layers/none.ts`, `…/minimal.ts`, `…/plugins.ts`, `…/commands.ts`, `…/tooling.ts`, `…/provider.ts`, `…/app.ts`. The imperative shell (CLI command base, embedding host) imports the layer for the resolved level and provides it directly. Runtime `Layer.merge` / `Layer.provide` chains in core are forbidden outside the codegen output, the testing helpers, and embedding-host opt-ins. This eliminates per-invocation Layer-graph resolution cost.
- **Non-critical-path services use `Layer.suspend`.** Any service that is not always required at its declared bootstrap level (e.g., `Telemetry`, `UrlScanner`, `HealthcheckRunner`, `Renderer` at level `none`) MUST be wrapped in `Layer.suspend` so its construction is deferred until the first `yield* ServiceTag` access. Always-required services at a level (e.g., `ConfigService` at `minimal`, `RuntimeProviderRegistry` at `provider`) MAY use eager construction.
- Resource-bearing services use `Layer.scoped` so finalizers run on shutdown, error, or interruption.
- All errors are `Schema.TaggedError` subclasses. `throw` is forbidden in core except inside `Effect.try` adapter wrappers.
- All structured data crossing the trust boundary (Landofile, plugin manifests, env vars, CLI args, plugin contributions) is validated by Effect Schema before it touches business logic.
- Long-running output (logs, progress, build streams) is `Stream<Chunk, E, R>`. Plain async iterators are forbidden in core public API.
- Concurrency uses Effect primitives (`Effect.all` with `concurrency: N`, `Effect.forEach`, `Stream.merge`, `Semaphore`, `RateLimiter`). Manual `Promise.all` with concurrency control is forbidden in core.
- **Intra-level work is parallel by default.** `BootstrapLevel`s (§3.2) are sequential — `plugins` runs after `minimal` completes — but independent IO-bound steps *within* a level (provider availability check + cache read + cert pre-warm, plugin manifest validation across plugins, app-plan cache decode + lockfile stat) MUST use `Effect.all({ concurrency: "unbounded" })` or `Effect.forEach({ concurrency })`. Sequential intra-level chains are a perf bug unless data dependencies require them.
- Cancellation propagates from OCLIF's `SIGINT` handler through to provider operations. `Effect.uninterruptible` is allowed only in narrowly-bounded critical sections (e.g., a single artifact-tag commit).
- **Telemetry MUST be fire-and-forget.** The `Telemetry` service (§3.4) never blocks command exit. Telemetry events are queued during the run and flushed either by a detached child process spawned via `Bun.spawn({ stdio: "ignore", detached: true })` or by a fiber forked at `before-exit` whose lifetime is independent of the main `Scope`. A failing telemetry endpoint MUST NOT change exit code, MUST NOT delay the user-perceived completion line, and MUST NOT leave the process hanging on shutdown. The same rule applies to update-check pings.
- **`Logger` and `Renderer` services are lazy.** Level-`none` and `minimal` invocations that print only static output MUST NOT construct the full structured logger pipeline; a tiny direct-write fallback is acceptable for those levels and is the default. The full `Logger` and `Renderer` Layers are constructed when level `plugins` or higher is reached, or earlier on first `yield* Logger`/`yield* Renderer` access (via `Layer.suspend`).

**Reference Effect patterns:**

```ts
import { Context, Data, Effect, Layer, Schema, Scope, Stream } from "effect";

// 1. Tagged errors
export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "ConfigError",
  {
    message: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// 2. Service definition (Context.Service pattern)
export class ConfigService extends Context.Service<ConfigService, {
  readonly load: Effect.Effect<ResolvedConfig, ConfigError>;
  readonly get: <K extends keyof ResolvedConfig>(key: K) => Effect.Effect<ResolvedConfig[K], ConfigError>;
}>()("@lando/core/ConfigService") {}

// 3. Layer (with Scope for finalization)
export const ConfigServiceLive = Layer.scoped(
  ConfigService,
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const sources = yield* discoverSources();
    yield* Effect.addFinalizer(() => Effect.logDebug("ConfigService unloading"));
    return ConfigService.of({
      load: loadFromSources(sources),
      get: (key) => loadFromSources(sources).pipe(Effect.map((c) => c[key])),
    });
  }),
);

// 4. Composed runtime layer
export const LandoRuntimeLive = Layer.mergeAll(
  ConfigServiceLive,
  FileSystemLive,
  ProcessRunnerLive,
  LoggerLive,
  PluginRegistryLive,
  CommandRegistryLive,
  RuntimeProviderRegistryLive,
);

// 5. Imperative shell (inside an OCLIF command)
export default class StartCommand extends OclifCommand {
  static description = "Start a Lando app";
  async run(): Promise<void> {
    const program = Effect.gen(function* () {
      const planner = yield* AppPlanner;
      const provider = yield* RuntimeProviderRegistry;
      const plan = yield* planner.plan(yield* discoverApp());
      const adapter = yield* provider.select(plan);
      yield* adapter.apply(plan, { reconcile: false });
    });
    await Effect.runPromise(
      program.pipe(
        Effect.provide(LandoRuntimeLive),
        Effect.scoped,
      ),
    );
  }
}
```

**Top-level module work budget.** Bun-compiled binaries execute every reachable module's top-level statements during process start. Heavy top-level work (large `Schema.Struct({...})` constructions, table literals built by reducing arrays, eager singletons) shows up directly in cold-start latency before `bin/lando.ts`'s `main()` runs. The rules:

- Any module reachable from `bin/lando.ts` MUST keep top-level synchronous work under ~50 µs. Module-load-time IO is forbidden.
- Schemas that are not on the critical path of every command (every level-`app` schema, recipe schemas, doctor-check schemas, test-only schemas) MUST be wrapped in `Schema.suspend` so construction is deferred until first decode.
- Service tags (`Context.Service` declarations) are cheap — a single class shell — and MAY appear at top level.
- Service implementations (the `Live` Layer bodies that build closures and acquire resources) MUST live inside `Layer.scoped` / `Layer.suspend` callbacks, not in module-load `const` initializers.
- Tagged-error class declarations are cheap and MAY appear at top level. Adding registry entries for them at module load (e.g., a global error catalog) is forbidden — the catalog is generated at build time (§17.2).
- The per-PR perf-budget test (§13.1) measures the time from `bin/lando.ts` entry to the first user-observable `process.stdout.write` for level-`none` commands. Top-level regressions surface here first.

**Effect Schema as the spec language.** Every external contract — Landofile, manifest, service config, tooling, route, healthcheck, env-var prefix — is an Effect Schema. The schemas live in `@lando/sdk`, are re-exported from `@lando/core/schema`, and are the source from which we generate:

- TypeScript types (via `Schema.Schema.Type`).
- JSON Schema for editor integration (via `JSONSchema.make`, draft-07 by default for broad editor support; 2020-12 or OpenAPI 3.1 may be emitted later when a consumer requires it).
- Generated schema reference docs (via schema `AST` traversal and schema annotations).
- Plugin contract validators.

Public schemas and their public fields MUST carry useful Effect Schema annotations (`identifier`, `title`, `description`, and examples where helpful). These annotations are not decorative: they improve parse errors, drive JSON Schema metadata, and feed the generated documentation pages. Public API exports outside schemas MUST use JSDoc/TSDoc so generated API reference pages and editor hovers remain useful.

**Documentation toolchain.** Lando v4 docs are a product surface, not just generated API output. The `docs/` tree is an Astro Starlight site using authored Markdown/MDX for guides, concepts, tutorials, plugin-author docs, embedding docs, migration notes, and examples. Generated reference material is fed into that site from the canonical sources:

- Effect Schema annotations + AST traversal generate schema reference MDX and JSON Schema artifacts.
- TypeDoc (or an equivalent TypeScript API extractor) generates public API reference for `@lando/core` and `@lando/sdk` entry points.
- OCLIF/Lando command metadata generates CLI command reference pages.
- Tagged error classes and lifecycle event schemas generate error and event catalog pages.

`@effect/docgen` is not the primary documentation system. It may be evaluated for Effect-style API reference pages, but the site shell and authored documentation live in Starlight so Lando can document user workflows, plugin authoring, schemas, commands, and embedding in one coherent place.

**Effect Logger as the logging contract.** Core never calls `console.log` outside the renderer plugin. Inside Effect, logs flow through `Effect.log*` and `Effect.annotateLogs`. The active logger is an Effect `Logger` provided by a Layer; swapping it changes how lines render. Plugins contribute renderers; the active renderer chooses which Effect Logger configuration to install.

**Two narrow direct-write carve-outs** exist for the first-paint contract (§8.9.1) and the level-`none` fast path (§3.2):

1. `bin/lando.ts` MAY write directly to `process.stdout` / `process.stderr` for level-`none` argv shapes — at that point no `Renderer` exists.
2. `src/cli/oclif/pre-renderer.ts` MAY write directly to `process.stdout` / `process.stderr` for the pre-bootstrap banner — its purpose is to emit the first-paint line before the `Renderer` Layer is forced. It MUST NOT import Effect, `@oclif/core`, the `Renderer` service, or any plugin code.

These are the only two modules in core that touch raw stdio. Anywhere else, direct `process.stdout.write` / `console.*` calls are forbidden and caught by the lint gate in §13.4.

### 2.5 Schema validation: Effect Schema

Effect Schema is the only schema library in core. We considered Zod, Valibot, and ArkType and rejected them because:

- Effect Schema decodes return `Effect`s, integrating directly with our runtime.
- `Schema.TaggedError` plugs into Effect's error channel.
- `Schema.Class` lets us attach domain methods to validated types.
- Bidirectional encode/decode is built in (we need this for cache serialization, env-var parsing, and JSON output).
- We avoid a second validation library on the hot path.

The `SchemaValidator` abstraction (§4) exists for plugins that prefer a different library *internally*. It is not a swap for the core schemas themselves.

### 2.6 Forbidden runtime dependencies

Core's `package.json` `dependencies` (excluding `devDependencies` and `peerDependencies`) is intentionally tiny. The following are forbidden in core source:

- `axios`, `got`, `node-fetch` — use `fetch` (built into Bun).
- `lodash`, `underscore`, `ramda` — use Effect's `Array`, `Record`, `Match` modules.
- `dockerode`, `docker-modem`, anything Docker-specific.
- `dockerfile-generator`, `mkcert`, `node-forge` — these belong in plugins.
- `js-yaml` — replaced by an Effect-Schema-aware YAML parser (see §7.3); if a low-level YAML parser is needed it lives behind the `LandofileParser` abstraction.
- `inquirer`, `prompts` — replaced by `@oclif/core`'s prompt utilities or a Lando-owned prompt service.
- `yargs`, `commander` — OCLIF subsumes these.
- `listr2` — replaced by the `Renderer` abstraction (a renderer plugin may pull listr2 internally).
- `chalk`, `kleur` — Bun has built-in ANSI color and terminal detection.
- `pacote`, `@npmcli/arborist` — replaced by `Bun.spawn('bun', ['add', ...])` for plugin installs.
- `nanoid`, `uuid` — Bun provides `crypto.randomUUID` natively.
- `slugify` — write a small internal helper; this isn't a vendor concern.
- `object-hash` — `Bun.hash` and `crypto.subtle.digest` are sufficient.

Effect, OCLIF, and a small set of YAML/CA primitives are the only runtime deps. The plugin SDK (`@lando/sdk`) is published separately and exports the canonical Effect Schema instances, service tags, and tagged-error classes that plugins consume at runtime; it is the contract layer between core and plugin authors, not a type-only `.d.ts` package.

### 2.7 Package surface

`@lando/core` is a single Bun-loadable package with multiple ESM entry points. Splitting `core` into a runtime package + a CLI package is rejected (see §15.D for the OCLIF rationale and §16 for the embedding rationale). The CLI binary, the OCLIF adapter, the Effect runtime, the public schemas, and the tagged-error catalog all ship from the same package version.

**Required `package.json#exports` (illustrative):**

```jsonc
{
  "name": "@lando/core",
  "type": "module",
  "bin": { "lando": "./bin/lando.js" },
  "exports": {
    ".":              "./dist/index.js",          // public library API (§16)
    "./schema":       "./dist/schema/index.js",   // Effect Schemas
    "./errors":       "./dist/errors/index.js",   // tagged error classes
    "./events":       "./dist/lifecycle/index.js",// EventService + payload schemas
    "./services":     "./dist/services/index.js", // service-tag re-exports
    "./testing":      "./dist/testing/index.js",  // test helpers (TestServices wiring, fixtures)
    "./cli":          "./dist/cli/index.js",      // programmatic CLI invocation
    "./oclif":        "./dist/cli/oclif/index.js" // OCLIF adapter; do not import outside src/cli/oclif/
  }
}
```

**Required entry-point policies:**

- The default entry (`@lando/core`) MUST NOT pull `@oclif/core` into the import graph. An embedding host that never invokes the CLI must not pay for OCLIF in its bundle. This is enforced by an import-boundary test in `test/types/`.
- `@lando/core/cli` MAY pull OCLIF; it is the programmatic-CLI entry.
- `@lando/core/schema` MUST be tree-shakeable per-schema. Importing one schema must not pull every schema in the package.
- `@lando/core/testing` is published only on the `next` and `dev` channels until the testing API is frozen for v4.0.0 GA.
- Every entry point ships its own `.d.ts` file. Type-only re-exports use `export type { ... }`.
- ESM only at every entry. No CommonJS dual-publish.

**Compiled-binary entry.** `bin/lando.ts` imports `@lando/core/cli` to wire OCLIF and run the binary. The `bun build --compile` step is configured to statically import bundled plugins (§2.1) and to embed the OCLIF manifest as an asset (§17.3). The compiled binary is *one* consumer of `@lando/core/cli`; an embedding host can be another (§16.4).

---
