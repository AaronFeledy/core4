# AGENTS.md — `@lando/sdk`

The SDK is the API-stable surface. Per `spec/ROADMAP.md` Phasing principle 1, anything that ships here is semver-stable from the moment it lands.

## Layout

- `src/schema/` — Effect Schemas (the canonical contract surface). Imported via `@lando/sdk/schema`.
- `src/events/` — Lifecycle event payload schemas. Tag-only events; the discriminator lives on `_tag`. Imports primitives from `../schema/index.ts`.
- `src/errors/` — Tagged error classes (Effect `TaggedError` pattern).
- `src/services/` — Effect `Context.Tag` class shapes (method names + Effect signatures only; Live Layers live in `@lando/core`).
- `src/test/` — Test-only helpers re-exported as `@lando/sdk/test`.

## Conventions

- Schema modules use `// ====` section banners with a one-line description and a `SPEC:` reference (e.g. `SPEC: §5.5`). Keep this style when adding a new section so the public-API surface stays self-documenting.
- Brand primitives (`AppId`, `ServiceName`, `ProviderId`, `AbsolutePath`, `PortablePath`) are `Schema.String.pipe(Schema.brand(...))`. They accept plain strings in the `.Encoded` (wire) form; branding is a TS-only phantom.
- When a schema is shared across SDK modules (e.g. `AppRef` lives in `schema/` but is referenced by `events/`), define it once in `schema/` and `import` + `export type` re-export it from the consuming barrel. The canonical home stays in `@lando/sdk/schema`.

## Effect Schema gotchas

- `typeof MySchema.Encoded` is the wire/input shape; `typeof MySchema.Type` is the decoded output. They diverge for non-trivial leaves: `Schema.DateTimeUtc` encodes as ISO-8601 string but decodes to `DateTime.Utc`. Build wire-form fixtures on `.Encoded` and produce date strings via `DateTime.formatIso(dt)`.
- `ParseResult.ArrayFormatter.formatErrorSync(err)` returns rows whose `path` is `ReadonlyArray<PropertyKey>` (not a dotted string). Match nested-field issues via `issue.path.includes("fieldName")`; chain `.includes()` for deeper paths.
- Biome's `useLiteralKeys` flags bracket access on known properties. Prefer dot-keyed services in fixtures (`services.web`, not `services["web"]`).
- For contract-locking tests, introspect the schema directly instead of snapshotting: `MyStruct.fields` is the field map by name; `Schema.Literal(...).literals` returns the literal-option array; `Schema.Boolean.ast._tag === "BooleanKeyword"`; `Schema.Array(...).ast._tag === "TupleType"`. To prove every field is required, loop the field-name set and omit each one in turn — single-omission tests miss optional-field accidents that a per-field loop catches.
- Bun's `Error` superclass auto-populates `line` and `column` properties with the source location of the constructor call. `Schema.TaggedError` extends `Error`, so a TaggedError field declared as `Schema.optional(Schema.Number)` and named `line` or `column` will silently report Bun's source-line number when the caller omits the field. Use `Schema.UndefinedOr(Schema.Number)` instead — Effect explicitly assigns `undefined` to the instance property, overriding the Bun built-in. The same trap applies to any TaggedError field whose name collides with an Error built-in (`message` is fine because TaggedError always sets it; `cause` works because Effect routes it through Error's options bag).

## Tests

- SDK tests live in `sdk/test/` and import via the canonical public path (`@lando/sdk/schema`, `@lando/sdk/errors`, …) so they exercise the same surface plugin authors will use. Bun's workspace resolver handles the self-import.
- `tsc -b` (root `bun run typecheck`) does not walk `sdk/test/`; Bun runs the tests directly. Treat `bun run typecheck` + `bun test` together as the typecheck/test gate.
