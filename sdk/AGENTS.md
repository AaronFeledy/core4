# `@lando/sdk` Instructions

The SDK is the public contract surface. Root rules apply; this file keeps SDK-specific schema and compatibility traps.

## Navigation

- `src/schema/` is the canonical Effect Schema home, imported as `@lando/sdk/schema`.
- `src/events/` contains lifecycle payload schemas; event discriminators live on `_tag`.
- `src/errors/` contains Effect `TaggedError` classes.
- `src/services/` contains `Context.Tag` shapes only; Live Layers belong in `@lando/core`.
- `src/test/` is re-exported as `@lando/sdk/test` for contract helpers.

## Schema Conventions

- Brand primitives (`AppId`, `ServiceName`, `ProviderId`, `AbsolutePath`, `PortablePath`) as `Schema.String.pipe(Schema.brand(...))`; plain strings remain the `.Encoded` wire form.
- Shared schemas live once in `src/schema/`; consuming barrels should `import` and `export type` rather than redefining.
- Schema files use `// ====` section banners with a one-line description and `SPEC:` reference.

## Gotchas

- `.Encoded` is wire/input shape and `.Type` is decoded output. `Schema.DateTimeUtc` encodes as an ISO string but decodes to `DateTime.Utc`; build fixtures on `.Encoded` and date strings via `DateTime.formatIso(dt)`.
- Do not `Schema.decodeUnknown` an already-decoded runtime value. Use `Schema.is(MySchema)` for runtime-shape assertions, or `Schema.encodeUnknownEither(MySchema)` when a test needs an encoded round trip.
- Additive public exports must be documented in `sdk/API_COMPATIBILITY.md` or `sdk/test/library/sdk-backward-compatibility.test.ts` fails. The compat test reads the "Additive Alpha schema exports" and "Additive Alpha service tags" headings even for Beta-era additions; new `@lando/sdk/test` helpers belong under "Additive Beta test helper exports".
- Public JSON Schema membership is the single `JSON_SCHEMA_REGISTRY` in `sdk/src/schema/json-schema.ts`. Add public schemas/events there, then run `bun run codegen:schema-snapshot` to refresh `sdk/test/fixtures/schema-snapshot.json`, `dist/schemas`, and `docs/reference/schemas`.
- `TaggedError` fields named `line` or `column` collide with Bun's `Error` source-location fields if declared as `Schema.optional(Schema.Number)`. Use `Schema.UndefinedOr(Schema.Number)` so Effect assigns `undefined` explicitly.
- Do not pipe `Schema.filter` onto an exported snapshotted struct with `optionalWith` defaults or `Schema.Record` fields; it collapses the published JSON Schema root. Keep the exported struct plain and apply cross-field validation on a separate decode-only schema.
- `@lando/sdk/expressions` is not `@lando/sdk/schema` and is not compatibility-frozen except for exported errors. Keep the evaluator pure data-in/data-out: no `Bun`, `process`, `node:fs`, Layers, host IO helpers, or secret values in error messages.
- A `Context.Tag<Self, {...}>` whose inline service-object methods are generic over and reference a large discriminated union (e.g. typed `EventService` methods returning `Extract<LandoEvent, {_tag:Name}>`) trips `TS2310/TS2506` ("recursively references itself as a base type"). Extract the service object into a named `export interface XShape` and pass `Context.Tag<Self, XShape>`; the indirection breaks the eager self-reference evaluation. The `services/index.ts` `declare class` MIRROR must stay an INLINE `{...}` type literal, NOT a reference to that interface — `sdk-backward-compatibility.test.ts` parses `index.ts` alone and resolves only the inline 2nd type-arg, so a cross-file interface reference reads as zero methods.
- Evolving a frozen service tag's method signatures (adding methods, changing a param shape) requires updating its entry in `sdk/test/fixtures/sdk-mvp-surface.json` (exact per-tag `toEqual`) AND adding an `## Compatibility notes` bullet in `API_COMPATIBILITY.md`. The fixture stores readable signatures; the test normalizes both sides, so match the source spelling (generics included).

## Tests

- SDK tests import public paths (`@lando/sdk/schema`, `@lando/sdk/services`, etc.) so they exercise the plugin-author surface.
- Root `tsc -b` does not walk `sdk/test/`; keep `bun run typecheck` and `bun test` paired for SDK changes.

## Plugin-abstraction contract kit

- Each §4.2 plugin-abstraction publishes a shared contract suite from `@lando/sdk/test` as a `make*ContractSuite` + `run*ContractSuite` pair (the `make*` form is an alias of the `run*` form). The six kit abstractions are `ToolingEngine`, `RouteFilter`, `SecretStore`, `ConfigTranslator`, `PluginSource`, `DoctorCheck`.
- Every kit suite MUST be exercised against its built-in implementation(s) by a `core/test/**` invocation — NEVER an `sdk/test/**` self-test (those are suite self-tests, not built-in coverage). The §13.1 layer-coverage gate `core/test/contract/plugin-abstraction-coverage.test.ts` holds a canonical manifest and FAILS when a published kit suite has no built-in invocation, when an invocation file is deleted or stops calling its suite, or when a kit suite export is renamed/removed. Adding a new §4.2 abstraction with a suite means adding a manifest row AND a built-in invocation.
- Manifest `defaultPolicy` encodes how built-in coverage is provided: `built-in` (a concrete core impl is run), `reference-mirror` (schema-only in core today, so the suite runs over the spec's documented reference transforms — e.g. `RouteFilter`), or `none-bundled` (§4.2 ships NO built-in by default — e.g. `ConfigTranslator` — so the gate requires only the suite exports). Do not fabricate a fake "built-in" to satisfy the gate for a `none-bundled` abstraction.
