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

## Tests

- SDK tests live in `sdk/test/` and import via the canonical public path (`@lando/sdk/schema`, `@lando/sdk/errors`, …) so they exercise the same surface plugin authors will use. Bun's workspace resolver handles the self-import.
- `tsc -b` (root `bun run typecheck`) does not walk `sdk/test/`; Bun runs the tests directly. Treat `bun run typecheck` + `bun test` together as the typecheck/test gate.
