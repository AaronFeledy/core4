# PRD: BETA1-04 — Schema publication & reference docs

## Introduction

Schema publication (§7.8 / `spec/07-landofile-and-config.md`, plus §13.2 and §13.4 in `spec/13-testing-and-distribution.md`) turns every public Effect Schema into a shipped contract. Beta 1 publishes JSON Schema files from `@lando/sdk`, exposes a central `@lando/sdk/schema` registry, generates Starlight MDX reference pages from schema AST traversal, and makes the §13.2 schema gate merge-blocking.

Depends on: **BETA1-03** (deprecation propagation supplies `DeprecationNotice` and `x-deprecation`).

## Source References

- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.8 schema and generated-doc publication.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.2 schema gate and §13.4 merge-blocking gates.
- [`spec/16-deprecation-and-surface-evolution.md`](../16-deprecation-and-surface-evolution.md) §18.2 and §18.5 deprecation notice and propagation.
- [`spec/02-toolchain.md`](../02-toolchain.md) §2.5 Effect Schema as the public contract language.

## Goals

- Publish JSON Schema draft-07 artifacts for every public schema exported from `@lando/sdk`.
- Expose a central public schema registry at `@lando/sdk/schema` and re-export schema artifacts through `@lando/core/schema`.
- Require useful schema annotations so generated schemas and docs are understandable without hand-maintained tables.
- Generate Starlight MDX schema reference pages from schema AST traversal.
- Make the §13.2 schema gate merge-blocking for round-trips, generation stability, examples, and docs build.

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

## Functional Requirements

- FR-1: All public schemas exposed by `@lando/sdk` MUST be present in the `@lando/sdk/schema` registry.
- FR-2: Build-time publication MUST emit stable JSON Schema draft-07 files under `dist/schemas/*.json`.
- FR-3: `@lando/core/schema` MUST re-export the public registry and schema helpers without owning a separate registry.
- FR-4: Public schemas MUST include `identifier`, `title`, and `description`; public fields SHOULD include descriptions unless self-explanatory.
- FR-5: Schema examples MUST decode successfully during the schema gate.
- FR-6: Generated Starlight MDX reference pages MUST come from schema AST traversal, not hand-maintained tables.
- FR-7: Deprecated schemas and fields MUST emit `deprecated: true`, `x-deprecation`, and generated docs callouts from the same notice metadata.
- FR-8: The §13.2 schema gate MUST be wired into merge-blocking CI per §13.4.

## Non-Goals

- Hosting schema artifacts at `https://schemas.lando.dev/v4/`, which is a GA Phase 7 item.
- Publishing alternate schema dialects beyond draft-07 during Beta 1, though the design may allow newer drafts later.
- Hand-authoring public schema reference tables.
- Generating SDK client libraries from JSON Schema.
- Changing the underlying contract language away from Effect Schema.

## Technical Considerations

- The documented registry surface is `@lando/sdk/schema`; implementation names may differ internally, but public PRD acceptance should use the documented entry point.
- JSON Schema generation and MDX generation should share the same traversal data to avoid drift between validator artifacts and docs.
- `DeprecationNotice` propagation depends on BETA1-03 and should not invent a second deprecation metadata shape.
- Generated files should follow the repo's codegen rule: the generator formats emitted files with `biome check --write` where applicable and fails on drift.
- Schema publication is a package artifact concern, so it should not add runtime work to CLI hot paths.

## Success Metrics

- A clean checkout can regenerate JSON schemas and MDX references with no diff after committed artifacts are up to date.
- Adding a public SDK schema without annotations or a round-trip test fails the schema gate with a named schema path.
- A deprecated field appears with matching metadata in Effect Schema annotations, JSON Schema `x-deprecation`, generated MDX, and the metadata index.

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
