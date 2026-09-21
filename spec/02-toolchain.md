# Lando v4 — Toolchain

> **Part 2 of 18** · [Index](./README.md)
> **Read next:** [03 Architecture](./03-architecture.md)

This part defines the technology stack and the architectural rules each component imposes.

---

## 2. Toolchain

### 2.1 Bun

Bun is the runtime, package manager, test runner, bundler, binary packager, subprocess substrate, and primary file-IO layer.

**Required policies:**

- `bun.lock` is the lockfile. `package-lock.json` and `yarn.lock` are forbidden.
- Dependencies are installed with `bun install`; plugin install hooks invoke it through `BunSelfRunner`.
- Core tests use `bun test`. Vitest, Jest, and Mocha are forbidden in core; plugins may choose their own test framework.
- `Bun.spawn` is reserved for argv-precise execution through `ProcessRunner`. `node:child_process` is forbidden in core except behind a compatibility adapter.
- `Bun.$` is reserved for shell-shaped work through `ShellRunner`. Core MUST NOT use `ProcessRunner` to invoke a shell or use `ShellRunner` to re-encode an argv call. Release and codegen scripts outside `LandoRuntimeLive` MAY use `Bun.$` directly (§17.1).
- `Bun.file` and `Bun.write` are the filesystem primitives. `node:fs` is allowed only inside the `FileSystem` adapter when Bun lacks equivalent behavior.
- Bun `fetch` is available only through `HttpClient`, the single egress chokepoint for Lando-owned network access (§10.3.2). Package-manager work through `BunSelfRunner` and standalone installers are the only carve-outs.
- TypeScript executes natively; `tsc --noEmit` is a type gate, not a development build step.
- Core is ESM-only. Plugins may publish CommonJS through loader interop.

The Bun version floor is TBD (§14). It MUST support stable `--bytecode` on every release target and the `BUN_BE_BUN` standalone-executable mode; either capability regressing moves the floor.

**The compiled binary is itself Bun.** Core, plugins, and recipe scaffolding that need Bun self-spawn the running `lando` executable with `BUN_BE_BUN=1`; core MUST NOT resolve a system `bun` from `PATH`. `BunSelfRunner` is the only core service allowed to construct that child, publishes `pre-bun-self-exec` and `post-bun-self-exec`, and remains plugin-replaceable (§3.4, §4.2). The compiled distribution therefore has no separate Bun prerequisite. Library mode MAY fall back to host Bun, and embedding hosts MAY replace that fallback with a strict variant. `lando meta bun`/`lando bun`, `lando meta x`/`lando x`, recipe Bun actions, and plugin authoring all use this service (§8.2, §8.8.8, §9.10). These invocations require at least `minimal` bootstrap and MUST NOT enter the level-`none` fast path (§3.2).

The default binary uses `bun build --compile` with bytecode enabled. `--bytecode` is REQUIRED and is part of the cold-start budget. Releases target `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`, and `bun-windows-x64`; every release ships all five. Release-shaped main binaries use the build wrapper required by §17.3; bare compilation is allowed only for helper binaries without OpenTUI.

Build-visible code and data MUST be statically imported or explicitly embedded. Bundled plugins are statically imported, external plugins load only from validated locked stores or trusted `pluginDirs:`, and the native command-registry manifest is generated and embedded (§8.4.1, §17.2–§17.3). Asset ownership remains in §17.3.

**Performance commitments:**

| Command | v4 budget (cold) | v4 budget (hot) |
|---|---|---|
| `lando --version` / `lando version` | < 50 ms | < 30 ms |
| `lando shellenv` | < 50 ms | < 30 ms |
| `lando recipes` | < 80 ms | < 50 ms |
| `lando list` with no apps | < 200 ms | < 100 ms |
| `lando <tooling-cmd>` against a running app | < 600 ms including provider exec | < 250 ms including provider exec |

| Signal | Budget (cold) | Applies to |
|---|---|---|
| First byte to stdout/stderr | < 50 ms | every command whose end-to-end budget exceeds 100 ms |
| First meaningful line | < 80 ms | every command at level ≥ `plugins` |
| Spinner or progress visible | within 100 ms of starting work expected to exceed 200 ms | renderers |
| Final completion line | within 50 ms of the last work step finishing | every renderer |

TTY renderers enforce the perceived-performance budget (§8.9). Non-TTY output is exempt from spinner/progress but MUST emit its first line within 80 ms when the end-to-end budget exceeds 100 ms. Level-`none` commands have no separate first-paint budget; the pre-dispatch fast-path shape (§3.2) MUST NOT construct an Effect runtime or import `@oclif/core`, while dispatcher-routed `none` commands build any runtime inside their own body.

Per-PR performance tests and the §13.4 merge gate enforce both budget tables.

### 2.2 TypeScript

TypeScript uses `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `moduleResolution: "bundler"`, `module: "esnext"`, `target: "esnext"`, `lib: ["esnext"]`, `types: ["bun-types"]`, `isolatedModules`, and `skipLibCheck: false`. `exactOptionalPropertyTypes` is required for Effect Schema optional-property semantics.

Public types MUST be inferred from Effect Schema wherever a schema can own the contract; parallel public `interface` or `type` declarations are forbidden. Internal types may use either. `@lando/sdk` exports schemas and their inferred types. Top-level exports SHOULD prefer one public symbol per file, barrels belong only at package boundaries, and side-effect imports are forbidden in core.

### 2.3 Native command dispatcher

The shipping CLI uses one native command registry and dispatcher shared by source and compiled entries (§8.4.1); no shipping core module imports `@oclif/core`, and `CommandFramework` remains replaceable (§4). OCLIF was the former default because its manifest, discovery, taxonomy, and hooks fit the intended surface, but that history does not authorize a second dispatch path; the legacy-named `src/cli/oclif/` tree contains native adapters and development tooling only (§15.D).

### 2.4 Effect

Every meaningful core operation returns `Effect.Effect<A, E, R>`.

- Services use `Context.Service` and are consumed through `yield* ServiceTag`; the older `Context.Tag()()` pattern is forbidden in new code.
- Services are provided by `Layer`s. Resource-bearing services MUST use `Layer.scoped`, and cancellation MUST propagate to provider operations. `Effect.uninterruptible` is allowed only for narrowly bounded critical sections.
- Bootstrap layers are AOT-composed for every `BootstrapLevel` (§3.2, §17.2). Core runtime `Layer.merge`/`Layer.provide` chains are forbidden outside generated composition, test helpers, and embedding-host opt-ins.
- A service not always needed at its declared level MUST use `Layer.suspend`; always-required services MAY initialize eagerly. `Logger` and `Renderer` are lazy, with only the first-paint and level-`none` direct-write carve-outs below.
- Errors are `Schema.TaggedError` values. `throw` is forbidden except inside adapter `Effect.try` boundaries.
- Trust-boundary data MUST be decoded by Effect Schema before business logic.
- Long-running output uses `Stream`; public core APIs MUST NOT expose plain async iterators.
- Concurrency uses Effect primitives. Manual concurrency control with `Promise.all` is forbidden. Bootstrap levels are sequential, but independent IO within a level MUST run concurrently; sequential work requires a data dependency.
- Telemetry and update checks MUST be fire-and-forget: failure MUST NOT change exit status, delay the completion line, or keep the process alive.

Top-level code reachable from `bin/lando.ts` has a roughly 50 µs synchronous-work budget and MUST perform no IO. Noncritical schemas MUST use `Schema.suspend`; service implementations MUST acquire work inside `Layer.scoped` or `Layer.suspend`; service tags and tagged-error declarations MAY remain at module scope; runtime-built global catalogs are forbidden.

Effect Schema is the single contract language for Landofiles, manifests, service configuration, tooling, routes, healthchecks, environment surfaces, errors, and events. Canonical schemas live in `@lando/sdk`, are re-exported from `@lando/core/schema`, and generate inferred TypeScript types, JSON Schema, reference documentation, and plugin validators. Public schemas and fields MUST carry useful annotations; non-schema public exports MUST carry JSDoc/TSDoc.

The documentation site is authored in Astro Starlight Markdown/MDX. Schema ASTs generate schema reference and JSON Schema, TypeDoc or an equivalent extractor generates API reference, command metadata generates CLI reference, and tagged errors plus event schemas generate catalogs. `@effect/docgen` is not the primary documentation system.

Core logging flows through Effect logging and the active `Logger`/`Renderer`; direct console or stdio writes are forbidden except the level-`none` entry and the pre-renderer first-paint adapter. The latter MUST NOT import Effect, `@oclif/core`, `Renderer`, or plugins. Boundary gates enforce both carve-outs (§13.4).

### 2.5 Schema validation: Effect Schema

Effect Schema is the only schema library in core. Its Effect-native decode, tagged errors, classes, and bidirectional codecs are part of the runtime contract. `SchemaValidator` lets plugins use another library internally but does not replace core schemas (§4).

### 2.6 Forbidden runtime dependencies

| Forbidden in core source | Required replacement or ownership |
|---|---|
| `axios`, `got`, `node-fetch` | `HttpClient`; direct Bun `fetch` remains adapter-only |
| `lodash`, `underscore`, `ramda` | Effect `Array`, `Record`, and `Match` |
| `dockerode`, `docker-modem`, any Docker-specific library | provider abstractions |
| `dockerfile-generator`, `mkcert`, `node-forge` | plugins |
| `js-yaml` | Effect-Schema-aware parsing behind `LandofileParser` |
| `inquirer`, `prompts` | `InteractionService` |
| `yargs`, `commander` | native command dispatcher and registry |
| `listr2` | `Renderer`; renderer plugins may use it internally |
| `chalk`, `kleur` | Bun ANSI color and terminal detection |
| `pacote`, `@npmcli/arborist` | `BunSelfRunner` with `BUN_BE_BUN=1` |
| `nanoid`, `uuid` | `crypto.randomUUID` |
| `slugify` | a small internal helper |
| `object-hash` | `Bun.hash` or `crypto.subtle.digest` |

Effect plus a small set of YAML/CA primitives are the only target runtime dependencies. OCLIF is development-only. `@lando/sdk` is a runtime contract package, not a type-only package.

### 2.7 Package surface

`@lando/core` is one public ESM package containing the CLI, native dispatcher, runtime, schemas, and errors. A separate public runtime/CLI split is rejected (§16). Approved private seams include `@lando/paths`, `@lando/state-store`, `@lando/landofile`, `@lando/engine`, `@lando/redaction`, `@lando/http-client`, and `@lando/managed-file`; additional seams require package-DAG ownership and payment of the scanner-retirement ratchet. Private seams MUST NOT become a second public runtime, plugins MUST NOT depend on `@lando/core` or `@lando/engine`, and Effect-free pure seams are preferred where applicable.

| Subpath | Purpose |
|---|---|
| `@lando/core` | public library API (§16) |
| `@lando/core/schema` | Effect Schemas |
| `@lando/core/errors` | tagged error classes |
| `@lando/core/secrets` | canonical redactor re-export (§3.7) |
| `@lando/core/events` | `EventService` and payload schemas |
| `@lando/core/services` | service-tag re-exports |
| `@lando/core/paths` | Effect-free root and path resolution (§7.5.1) |
| `@lando/core/landofile` | canonical parser and serializer (§7.8.1) |
| `@lando/core/testing` | supported test wiring and fixtures |
| `@lando/core/cli` | programmatic native CLI invocation |
| `@lando/core/docs/components` | executable-guide runtime and AST helpers (§19.3) |
| `@lando/core/docs/redactions` | transcript redaction list (§19.6) |

The removed `./oclif` adapter is not public. The default entry MUST NOT pull a heavy CLI framework into its graph; `./cli` MUST NOT require `@oclif/core`; `./schema` MUST be tree-shakeable per schema; `./paths` MUST be Effect-free and OCLIF-free; `./landofile` MUST remain OCLIF-free and avoid the full runtime. `./testing` is supported on `next` and `dev` for Beta 1 but is not published on `stable` before v4.0.0 GA. Docs entry points MUST be tree-shakeable and MUST NOT pull the Effect runtime or `@oclif/core`.

Every entry point ships its own declarations, uses type-only re-exports where appropriate, and is ESM-only. `bin/lando.ts` consumes `@lando/core/cli`; the compiled binary is one consumer, not a separate architecture (§16.4).

---
