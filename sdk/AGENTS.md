# AGENTS.md — `@lando/sdk`

The SDK is the API-stable surface. Per `spec/ROADMAP.md` Phasing principle 1, anything that ships here is semver-stable from the moment it lands.

## Layout

- `src/schema/` — Effect Schemas (the canonical contract surface). Imported via `@lando/sdk/schema`.
- `src/events/` — Lifecycle event payload schemas. Tag-only events; discriminator lives on `_tag`.
- `src/errors/` — Tagged error classes (Effect `TaggedError` pattern).
- `src/services/` — Effect `Context.Tag` class shapes (method names + signatures only; Live Layers live in `@lando/core`).
- `src/test/` — Test-only helpers re-exported as `@lando/sdk/test`.

## Conventions

- Brand primitives (`AppId`, `ServiceName`, `ProviderId`, `AbsolutePath`, `PortablePath`) are `Schema.String.pipe(Schema.brand(...))`. They accept plain strings in the `.Encoded` (wire) form; branding is TS-only.
- When a schema is shared across SDK modules, define it once in `schema/` and `import` + `export type` re-export it from the consuming barrel. The canonical home stays in `@lando/sdk/schema`.
- Schema modules use `// ====` section banners with a one-line description and a `SPEC:` reference (e.g. `SPEC: §5.5`). Match this style when adding a new section.

## Gotchas

- **`.Encoded` vs `.Type`:** `MySchema.Encoded` is the wire/input shape; `MySchema.Type` is the decoded output. They diverge for non-trivial leaves — e.g. `Schema.DateTimeUtc` encodes as ISO-8601 string but decodes to `DateTime.Utc`. Build wire-form fixtures on `.Encoded` and produce date strings via `DateTime.formatIso(dt)`.
- **Public-surface lock:** Anything exported from `@lando/sdk` is compatibility-locked. New additive exports must be listed in `sdk/API_COMPATIBILITY.md` or `sdk/test/library/sdk-backward-compatibility.test.ts` fails (frozen surface in `sdk/test/fixtures/sdk-mvp-surface.json`).
- **`TaggedError` field-name collisions:** Bun's `Error` superclass auto-populates `line`, `column`, etc. with the constructor's source location. A `Schema.optional(Schema.Number)` field named `line` or `column` will silently report Bun's source-line number. Use `Schema.UndefinedOr(Schema.Number)` instead — Effect explicitly assigns `undefined`, overriding Bun's built-in.

## Tests

- SDK tests live in `sdk/test/` and import via the public path (`@lando/sdk/schema`, etc.) so they exercise the same surface plugin authors use.
- `tsc -b` does not walk `sdk/test/`; Bun runs the tests directly. Treat `bun run typecheck` + `bun test` together as the gate.
