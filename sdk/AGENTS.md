# AGENTS.md — `@lando/sdk`

The SDK is the API-stable surface. Anything that ships here is semver-stable from the moment it lands.

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
- **No `Schema.decodeUnknown` on already-decoded values:** decoders expect the encoded form. Calling `Schema.decodeUnknownSync(ServicePlan)` on a runtime `ServicePlan` re-fails on branded leaves such as `metadata.resolvedAt: DateTime` (decoder wants the string form). Use `Schema.is(MySchema)` to validate runtime shape, or `Schema.encodeUnknownEither(MySchema)` to round-trip through the encoded form. Same trap bites tests that mutate a plan in place and then re-decode it — mutate, cast, and rely on the runner's `Schema.is` instead.
- **Public-surface lock:** Anything exported from `@lando/sdk` is compatibility-locked. New additive exports must be listed in `sdk/API_COMPATIBILITY.md` or `sdk/test/library/sdk-backward-compatibility.test.ts` fails (frozen surface in `sdk/test/fixtures/sdk-mvp-surface.json`). The backward-compat test only reads the "Additive Alpha schema exports" / "Additive Alpha service tags" headings — even Beta-era additions land under those headings, not under "Additive Beta…". New `@lando/sdk/test` helpers go under "Additive Beta test helper exports" (not asserted by the backward-compat test).
- **§13.2 schema snapshot registry is three places:** adding a public schema requires sync across (1) `JSON_SCHEMA_REGISTRY` in `sdk/src/schema/index.ts`, (2) the `getJsonSchema` switch in the same file (omitted cases compile fine but `getJsonSchema("X")` returns `undefined`), and (3) `SDK_SCHEMA_NAMES` in `scripts/build-schema-snapshot.ts`. Miss any one and `bun run codegen:schema-snapshot` silently drops the schema from `sdk/test/fixtures/schema-snapshot.json`.
- **`TaggedError` field-name collisions:** Bun's `Error` superclass auto-populates `line`, `column`, etc. with the constructor's source location. A `Schema.optional(Schema.Number)` field named `line` or `column` will silently report Bun's source-line number. Use `Schema.UndefinedOr(Schema.Number)` instead — Effect explicitly assigns `undefined`, overriding Bun's built-in.
- **Cross-field rules on a snapshotted struct:** piping `Schema.filter` onto a top-level identified struct that has `optionalWith` defaults or `Schema.Record` fields collapses its published JSON Schema to an inline root, dropping the `$defs` entry plus `title`/`description` (a snapshot regression). Keep the exported schema a plain annotated struct and apply cross-field refinements on a separate decode-only schema (see `GuideFrontmatterChecked` in `sdk/src/docs/guide-frontmatter.ts`).
- **Configuration-expression engine is the `@lando/sdk/expressions` subpath, NOT `@lando/sdk/schema`:** `ast.ts` (AST), `parser.ts` (lexer/recursive-descent → `ExpressionTemplate`), `context.ts` (`ExpressionContext`), and `evaluator.ts` (pure sandboxed evaluator) all live there and are NOT compat-locked — the backward-compat fixture only freezes `@lando/sdk/schema` exports + service-tag signatures, so AST nodes, the context shape, and evaluator APIs are purely additive (only new *errors* need an `API_COMPATIBILITY.md` "Additive Alpha errors" entry + a presence assertion in `exports.test.ts`). The evaluator is PURE (no `Bun`/`process`/`node:fs`/Layers), mirroring the parser — keep it data-in/data-out. The sandbox is three things: (1) `FORBIDDEN_HELPERS` + the whole `fs.*` namespace throw `LandofileExpressionForbiddenError` (the IO/process carve-out helpers — `load`/`import`/`text`/`bytes`/`hash`/`which`/`glob`/`fs.*` — are intentionally unavailable here; `load()` becomes a core wiring concern when FileSystem is in scope); (2) `yaml`/`fromYaml`/`fromToml` are recognized-but-UNSUPPORTED (→ `LandofileExpressionEvalError`, not forbidden — parsing a provided string is not IO); (3) context traversal reads OWN-enumerable props only via `propertyIsEnumerable` and rejects the `BLOCKED_KEYS` (`__proto__`/`prototype`/`constructor`) + function/symbol values (TS `readonly` is not a runtime boundary). Parser distinguishes `path.a` (stays a `Path` node) from `(path).a` / `(call()).a` (an `AccessExpressionNode`) via the `forceAccess` flag set on parenthesized primaries. Whole-template type preservation only when `template.whole === true`; mixed/`${VAR}` templates always render strings. Never put a secret/credential VALUE in an error `message`/`cause` (forbidden errors carry the helper NAME only).

## Tests

- SDK tests live in `sdk/test/` and import via the public path (`@lando/sdk/schema`, etc.) so they exercise the same surface plugin authors use.
- `tsc -b` does not walk `sdk/test/`; Bun runs the tests directly. Treat `bun run typecheck` + `bun test` together as the gate.
