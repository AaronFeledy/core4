# PRD: BETA1-04 — Schema publication, reference docs & Landofile serialization

## Introduction

Schema publication (§7.8 / `spec/07-landofile-and-config.md`, plus §13.2 and §13.4 in `spec/13-testing-and-distribution.md`) turns every public Effect Schema into a shipped contract. Beta 1 publishes JSON Schema files from `@lando/sdk`, exposes a central `@lando/sdk/schema` registry, generates Starlight MDX reference pages from schema AST traversal, and makes the §13.2 schema gate merge-blocking.

Depends on: **BETA1-03** (deprecation propagation supplies `DeprecationNotice` and `x-deprecation`).

This PRD also absorbs the canonical Landofile serializer primitive. The serializer is folded into schema publication because it publishes the stable `@lando/sdk/landofile` / `@lando/core/landofile` surface, codifies a round-trip contract, and participates in the same SDK export, package-export, and compatibility gates as the rest of the public schema surface.

The serializer work is validated by the downstream **BETA1-11** SDK/library acceptance suite; the schema-publication dependency is now internal to this PRD.

## Source References

- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.8 schema and generated-doc publication.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.2 schema gate and §13.4 merge-blocking gates.
- [`spec/16-deprecation-and-surface-evolution.md`](../16-deprecation-and-surface-evolution.md) §18.2 and §18.5 deprecation notice and propagation.
- [`spec/02-toolchain.md`](../02-toolchain.md) §2.5 Effect Schema as the public contract language.

### Landofile serializer source references

- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.8.1 canonical Landofile serializer (round-trip law, supported domain, encoded-form contract).
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.4.1 config translation (fragment validation before write).
- [`spec/09-embedding.md`](../09-embedding.md) §16.2 public API surface (`@lando/core/landofile` entry point and stability).
- [`spec/10-plugins.md`](../10-plugins.md) §9.5 config-translator contribution rules.
- [`spec/02-toolchain.md`](../02-toolchain.md) §2.7 package surface and entry-point policies.
- [`spec/04-pluggability.md`](../04-pluggability.md) §4.5 mandatory abstraction guarantees (tagged errors, schema-defined data).
- [`spec/beta-1/prd-beta-1-00-index.md`](./prd-beta-1-00-index.md) verification contract and SDK/schema rules.

## Goals

- Publish JSON Schema draft-07 artifacts for every public schema exported from `@lando/sdk`.
- Expose a central public schema registry at `@lando/sdk/schema` and re-export schema artifacts through `@lando/core/schema`.
- Require useful schema annotations so generated schemas and docs are understandable without hand-maintained tables.
- Generate Starlight MDX schema reference pages from schema AST traversal.
- Make the §13.2 schema gate merge-blocking for round-trips, generation stability, examples, and docs build.

### Landofile serializer goals

- Publish `@lando/sdk/landofile` as the canonical, pure serializer pair for the block-style Landofile subset, re-exported from `@lando/core/landofile`.
- Encode the §7.8.1 round-trip law and supported value domain as a contract suite that runs against the public surface.
- Replace bare `Error` throws with a tagged `LandofileEmitError`, add a typed `Either` variant, and validate map keys and the value domain so a bad input fails loudly instead of writing invalid YAML.
- Close the `${…}` round-trip hole so translator-emitted `${secret:…}` references round-trip unchanged.
- Migrate every existing emitter/parser call site onto the published primitive and delete the private copies.

## User Stories

### US-224: JSON Schema export for every public SDK schema

**Description:** As a tooling author, I need draft-07 JSON Schema files for every public Lando schema so editors, validators, and external integrations can validate Lando contracts.

**Acceptance Criteria:**

- [ ] All public Effect Schemas for Landofile, global config, service config, expression AST and resolution errors, tooling config, route config, healthcheck config, plugin manifest, event payloads, and other `@lando/sdk` contracts are included in JSON Schema export.
- [ ] Build-time publication emits stable `dist/schemas/*.json` files using JSON Schema draft-07 by default.
- [ ] JSON Schema generation comes from schema AST traversal, not hand-written schema files.
- [ ] Schema definitions preserve identifiers, titles, descriptions, field descriptions, examples where present, and deprecation annotations.
- [ ] Generation failures identify the schema id and fail the schema gate.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-225: Central public schema registry and metadata index

**Description:** As a library consumer, I need one public registry that lists available schemas and their generated artifact metadata.

**Acceptance Criteria:**

- [ ] `@lando/sdk/schema` exposes the central public schema registry for all published SDK schemas.
- [ ] `@lando/core/schema` re-exports the public schema registry and generated schema helpers without creating a second source of truth.
- [ ] Build-time publication emits a schema metadata index that maps schema id to title, description, package export, JSON artifact path, docs path, and deprecation state when present.
- [ ] The registry is the input for JSON Schema export and generated MDX reference pages.
- [ ] The registry avoids undocumented identifiers that were not found in the spec and treats `@lando/sdk/schema` as the canonical documented surface.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-226: Required schema annotations enforcement

**Description:** As a docs reader, I need generated schema references to have names, descriptions, and examples that explain public fields clearly.

**Acceptance Criteria:**

- [ ] Every public schema in the registry has an `identifier`, `title`, and `description` annotation.
- [ ] Public fields have descriptions unless a field is self-explanatory under the documented exemption rules.
- [ ] Examples attached to schemas or fields decode successfully during the schema gate.
- [ ] Missing required annotations fail with actionable output naming the schema and field path.
- [ ] The enforcement rule applies to new schemas before they can be added to `@lando/sdk` public exports.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-227: Generated MDX schema reference pages

**Description:** As a user or plugin author, I need Starlight reference pages generated from the same schemas that validators use.

**Acceptance Criteria:**

- [ ] Build-time publication generates MDX schema reference pages for Starlight from schema AST traversal.
- [ ] Generated pages include schema title, description, field table, required fields, examples, defaults, accepted values, and links to JSON Schema artifacts.
- [ ] Deprecated schemas and fields show callouts such as `Deprecated since X` from `DeprecationNotice` metadata.
- [ ] Hand-maintained schema tables are not accepted for public schema reference pages.
- [ ] The docs build uses the generated pages and fails if generated docs drift from schema source.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-228: Merge-blocking §13.2 schema gate

**Description:** As a maintainer, I need CI to block schema changes that lack tests, annotations, stable JSON output, or docs generation.

**Acceptance Criteria:**

- [ ] Every public schema has a dedicated `bun test` file that covers a happy path, an error path, and encode/decode round-trip behavior.
- [ ] The schema gate verifies required annotations, decodes examples, generates JSON Schema successfully, and checks stable output.
- [ ] Generated reference docs build without hand edits.
- [ ] New public schemas are rejected unless they have round-trip tests and required annotations.
- [ ] The gate is wired into the merge-blocking §13.4 CI path.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-229: `x-deprecation` propagation end to end

**Description:** As a tooling consumer, I need deprecated schema surfaces to carry complete deprecation metadata in JSON Schema and generated docs.

**Acceptance Criteria:**

- [ ] `DeprecationNotice` from BETA1-03 US-215 is accepted as the only deprecation annotation payload for schemas and fields.
- [ ] Annotated schemas emit `deprecated: true` and valid `x-deprecation` in generated JSON Schema.
- [ ] Generated MDX reference pages render the same deprecation metadata as Starlight callouts.
- [ ] The schema gate validates every emitted `x-deprecation` against the `DeprecationNotice` schema and round-trips it losslessly.
- [ ] `DeprecationNotice` itself is included in `dist/schemas/deprecation-notice.json` and the metadata index.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

The following stories are folded in from the Landofile serializer primitive scope.

### US-307: Publish the `@lando/sdk/landofile` serializer surface

**Description:** As a config-translator plugin author or embedding host, I can emit, parse, and test canonical Landofile YAML through a stable published surface instead of hand-writing YAML or importing `@lando/core` internals.

**Acceptance Criteria:**

- [ ] `@lando/sdk/landofile` exports `emitLandofileYaml(value): string`, `emitLandofileYamlEither(value): Either<string, LandofileEmitError>`, `parseLandofile({ file, content, cwd }): Effect<unknown, LandofileParseError>`, and the `LandofileEmitError` tagged error.
- [ ] The subpath is pure logic (no Effect Layers, no Bun runtime services, no FS, no `@oclif/core`), mirroring `@lando/sdk/expressions`.
- [ ] `LandofileEmitError` lives on the `@lando/sdk/landofile` subpath, not the frozen `@lando/sdk/errors` barrel (matching `@lando/sdk/template` error placement).
- [ ] `sdk/package.json#exports` adds `"./landofile"`; `core/package.json#exports` adds `"./landofile"` re-exporting the SDK subpath.
- [ ] `sdk/API_COMPATIBILITY.md` lists the new helpers under "Additive Alpha service helpers" and `LandofileEmitError` under "Additive Alpha errors"; SDK export fixtures and the `sdk/test/library/exports.test.ts` assertions are updated in the same change.
- [ ] No entry is added to `JSON_SCHEMA_REGISTRY` (the primitive publishes functions and one error, not a schema); the schema-snapshot gate runs clean with no diff.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-308: Harden the serializer to the published round-trip contract

**Description:** As a maintainer, I can trust that the serializer rejects unrepresentable inputs with a tagged error and round-trips every value in its documented domain, including secret references.

**Acceptance Criteria:**

- [ ] Map keys are validated against `^[A-Za-z0-9_.-]+$`; a non-conforming key fails with a path-tagged `LandofileEmitError` instead of emitting unparseable YAML.
- [ ] Non-emittable values — `undefined`, non-finite numbers, `bigint`, dates, functions, symbols, class instances, non-string keys, and nested arrays — fail with `LandofileEmitError` (replacing the current bare `throw new Error`).
- [ ] A quoted scalar is treated as a literal on parse, so a translator fragment containing `${secret:DB_PASSWORD}` round-trips through `parseLandofile(emitLandofileYaml(x))` unchanged rather than being rejected as an expression.
- [ ] The serializer documents (TSDoc + §7.8.1) that it consumes the encoded (wire) form of a Landofile (`LandofileShape.Encoded` / the merged tree), not a decoded runtime `LandofileShape.Type`.
- [ ] Optional deterministic key ordering is available via an explicit option (default preserves insertion order, no behavior change); canonical-write call sites may opt into sorted output.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-309: Migrate existing emitter/parser call sites to the published primitive

**Description:** As a maintainer, I can reason about one serializer instead of a private core copy plus scattered importers.

**Acceptance Criteria:**

- [ ] The three `emitLandofileYaml` importers (`core/src/cli/commands/app-config-translate.ts`, `core/src/cli/commands/doctor-report.ts`, `core/src/cli/commands/config.ts`) import from `@lando/sdk/landofile` (or the `@lando/core/landofile` re-export); the private `core/src/landofile/yaml-emit.ts` is removed.
- [ ] `core/src/landofile/parser.ts` importers resolve to the published `parseLandofile`; the parser is either moved to `@lando/sdk/landofile` with importers re-pointed, or left as a one-line re-export shim that delegates to the published implementation (no second implementation).
- [ ] Existing behavior is byte-identical for all previously valid inputs; the only intended behavior changes are the new rejections (previously bare throws) and the more permissive quoted-`${…}` parse.
- [ ] The repo `AGENTS.md` "Canonical Landofile→YAML emitter" note is updated to the published path.
- [ ] Source-mode and compiled `$bunfs` dispatch paths use the same published serializer for `app:config:translate`, `app:config:set`/`unset`, doctor YAML, and global-config writes.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-310: Enforce the round-trip contract suite and exports gate

**Description:** As a maintainer or plugin author, I can prove the serializer obeys the §7.8.1 round-trip law and the surface stays stable.

**Acceptance Criteria:**

- [ ] A round-trip contract suite imports the public `@lando/sdk/landofile` surface and asserts `parseLandofile(emitLandofileYaml(x))` deep-equals `x` across a corpus covering scalars, quoted ambiguous strings, nested maps, scalar arrays, arrays-of-maps, empty `{}`/`[]`, and `${secret:…}` references.
- [ ] The suite asserts the rejection set (key-shape violations, `undefined`, non-finite numbers, `bigint`, nested arrays) fails with `LandofileEmitError` and never emits.
- [ ] The suite proves a merged `LandofileShape` fragment re-decodes after emit (translator-fragment preview path) and that emitted output is deterministic for a fixed input.
- [ ] `sdk/test/library/exports.test.ts` asserts the subpath exports (`emitLandofileYaml`, `emitLandofileYamlEither`, `parseLandofile`, `LandofileEmitError`).
- [ ] The existing `core/test/unit/landofile-yaml-emit.test.ts` coverage is preserved (relocated to the public-path suite) with no loss of cases.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

## Functional Requirements

- FR-1: All public schemas exposed by `@lando/sdk` MUST be present in the `@lando/sdk/schema` registry.
- FR-2: Build-time publication MUST emit stable JSON Schema draft-07 files under `dist/schemas/*.json`.
- FR-3: `@lando/core/schema` MUST re-export the public registry and schema helpers without owning a separate registry.
- FR-4: Public schemas MUST include `identifier`, `title`, and `description`; public fields SHOULD include descriptions unless self-explanatory.
- FR-5: Schema examples MUST decode successfully during the schema gate.
- FR-6: Generated Starlight MDX reference pages MUST come from schema AST traversal, not hand-maintained tables.
- FR-7: Deprecated schemas and fields MUST emit `deprecated: true`, `x-deprecation`, and generated docs callouts from the same notice metadata.
- FR-8: The §13.2 schema gate MUST be wired into merge-blocking CI per §13.4.

### Landofile serializer functional requirements

- FR-1: All Landofile-fragment-to-disk serialization in core MUST flow through the published serializer; per-recipe and per-command hand-written YAML is forbidden where the serializer applies.
- FR-2: The serializer pair MUST satisfy the §7.8.1 round-trip law for every value in the supported domain.
- FR-3: Inputs outside the supported domain MUST fail with `LandofileEmitError`; they MUST NOT silently emit corrupt or unparseable YAML.
- FR-4: A quoted scalar MUST parse as a literal so `${secret:…}` references emitted by translators round-trip unchanged.
- FR-5: The serializer MUST consume the encoded Landofile form; decoded runtime objects with branded/`DateTime` leaves are out of contract.
- FR-6: `@lando/sdk/landofile` MUST be pure logic and MUST NOT pull `@oclif/core` or the full runtime; `@lando/core/landofile` is a thin re-export.
- FR-7: `LandofileEmitError` MUST NOT widen the frozen `@lando/sdk/errors` / `@lando/core/errors` barrels; it rides the subpath.
- FR-8: Adding the surface MUST update `sdk/API_COMPATIBILITY.md`, the SDK export fixtures, and `exports.test.ts` in the same change, and MUST leave the §13.2 schema snapshot unchanged.

## Non-Goals

- Hosting schema artifacts at `https://schemas.lando.dev/v4/`, which is a GA Phase 7 item.
- Publishing alternate schema dialects beyond draft-07 during Beta 1, though the design may allow newer drafts later.
- Hand-authoring public schema reference tables.
- Generating SDK client libraries from JSON Schema.
- Changing the underlying contract language away from Effect Schema.

### Landofile serializer non-goals

- Introducing a full YAML library or supporting flow style, anchors/aliases, multi-document streams, or block scalars beyond the existing block-style subset.
- Making the serializer a pluggable `Context.Tag` abstraction; it is pure logic, not a swappable service.
- Adding live `{{ … }}` expression evaluation or `${VAR}` shell expansion to the parser; expression resolution remains the staged concern of §7.3.1.
- Changing the six-file merge semantics (§7.2) or the `LandofileShape` schema.
- Round-tripping comments or formatting/whitespace fidelity; the serializer is value-canonical, not source-preserving.

## Technical Considerations

- The documented registry surface is `@lando/sdk/schema`; implementation names may differ internally, but public PRD acceptance should use the documented entry point.
- JSON Schema generation and MDX generation should share the same traversal data to avoid drift between validator artifacts and docs.
- `DeprecationNotice` propagation depends on BETA1-03 and should not invent a second deprecation metadata shape.
- Generated files should follow the repo's codegen rule: the generator formats emitted files with `biome check --write` where applicable and fails on drift.
- Schema publication is a package artifact concern, so it should not add runtime work to CLI hot paths.

### Landofile serializer technical considerations

- Keep the emitter pure and synchronous so existing sync call sites (`writeFileSync` in `config.ts`, `renderDoctorReportAsYaml`) keep working; the throwing form throws a `TaggedError`, and the `Either` form is for callers that prefer typed handling.
- The parser already returns an `Effect` consuming `LandofileParseError`; keep that signature when moving it so its ten existing importers change only their import path.
- Prefer re-pointing the three emitter importers fully (trivial) and, if a smaller diff is wanted for the ten parser importers, leaving a one-line re-export shim — but never a second implementation.
- The quoted-literal fix is the only parser behavior change; cover it explicitly so a future refactor cannot silently re-reject quoted `${…}`.
- Plugin packages depend only on `@lando/sdk` for the serializer; plugin code must not import `@lando/core` internals to emit YAML.

## Success Metrics

- A clean checkout can regenerate JSON schemas and MDX references with no diff after committed artifacts are up to date.
- Adding a public SDK schema without annotations or a round-trip test fails the schema gate with a named schema path.
- A deprecated field appears with matching metadata in Effect Schema annotations, JSON Schema `x-deprecation`, generated MDX, and the metadata index.

### Landofile serializer success metrics

- Grepping core shows one serializer implementation and no private `yaml-emit.ts` copy; all importers resolve to the published surface.
- The round-trip contract suite runs against the public path and covers the full supported domain plus the rejection set.
- A config-translator author can emit and re-decode a fragment (including `${secret:…}`) in a unit test using only `@lando/sdk`.
- The schema snapshot and SDK backward-compat fixtures stay green after the surface is added (additive only).

## Guide Coverage

Per [PRD-12 US-198](../alpha-3/prd-alpha-3-12-executable-guides.md) (`## Guide Coverage` convention) and [US-199](../alpha-3/prd-alpha-3-12-executable-guides.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-224 | JSON Schema artifacts for public schemas | `docs/guides/schemas/json-schema-artifacts.mdx` | Required at story acceptance |
| US-225 | `@lando/sdk/schema` registry and metadata index | `docs/guides/schemas/schema-registry.mdx` | Required at story acceptance |
| US-227 | Generated schema reference pages | `docs/guides/schemas/generated-reference-docs.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `sdk/src/schema/**`
- `sdk/src/**/*.ts`
- `core/src/schema/**`
- `core/src/docs/**`
- `scripts/codegen*`
- `scripts/build-schema*`
- `scripts/check-schema*`
- `docs/guides/schemas/**`
- `docs/guides/INDEX.md`

## Open Questions

- Should Beta 1 emit a draft newer than draft-07 alongside the default draft-07 artifacts? Default: no, draft-07 only.
- Should generated MDX pages live under `docs/guides/schemas/` or a Starlight reference-only tree? Default: Starlight reference tree, with guides linking to it.
- How strict should the field-description exemption be for obvious scalar fields like `name` or `id`? Default: allow an explicit exemption list checked by the schema gate.
- Should the metadata index include unpublished internal schemas used by generated docs? Default: no, only public registry schemas.

### Landofile serializer open questions

- Should canonical writes (`translate --write`, `config set`) opt into sorted-key output for stabler diffs, or preserve construction order? Default: preserve order; expose `sortKeys` as an opt-in and revisit defaulting at GA.
- Should the parser move to `@lando/sdk/landofile` outright or stay in core behind a re-export shim for Beta 1? Default: move the emitter outright; shim the parser now and drop the shim in a follow-up if the import churn is undesirable.
- Should `emitLandofileYaml` accept a typed `Partial<LandofileShape>` overload in addition to the permissive record input? Default: accept both via a union input type; document the encoded-form requirement.
