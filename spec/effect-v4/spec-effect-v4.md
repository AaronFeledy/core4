# Effect 4 upgrade: normative wave contract

This document is normative for stories US-662 through US-670. Each story folds the durable rules it establishes into the canonical spec sections listed in §11, in the same PR. Until a section is updated, this document wins where they conflict.

Every claim about Effect below was checked in one of two ways:

- against the installed `effect@3.21.2` and the published `effect@4.0.0` (`dist/*.d.ts`, runtime exports, shipped `AGENTS.md`);
- against the upstream migration guides listed in §13.

## 1. Outcome and rules

- Every workspace package runs on `effect@4.0.0`. No Effect 3 import, API, idiom, or compatibility shim remains in shipped code, tests, scripts, generators, emitted source, docs, or agent instructions.
- **No compromises.** Where Effect 4 offers a new way to do something, the new way is mandatory even when the old way still compiles. §4 and §7 list every replacement. The only exceptions are the rejected modules in §10, each with recorded evidence.
- **Every story is complete.** A story is one PR against `main` that ships a whole outcome, leaves Lando working, and passes the full standard gate. There is no scaffolding that a later story removes, no stand-in written to be renamed later, and no integration branch.
- Users get measurable value, not just a version bump:

| Reader | What changes for them | Story |
| --- | --- | --- |
| Everyone | Lower runtime overhead and memory on every Effect-loaded command, measured against Effect 3 | US-662 |
| Plugin authors | Effect's standard `HttpClient`, wired to Lando's network trust | US-663 |
| AI agents over MCP | MCP 2025-06-18: structured results, confirmation through the client, config/info/apps/doctor/schemas as resources | US-665 |
| Plugin authors | Bundled plugins and `lando plugin:new` written in current Effect idiom | US-667 |
| Landofile authors and tool builders | Every problem reported at once with its path and a fix hint; editors and Standard Schema consumers flag the same problems | US-668 |
| Anyone debugging slowness | `--trace` timing tree, opt-in OTLP export, and host-supplied tracers for embedding hosts | US-669 |
| Everyone | Faster cached-plan and Landofile decoding, if compiled decoders clear a fixed bar | US-670 |

## 2. Version and dependency policy

- One Bun catalog entry owns the version. Root `package.json` declares `workspaces.catalog.effect` as exactly `4.0.0`, and every workspace that imports `effect` declares `"effect": "catalog:"`. The pin is exact because Effect 4 tags `effect/http`, `effect/ai`, `effect/observability`, and the `effect/schema` compilers `@stability unstable`, and those may break in a minor release.
- A repository test fails when any workspace declares `effect` with another specifier or depends on any `@effect/*` package.
- The TypeScript devDependency floor is `^5.9.0`, which is Effect 4's minimum.
- Moving past `4.0.0` is its own story, which reruns the switch-class gate.

## 3. Story map

| Priority | Story | Completes |
| ---: | --- | --- |
| 75 | US-662 | Lando on Effect 4: every API that no longer exists replaced, every silent behavior change pinned by tests, schema meaning unchanged, measured |
| 76 | US-663 | Effect 4 idiom in the SDK and primitive packages; Effect's `HttpClient` as Lando's one HTTP client |
| 77 | US-664 | Effect 4 idiom in the engine; operation spans |
| 78 | US-665 | MCP on Effect's MCP server: protocols, structured results, elicitation, resources |
| 79 | US-666 | Effect 4 idiom in renderer, data-mover, and core; command spans |
| 80 | US-667 | Effect 4 idiom in bundled plugins and the plugin scaffold; the idiom guard |
| 81 | US-668 | One definition of a valid Landofile across Lando, editors, and Standard Schema tools |
| 82 | US-669 | Command tracing: `--trace`, OTLP export, embedding-host observability |
| 83 | US-670 | Compiled hot-path decoders, adopted only past a measured bar |

**Why the switch is one PR.** Effect 3 and Effect 4 types cannot meet across the `@lando/sdk` boundary, so a repo half on each does not compile. A runtime bridge between the two would be exactly the compatibility shim this repository forbids. US-662 is therefore large, and its commits are ordered for review:

1. Characterization tests for spec §8, which pass on Effect 3.
2. The catalog switch.
3. One commit per package in DAG order (`sdk`, primitives, `landofile`, `container-runtime`, `engine`, `renderer`, `data-mover`, `mcp`, plugins, `core`).
4. Scripts, generators, and regenerated outputs.
5. Docs and agent instructions.

US-662 changes only what Effect 4 requires. Old forms that still compile (§4.6) are left for the idiom stories, which rewrite each area completely and once.

**Order of the idiom stories.** US-665 replaces `mcp/src`'s hand-written transport, so it lands before the idiom pass over core (US-666) and nobody refactors code that is about to be deleted. US-667 converts the last area, so it also adds the boundary rule that keeps old forms out.

## 4. Canonical replacements

Every row applies repo-wide: shipped code, tests, scripts, generator templates and their emitted output, docs code, and agent instruction files. Counts are main-tree occurrences (source/tests) at 3.21.2.

- **§4.1 to §4.5 and §7** are forms Effect 4 no longer has. US-662 applies them all.
- **§4.6** lists forms Effect 4 still accepts but replaces. The idiom stories apply them per area.

Two same-name traps:

- Effect 3 `Effect.catch(discriminator, { failure, onFailure })` is not Effect 4 `Effect.catch` (catch-all). The repo has no Effect 3 uses; keep it that way.
- Effect 3 `Predicate.isRecord` (plain objects only) maps to Effect 4 `Predicate.isObject`. Effect 3 `Predicate.isObject` (objects, arrays, functions) has no single Effect 4 equivalent. Never rename either by name alone.

### 4.1 Services, context, runtime

| Effect 3 form | Effect 4 form |
| --- | --- |
| `Context.Tag(id)<Self, Shape>()` (317/121) | `Context.Service<Self, Shape>()(id)`, ids unchanged (§5) |
| `Context.GenericTag<T>(id)` | `Context.Service<T>(id)` |
| `Context.isTag`, `Context.unsafeGet` | `Context.isKey`, `Context.getUnsafe` |
| `FiberRef.unsafeMake` + `Effect.locally` + `FiberRef.get` (8 refs in 7 files) | `Context.Reference<Self>()(id, { defaultValue })` + `Effect.provideService` + `yield* Ref` |
| `Effect.runtime<R>()` + `Runtime.runPromise`/`runFork` | `Effect.context<R>()` + `Effect.runPromiseWith`/`runForkWith` |
| `Effect.mapInputContext` | `Effect.updateContext` |
| `Effect.withFiberRuntime`, `Effect.fiberIdWith`, `FiberId` | `Effect.withFiber`, `Effect.fiberId`, numeric `fiber.id` |
| Shells catching `runPromise` rejections or `FiberFailure` | `Effect.runPromiseExit`/`runPromiseExitWith`, then render the `Cause` |

### 4.2 Layers and scopes

| Effect 3 form | Effect 4 form |
| --- | --- |
| `Layer.scoped`, `scopedDiscard`, `scopedContext` | `Layer.effect`, `effectDiscard`, `effectContext` (scoped by construction) |
| `Layer.unwrapEffect`, `unwrapScoped` | `Layer.unwrap` |
| `Layer.mapError`, `Layer.fail` | Map inside the constructing effect; `Layer.catch`/`catchTag` only when recovering |
| `Layer.extendScope` + `Layer.buildWithScope` | `Layer.buildWithScope(layer, scope)`; resources must still live until the runtime scope closes |
| `Scope.extend`, `Scope.CloseableScope`, `ExecutionStrategy` | `Scope.provide`, `Scope.Closeable`, `Scope.make("sequential" \| "parallel")` |
| Repeated `Effect.provide(sameLayer)` expecting a fresh build | `Layer.fresh` or `Effect.provide(layer, { local: true })`, because Effect 4 forks the parent memo map for nested provides |

### 4.3 Errors, results, causes

| Effect 3 form | Effect 4 form |
| --- | --- |
| `Either.*`, `Effect.either` (1,981 / 1,070) | `Result.*`, `Effect.result` (`right`/`left` to `succeed`/`fail`, `isRight`/`isLeft` to `isSuccess`/`isFailure`, `.right`/`.left` to `.success`/`.failure`) |
| `Effect.catchAll`, `catchAllCause`, `catchSomeCause`, `orElse` | `Effect.catch`, `catchCause`, `catchCauseFilter`, `catch` |
| `Effect.tapErrorCause`, `timeoutFail`, `timeoutTo`, `dieMessage(m)` | `Effect.tapCause`, `timeoutOrElse`, `timeoutOrElse`, `die(new Error(m))` |
| `Cause.failureOption`, `failures`, `defects`, `dieOption` | `Cause.findErrorOption`, `findError`, `findDefect`, or `cause.reasons` filtered by `Cause.isFailReason`/`isDieReason` |
| `Cause.isInterruptedOnly`, `isInterrupted`, `isDie` | `Cause.hasInterruptsOnly`, `hasInterrupts`, `hasDies` |
| `Cause.sequential`, `Cause.parallel` | `Cause.combine` (flat reason list) |
| `Cause.UnknownException`, `TimeoutException` | `Cause.UnknownError`, `TimeoutError` |
| `Exit.isInterrupted`, `Exit.causeOption` | `Exit.hasInterrupts`, `Exit.getCause` |

### 4.4 Fibers, concurrency, streams

| Effect 3 form | Effect 4 form |
| --- | --- |
| `Effect.zipRight`, `zipLeft` (227 / 109) | `Effect.andThen`, `Effect.tap` |
| `Effect.fork`, `forkDaemon` | `Effect.forkChild`, `forkDetach` |
| `Fiber.poll`, `Fiber.RuntimeFiber`, `Fiber.unsafeRoots` | `fiber.pollUnsafe()`, `Fiber.Fiber`, delete the use |
| `yield* ref`, `yield* deferred`, `yield* fiber` | `Ref.get`, `Deferred.await`, `Fiber.join` |
| Option or Either passed to Effect combinators | `.asEffect()`, or `yield*` inside `Effect.gen` |
| `Effect.async`, `Stream.async`, `Effect.iterate` | `Effect.callback`, `Stream.callback`, `Effect.whileLoop` |
| `Effect.makeSemaphore`, `unsafeMakeSemaphore`, `makeLatch` | `Semaphore.make`, `Semaphore.makeUnsafe`, `Latch.make` |
| `Stream.catchAll`, `catchAllCause`, `unwrapScoped`, `acquireRelease` | `Stream.catch`, `catchCause`, `unwrap`, `Stream.scoped(Effect.acquireRelease(...))` |
| `Stream.repeatEffect`, `repeatEffectOption`, `paginateChunkEffect`, `mapConcat`, `ensuringWith` | `Stream.fromEffectRepeat`, end with `Cause.done()`, `paginate`, `flattenIterable`, `onExit` |
| Option-encoded stream end | `Cause.done()` / `Queue.end` |

### 4.5 Time, logging, testing, small modules

| Effect 3 form | Effect 4 form |
| --- | --- |
| `Duration.decode`, `Duration.DurationInput` | `Duration.fromInputUnsafe`, `Duration.Input` |
| `DateTime.unsafeMake`, `unsafeNow` (274 / 4) | `DateTime.makeUnsafe`, `nowUnsafe` |
| `Option.fromNullable`, `Predicate.isRecord` | `Option.fromNullishOr`, `Predicate.isObject` |
| `Logger.replace`, `minimumLogLevel`, `withMinimumLogLevel`, `prettyLogger`, `jsonLogger`, `none` | `Logger.layer([...])`, `References.MinimumLogLevel`, `Logger.consolePretty`, `Logger.consoleJson`/`formatJson`, `Logger.layer([])` |
| `LogLevel.Debug` and the other members | String levels (`"Debug"`) |
| `TestClock`/`TestContext` from `effect` | `TestClock` from `effect/testing`; `TestClock.layer()` replaces `TestContext` |
| `FastCheck`, `Arbitrary.make` | `Arbitrary.schema(S)` with `Arbitrary.checkEffect` and a fixed `seed` |

### 4.6 Forms Effect 4 still accepts but replaces

| Old form (still compiles) | Effect 4 form |
| --- | --- |
| Named function or method whose body only returns `Effect.gen(...)` (about 575 in shipped code) | `Effect.fn("<Owner>.<name>")` at tracing boundaries (§6), `Effect.fnUntraced` elsewhere; combinators passed as extra `Effect.fn` arguments, never `.pipe` after it |
| `Effect.gen(this, ...)` | `Effect.gen({ self: this }, ...)` |
| `Layer.succeed(Tag, { ... })` with a literal | `Layer.succeed(Tag, Tag.of({ ... }))` |
| `*Live` and `make*Live` exports (104 and 31) | The §5 shapes and names |
| `Data.TaggedError` (12 files) | `Schema.TaggedError` |
| `Date.now()`, `new Date(...)` in Effect code (158 source sites) | `Clock` + `DateTime`; Bun boundaries convert with `DateTime.fromDateUnsafe`/`toDate` |
| Hand-rolled `isRecord`/`isPlainObject` guards (about 40) | `Predicate` helpers with identical semantics |
| Hand-rolled dependency ordering and cycle detection | `Graph` |
| Hand-rolled byte formatting | `ByteSize.format` |
| Secret-carrying values that can reach Effect logs or inspection | Implement `Redactable` |
| Lando's own HTTP client contract | Effect's `effect/http` `HttpClient` (US-663) |
| Hand-written MCP JSON-RPC transport | `effect/ai` `McpServer` (US-665) |

## 5. Service definition shapes

There are exactly three shapes.

1. **SDK contract tag** (`@lando/sdk`, no implementation): `export class X extends Context.Service<X, { ...inline shape... }>()("@lando/core/X") {}`. Ids keep their current `@lando/core/<Name>` form because §3.4 publishes them as stable public identities. A separate `XShape` interface stays only where TypeScript reports TS2310/TS2506 on the inline form, and the `services/index.ts` declare-class mirror always keeps the inline type literal.
2. **Package-private service** (tag and implementation in one package): the class carries `static readonly layer = Layer.effect(this, Effect.gen(...))`, builds values with `X.of({...})`, and exposes variants as static `layer<Variant>` members (for example `layerTest`, `layerDisabled`). Ids follow `@lando/<package>/<Name>`.
3. **Implementation of an SDK contract in another package**: the module exports `layer`, plus `layer<Variant>` for variants such as `layerUnavailable` and `layerDisabled`. An options factory is `layer(options)`. Consumers import the module as a namespace named after the implementation, for example `import * as BunProcessRunner from "@lando/engine/services/process-runner"` and `BunProcessRunner.layer`.

Generated bootstrap layers and agent instructions use these names. Renaming a layer updates every agent-instruction line that names it, in the same PR.

## 6. Tracing policy

- `Effect.fn("<Owner>.<method>")` marks every operation an operator would want in a trace. That covers public methods of service shapes, operations under `engine/src/operations/**`, provider and runtime calls, planner phases, network egress, managed-file transactions, command lifecycle stages, and MCP calls. Names look like `"AppPlanner.plan"` or `"RuntimeProvider.bringUp"`.
- `Effect.fnUntraced` covers everything else, especially schema helpers, per-frame renderer work, redaction, path math, and anything on the `bench:tooling-hot-path` path.
- The CLI composition provides `References.TracerEnabled` as `false` unless tracing is requested (US-669). Embedding hosts keep whatever their context already sets.
- Span attributes never carry raw secrets, environment values, or file contents. They pass through `RedactionService` before retention or export.

## 7. Schema policy

US-662 applies this table.

| Effect 3 form | Effect 4 form |
| --- | --- |
| `Schema.decodeUnknown`, `decode` | `Schema.decodeUnknownEffect`, `decodeEffect` |
| `decodeUnknownEither`, `encodeEither`, `encodeUnknownEither` | `decodeUnknownResult`, `encodeResult`, `encodeUnknownResult` |
| `optional` on authored input; `optionalWith({ exact: true })` | `optionalKey` |
| `optionalWith({ default })` | `optionalKey(...)` + `withDecodingDefaultKey`, or `withConstructorDefault` for constructor-only defaults |
| `propertySignature(...).annotations(...)` | `annotateKey` |
| `Literal(a, b, ...)` (239 multi-argument sites), `Union(a, b)`, `Record({ key, value })` | `Literals([a, b, ...])`, `Union([a, b])`, `Record(key, value)` |
| `.annotations({...})` | `.annotate({...})` |
| `filter(...)` | `check(Schema.makeFilter(...))`, or `refine` when the type narrows |
| `pattern`, `int`, `minLength`, `maxLength`, `between`, `greaterThan`, `greaterThanOrEqualTo`, `lessThanOrEqualTo`, `startsWith` | `check(isPattern/isInt/isMinLength/isMaxLength/isBetween/isGreaterThan/isGreaterThanOrEqualTo/isLessThanOrEqualTo/isStartingWith(...))` |
| `positive`, `nonNegative`, `minItems`, `maxItems` | `isGreaterThan(0)`, `isGreaterThanOrEqualTo(0)`, `isMinLength`, `isMaxLength` |
| `transform` | `from.pipe(Schema.decodeTo(to, SchemaTransformation.transform({ decode, encode })))` (pure and infallible) |
| `transformOrFail` | `from.pipe(Schema.decodeTo(to, SchemaTransformation.transformEffect({ decode, encode })))`; callbacks receive `(input, options)` and return an `Effect` built from the `ParseResult` rows below. Effect 4 has no `SchemaTransformation.transformOrFail` |
| `extend`, `Struct(fields, record)`, `partial` | `fieldsAssign`, `StructWithRest(Struct(fields), [record])` (keeps `.fields`), fields mapped to `optionalKey` |
| `parseJson`, `encodedSchema`/`typeSchema`/`encodedBoundSchema`, `asSchema` | `fromJsonString`/`UnknownFromJsonString`, `toEncoded`/`toType`, delete `asSchema` |
| `UUID`, `NonNegativeInt`, `NonEmptyTrimmedString`, `Uint8ArrayFromSelf`, `Schema.Defect` | `String.check(isUUID())`, `Int.check(isGreaterThanOrEqualTo(0))`, `Trimmed.check(isNonEmpty())`, `Uint8Array`, `Schema.Defect()` |
| `ParseResult.succeed(value)` in transformation callbacks (56) | `Effect.succeed(value)` |
| `ParseResult.fail(new ParseResult.Type(ast, actual, message))` (21 `fail`, 45 `Type`) | `Effect.fail(new SchemaIssue.InvalidValue({ message }, actual, options))`, which keeps the custom message; `new SchemaIssue.InvalidType(ast, actual, options)` only where there is no custom message |
| `ParseResult.ParseError`, `ParseResult.isParseError` (46 / 28) | `Schema.SchemaError`, `Schema.isSchemaError` |
| `ParseResult.Pointer` | `SchemaIssue.Pointer` |
| `ParseResult.ArrayFormatter.formatErrorSync` | `SchemaIssue.makeFormatterStandardSchemaV1()` (`{ issues: [{ path, message }] }`) |
| `JSONSchema.make`, `fromAST` | `Schema.toJsonSchemaDocument` (draft 2020-12); `JsonSchema.toDocumentDraft07` while artifacts stay draft-07 (until US-668) |
| `SchemaAST` `TypeLiteral`, `TupleType`, `Refinement`, `Transformation`, annotation-id symbols | `Objects`, `Arrays`, `checks` on the node, the `encoding` chain, plain annotation keys |

Rules with evidence:

- **Authored input uses `optionalKey`.** This covers schemas that decode files or persisted state: Landofile, global config, plugin and recipe manifests, includes, lockfiles, and the app-plan and command caches. Effect 4 emits `Schema.optional(X)` into JSON Schema as `anyOf [X, null]` while the decoder rejects `null`, so an editor would accept what Lando rejects. Output-only schemas (errors, events, command results) may keep `optional`.
- Decoders of authored files keep `onExcessProperty: "error"`. JSON Schema generation for those schemas passes the same option, which emits `additionalProperties: false`.
- Custom check messages keep their exact text through the `message` annotation.

## 8. Behavior changes that still compile

US-662's first commit adds a characterization test for each applicable row. Those tests pass on Effect 3. The rest of the PR keeps them passing, or records each intended difference with its reason.

| Change | Where it can bite here | Characterization |
| --- | --- | --- |
| Structural `Equal` by default for plain objects, arrays, Map, Set, Date | `HashSet`/`HashMap`, `Array.dedupe`/`union`/`contains` on objects | Current results for every use found by grep, or a recorded zero |
| Shared layer memo map across nested `Effect.provide` | `EventService`, telemetry transport, MCP service, app lifecycle, `@lando/core/testing` event bus, engine app handle, doctor layers | Build counts: once per runtime, fresh for a fresh runtime |
| Resource lifetime without `Layer.extendScope` | `engine/src/runtime/bootstrap-lifecycle.ts` | Resources close only when the runtime scope closes |
| Flat `Cause` (no `Sequential`/`Parallel`) | `Cause.pretty` renderers, bug reports, MCP `Cause.squash`, test matchers | Text and JSON failure output for a tagged failure, defect, interrupt, and two combined failures, from both shells |
| `runPromise` rejection shape; no `FiberFailure` | CLI shell, library shell, scenario reporter | Exit codes and envelopes per failure kind |
| Schedule steps are relative Durations ending with `Cause.done` | `@lando/sdk/probe` | Attempt counts and virtual elapsed time under `TestClock` per probe profile |
| Queue and Stream end through `Cause.Done` | Telemetry drain, MCP queues on transport close, log follow, renderer streams | Drain and shutdown behavior |
| Logger installation is set-based; JSON field `logLevel` becomes `level` | `engine/src/logging/**` | Exact JSON log record keys |
| Core runtime keeps the process alive while fibers wait | Fire-and-forget telemetry and update checks (§2.4) | A command with a hanging telemetry sink exits within its budget |
| `partition`/`separate` order; Duration ISO parsing removed | No current users | Grep stays at zero |

## 9. Upstream modules adopted

| Module | Adopted for | Story |
| --- | --- | --- |
| `Context.Reference`, `References`, `Semaphore`, `Latch`, `Queue`, `PubSub` | Fiber-local state, log level, tracer toggle, concurrency | US-662 |
| `SchemaIssue`, `JsonSchema` | Diagnostics, artifacts, draft conversion | US-662, US-668 |
| `Effect.fn`, `Effect.fnUntraced`, `Graph`, `Predicate`, `DateTime` + `Clock`, `ByteSize`, `Redactable` | Tracing boundaries, replacing hand-rolled helpers, self-redacting secrets | US-663, US-664, US-666, US-667 |
| `effect/http` `HttpClient` | The one HTTP client interface, implemented by `@lando/http-client` | US-663 |
| `effect/ai` `McpServer`, `McpSchema`, `Tool.dynamic`, `Stdio` contract | The MCP server | US-665 |
| `SchemaRepresentation.fromJsonSchemaDocument`, `Schema.toStandardSchemaV1`, `toStandardJSONSchemaV1` | Editor parity test with no new dependency; Standard Schema views | US-668 |
| `Tracer`, `ErrorReporter`, `effect/observability` `OtlpTracer` + `OtlpSerialization.layerJson` | `--trace`, host hooks, opt-in export | US-669 |
| `effect/schema` `SchemaAOTCompiler` | Hot-path decoders, only past US-670's bar | US-670 |

## 10. Upstream modules rejected

| Module | Why not | Revisit when |
| --- | --- | --- |
| `@effect/platform-bun` | Its child-process spawner and runtime re-export `@effect/platform-node-shared`, which spawns through `node:child_process` and depends on `ws`. That breaks "Bun first, Node last" and §2.6 with no user-visible gain over `ProcessRunner` (`Bun.spawn`) and our signal handling | It ships a `Bun.spawn` spawner with no Node dependencies |
| `effect/process` | Its spawners live in the platform package above | Same |
| `effect/cli` | §2.3 fixes one native dispatcher tuned for cold start, and `effect/cli` is unstable | Never for dispatch |
| `effect/encoding/Yaml` | A documented subset parser with no document streams, tags, or source positions. Landofile diagnostics need positions, and Bun already parses YAML | It reaches full YAML 1.2 with positions |
| Effect `FileSystem`, `Path`, `Terminal` contracts | Our `FileSystem`, `PathsService`, and renderer IO are narrow policy-carrying contracts. Effect's are broad, with only Node-backed implementations, so adopting them means owning a roughly 40-method Bun implementation for no user-visible gain. The exception is the `Stdio` contract, which `McpServer.layerStdio` requires; `@lando/renderer` implements it over Bun (US-665) | Plugin authors ask for the standard contracts |
| `@effect/opentelemetry`, `effect/devtools` | `effect/observability` already exports OTLP with no dependency; DevTools is a contributor tool | Never / contributor experiment |
| `effect/schema` `SchemaJITCompiler` | It compiles at runtime, which conflicts with bytecode-compiled binaries and cold-start budgets | No plan |
| `@effect/vitest` | The repo runs `bun test` | Never |

## 11. Canonical spec amendments by story

| Story | Sections | Amendment |
| --- | --- | --- |
| US-662 | §2.2, §2.4, §2.5, §2.6, §13, §14.2 | TypeScript floor `^5.9.0`. Replace `Layer.scoped` with `Layer.effect` in both bullets; fiber-local state through `Context.Reference`; shells inspect `Exit`. The authored-input `optionalKey` rule. No `@effect/*` runtime dependency; `effect` pinned exactly through the catalog. `TestClock` from `effect/testing`. "argv stored in global `FiberRef`s" becomes "argv stored in module-global mutable state" |
| US-663 | §2.4, §3.4 | The three service shapes (§5), the tracing policy (§6), `DateTime`/`Clock` for time. `HttpClient` is Effect's `effect/http` `HttpClient`, implemented by `@lando/http-client` |
| US-665 | §10.14 | Protocol versions, structured tool output, elicitation-backed confirmation (an explicit input), and the resource list |
| US-667 | §13.4 | The `effect-idioms` boundary rule |
| US-668 | §7.8, §8.11 | Draft 2020-12 canonical artifacts, draft-07 editor artifacts, the `yaml-language-server` modeline, the JSON Schema parity contract, Standard Schema views; `issues` as structured `{ path, message, suggestion? }` entries |
| US-669 | §8.11, §16 | The `--trace` flag and `trace` envelope field; opt-in OTLP export; host `Tracer`, loggers, and `ErrorReporter` receive Lando spans, logs, and defects |

## 12. Measurement protocol

- US-662 records a baseline on its base commit before switching, then the same measurements after, both in `progress.txt`: `bun run bench:tooling-hot-path` and `bun run bench:opentui-startup` (three runs each, p50 and p95, plus the noise band), the linux-x64 compiled binary size from `scripts/build-compiled-binary.ts`, peak RSS of `lando app:config --format=json` against a fixture app (`/usr/bin/time -v`), and `bun run test:unit` wall time.
- A regression is a p95 above baseline by more than max(5 ms, 5%), or a binary or RSS increase above 5%. A regression blocks the PR that causes it unless the PR records the cause and a named story owns the fix.
- Every later story that touches a hot path reruns the affected benchmark and records the numbers.

## 13. Sources

- Effect 4.0 announcement: https://effect.website/blog/releases/effect/40
- Migration hub and guides: https://github.com/Effect-TS/effect/blob/main/MIGRATION.md and https://github.com/Effect-TS/effect/tree/main/migration
- Generated rename map and machine-readable rules: https://github.com/Effect-TS/effect/blob/main/migration/v3-to-v4.md and `migration/annotations/*.yaml`
- Schema: https://github.com/Effect-TS/effect/blob/main/packages/effect/SCHEMA.md and https://github.com/Effect-TS/effect/blob/main/migration/schema.md
- MCP: https://github.com/Effect-TS/effect/blob/main/packages/effect/MCP.md
