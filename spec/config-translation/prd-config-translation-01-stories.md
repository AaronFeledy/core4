# PRD: Config translation and recipe provenance

Normative design: [`spec-config-translation.md`](./spec-config-translation.md). Global priorities, dependencies, and the applicable standard-gate matrix are recorded in the index and `prd.json`.

## Guide Coverage

| Story | User-visible surface | Guide |
|---|---|---|
| US-609C | explicit translation preview | `docs/guides/landofile/config-translate.mdx` |
| US-609E | recipe init cutover | affected recipe READMEs |
| US-610 | explanation | `docs/guides/landofile/config-explain.mdx` |
| US-611B | migration | `docs/guides/recipes/migrating-recipes.mdx` |

### US-607: Amend the durable core specification

**Description:** As a maintainer, I have one durable core contract before implementation begins.

**Acceptance Criteria:**
- [ ] Amend the owning core sections for authoring schemas, set-based translation, expression-preserving encoding, registration, producer provenance, declarative snapshots, secret dispositions, and the managed-file transaction and guard; add no `ConfigFormat`, bootstrap sniffing, YAML provenance tag, compatibility delete operator, or runtime emulation.
- [ ] Remove recipe wording that permits raw secrets in templates, argv, files, or provenance; add the §12.4 transaction-artifact lifecycle and exact topic/command/plugin/testing/release registry entries; the specification-only standard gates pass.
- [ ] Amend owning core specs for restart brackets, planned build users, default home storage, normalized tooling metadata, dynamic events, routes, catalog options, scoped rebuild/info, bounded global maps, and the service-version catalog; remove `LANDO_INFO`, add no `LANDO_MOUNT`, and import no legacy global state.
- [ ] Freeze the exact semantics in US-613 through US-618E, including generated reserved-env ownership, `dev.lando.*` label reservation, unknown-home failure, and catalog-derived supported versions; specification standard gates pass.
- [ ] Amend owning core sections for `@lando/lando3`, set-based conversion, authoring fragments, safe loader remediation, side-by-side operation ownership, path-only doctor ports, and removal of aggregate `LANDO_INFO`; add no `LANDO_MOUNT`.
- [ ] Exclude upgrade/adoption, legacy user-state/custom-basename import, old-image manufacture, compatibility delete values, and runtime emulation; specification standard gates pass.

### US-608A: Define authoring and set-translation contracts

**Description:** As a plugin author, I can translate one ordered foreign document set without pretending its documents are valid v4.

**Acceptance Criteria:**
- [ ] Derive complete `LandofileAuthoringShape` and recursive partial `LandofileAuthoringFragment` Effect Schemas from shared runtime field definitions, including typed whole expressions and string-only composite interpolation, with no handwritten parallel public types or value resolution during parse/check/encode.
- [ ] Extend `ConfigTranslator` with tagged `landofile-document-set` and `recipe-request` inputs and set outputs exactly as §1.1 defines; validate document or synthetic source ids by variant, methods require `never`, factories close over injected SDK ports, detection consumes bounded snapshots only, and the SDK/schema standard gates pass.

### US-608B: Register translators through every plugin seam

**Description:** As a host, I can contribute translators through the real plugin graph with deterministic collision failure.

**Acceptance Criteria:**
- [ ] Add `configTranslators` to `PluginContribution` and `LandoPluginModule`, index it in the module set, preserve lazy generated bundling, and reject duplicate ids with both stable producer identities and no precedence winner.
- [ ] Route CLI and library conversion through the same translator-capable bootstrap tier while help, version, loading, and tooling hot paths avoid translator factories; baseline/bundle/cold-start and applicable standard gates pass.

### US-608C: Implement the managed-file transaction coordinator

**Description:** As a caller, I can prepare and commit a recoverable multi-file edit without bypassing repository services.

**Acceptance Criteria:**
- [ ] Add the private managed-file transaction module with canonical-root StateStore locking, symlink rejection, contained parents, same-directory stages, `<file>.bak.<full-before-sha256>` immutable backups, exact hashes/modes, owner-only secret artifacts, and no raw bytes in output channels.
- [ ] Durably write the complete owner-only `prepared` journal after backups/stages and before mutation, transition through `committing` and fsynced `committed`, clean committed transactions only, expose no migration UI, and pass failure-boundary plus applicable standard gates.

### US-608D: Recover and guard managed-file transactions

**Description:** As a user, native loading never consumes a partial conversion or overwrites a concurrent edit during recovery.

**Acceptance Criteria:**
- [ ] Recover incomplete journals by preflighting every lock/path/absence/symlink/hash/mode and determining applied renames from before/after digests; conflicts preserve files, mark `blocked`, and require manual resolution rather than overwrite or rollback over edits.
- [ ] Add the thin non-translator load/start guard, committed cleanup, pending dry-run report, originally absent/removal recovery, and cooperative-lock/no-CAS wording; cancellation/crash and applicable standard gates pass.

### US-609A: Implement the expression-aware lando4 codec

**Description:** As a conversion caller, I can parse and emit v4 authoring data without flattening expressions or layers.

**Acceptance Criteria:**
- [ ] Parse bounded v4 YAML sets to authoring fragments and encode complete or context-validated fragment authoring trees without resolving environment, secret, file, provider, include, `.lando.ts`, or command values.
- [ ] Register the bundled `lando4` factory with its real contract-suite invocation and prove `decodeAuthoring(encode(v))` equals canonical authoring `v`, partial-prefix/final-complete validation, fragment-only emission, deterministic formatting, and no future provenance-header assertion; codec and applicable standard gates pass.

### US-609B: Implement recipe provenance and migration contracts

**Description:** As a translator and recipe producer, I can decompose merged options into traceable authoring data and publish inert migration history.

**Acceptance Criteria:**
- [ ] Add the schema-backed SDK `RecipeDecomposer` port over recipe identity, merged nonsecret options/references, and authoring-fragment output; its implementation performs no app-root detection, provider action, write, or arbitrary programmatic recipe execution.
- [ ] Contract tests cover typed option failure, missing recipe, stable identity, side-effect absence, and injected-port closure with `R = never`; applicable standard gates pass.
- [ ] Add mandatory object producer provenance, identity agreement, collision-safe family/version identity, noncircular transitive content digest, injective service map, and expression-aware option sites exactly as §3 defines; place provenance-header tests here.
- [ ] Require each secret prompt to choose `secret-store` reference or one named init-only stdin/secret-env sink; decompose receives no raw secret, central redaction covers sink failures, and schema/redaction/applicable standard gates pass.
- [ ] Add exact producer identities, `fromSnapshot`/`toSnapshot`, option types/defaults/templates/assets, the closed pure expression/helper allowlist, and declarative hunk schemas; reject IO helpers, arbitrary JS, callbacks, gaps, forks, cycles, overlap, identity drift, and missing old snapshots.
- [ ] Make bundled current snapshots safe to render without arbitrary recipe code; local programmatic recipes remain normal-init-only absent snapshots; SDK compatibility/schema/contract and applicable standard gates pass.

### US-609C: Orchestrate preview and safe v4 writes in core

**Description:** As a user, one explicit operation reads, translates, validates, previews, and safely writes a document set.

**Acceptance Criteria:**
- [ ] Core reads and orders once, invokes the frontend once per set, validates unique allowlisted outputs and partial prefixes plus final complete authoring shape, invokes the target encoder, and preserves ordered redacted diagnostics without planning or provider contact.
- [ ] `--to lando4` writes only declared v4 YAML targets through the transaction; non-v4 encoders are preview-only absent a separate safe mapping; single-layer writes only its dependency closure and fails closed on required nonselected legacy edits; guide and applicable standard gates pass.

### US-609E0: Integrate recipe init with conversion and transactions

**Description:** As a recipe user, init encodes first and runs declared auxiliary actions only after a safe commit.

**Acceptance Criteria:**
- [ ] Register and contract-test the bundled `recipe` translator, then implement the private init pipeline against an isolated test recipe using translation, expression-aware encoding, and the managed-file transaction; leave the public init registry unchanged until US-609E and pass raw secrets only to declared init-only sinks.
- [ ] Validation or commit failure runs no auxiliary action; a later postInit failure reports the committed scaffold and failed action without pretending external side effects can roll back. Shared negative secret fixtures, current public guides, and applicable standard gates pass.

### US-609E1: Convert the PHP web recipe family

**Description:** As a PHP web recipe user, init emits native authoring data and retains every scaffold asset.

**Recipe IDs:** `lamp`, `lemp`, `wordpress`, `laravel`, `symfony`

**Acceptance Criteria:**
- [ ] Replace `core/src/recipes/builtin/lamp/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, `recipes/lamp/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/lemp/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, `recipes/lemp/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/wordpress/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, `recipes/wordpress/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/laravel/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, `recipes/laravel/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/symfony/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, `recipes/symfony/README.mdx`, provider-free init, and applicable standard gates.

### US-609E2: Convert the PHP CMS recipe family

**Description:** As a PHP CMS recipe user, init emits native authoring data and retains every scaffold asset.

**Recipe IDs:** `drupal`, `drupal-cms`, `backdrop`, `joomla`

**Acceptance Criteria:**
- [ ] Replace `core/src/recipes/builtin/drupal/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, `recipes/drupal/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/drupal-cms/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, `recipes/drupal-cms/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/backdrop/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, `recipes/backdrop/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/joomla/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, `recipes/joomla/README.mdx`, provider-free init, and applicable standard gates.

### US-609E3: Convert the Node application recipe family

**Description:** As a Node application recipe user, init emits native authoring data and retains every scaffold asset.

**Recipe IDs:** `node-postgres`, `node-api`, `mean`, `node-ts`

**Acceptance Criteria:**
- [ ] Replace `core/src/recipes/builtin/node-postgres/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, generated `recipes/node-postgres/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/node-api/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, generated `recipes/node-api/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/mean/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, `recipes/mean/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/node-ts/{manifest,render}.ts` rendering with deterministic YAML decomposition and publish its declarative current snapshot; never auto-generate `.lando.ts`.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, generated `recipes/node-ts/README.mdx`, provider-free init, and applicable standard gates.

### US-609E4: Convert the Node frontend recipe family

**Description:** As a Node frontend recipe user, init emits native authoring data and retains every scaffold asset.

**Recipe IDs:** `astro`, `sveltekit`, `nextjs`

**Acceptance Criteria:**
- [ ] Replace `core/src/recipes/builtin/astro/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, generated `recipes/astro/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/sveltekit/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, generated `recipes/sveltekit/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/nextjs/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, generated `recipes/nextjs/README.mdx`, provider-free init, and applicable standard gates.

### US-609E5: Convert the Python and Ruby recipe family

**Description:** As a Python or Ruby recipe user, init emits native authoring data and retains every scaffold asset.

**Recipe IDs:** `django`, `fastapi`, `rails`

**Acceptance Criteria:**
- [ ] Replace `core/src/recipes/builtin/django/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, generated `recipes/django/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/fastapi/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, generated `recipes/fastapi/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/rails/{manifest,render}.ts` rendering from `recipes/rails/recipe.yml` with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, `recipes/rails/README.mdx`, provider-free init, and applicable standard gates.

### US-609E6: Convert the static and utility recipe family

**Description:** As a static-site or utility recipe user, init emits native authoring data and retains every scaffold asset.

**Recipe IDs:** `jekyll`, `hugo`, `eleventy`, `empty`, `toolbox`

**Acceptance Criteria:**
- [ ] Replace `core/src/recipes/builtin/jekyll/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, generated `recipes/jekyll/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/hugo/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, generated `recipes/hugo/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/eleventy/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, generated `recipes/eleventy/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/empty/{manifest,render}.ts` rendering with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault or explicit no-option behavior, an explicit empty auxiliary inventory, generated `recipes/empty/README.mdx`, provider-free init, and applicable standard gates.
- [ ] Replace `core/src/recipes/builtin/toolbox/{manifest,render}.ts` rendering from `recipes/toolbox/recipe.yml` with deterministic decomposition and publish its declarative current snapshot.
- [ ] Cover default/nondefault options, declared files/postInit or an explicit empty inventory, generated `recipes/toolbox/README.mdx`, provider-free init, and applicable standard gates.

### US-609E: Verify the bundled recipe conversion milestone

**Description:** As a maintainer, the complete 24-recipe registry has aggregate evidence across six cohesive implementation batches.

**Acceptance Criteria:**
- [ ] Verify the exact `core/build.config.ts` 24-id registry has one passing batch story per recipe id, current declarative snapshot, generated or existing executable README, default/nondefault coverage, and explicit auxiliary inventory.
- [ ] Switch the single public init registry to the prepared replacements, delete obsolete renderer bindings and the expander with no runtime fallback, publish prepared executable READMEs, and run aggregate recipe, guide-drift, transcript, schema, typecheck, test, lint, codegen, and boundary gates; this story adds no recipe-specific implementation.

### US-610: Explain provenance without inferring intent

**Description:** As a user, I can inspect bounded producer and expression facts without app execution or mutation.

**Acceptance Criteria:**
- [ ] Report exact producer/version/options, accepted-by-value or chosen-by-value as a heuristic, complete expression references, taken-over literals, and injective service mapping from matched declarative snapshots.
- [ ] Block `.lando.ts`, includes, missing/older producer snapshots, and invalid maps from semantic comparison while still reporting bounded current facts; planner/provider/write/app-code doubles stay unused, and guide plus applicable standard gates pass.

### US-611B: Analyze and commit recipe migration edges

**Description:** As a user, I can review stable hunks and commit only a fully satisfied edge prefix through the shared transaction.

**Acceptance Criteria:**
- [ ] Render old/new snapshots with current persistable options, classify stable hunk ids as `already-satisfied`, `selected`, `retained-option`, or `blocking`, and enforce exact ownership/presence/value checks, higher-layer option ownership, and site-level takeovers.
- [ ] Retained options may satisfy an edge; structural decline/conflict/dependency block blocks the entire edge and all later edges; service rename updates its map and all managed references atomically or blocks; deterministic interactive/yes/dry-run and applicable standard gates pass.
- [ ] Apply only the longest fully satisfied edge prefix, advance each edge in memory and persist the final version and producer once in the same transaction, retain taken-over literals, and store no partial-edge or durable per-hunk progress state.
- [ ] Repeats are byte-identical no-ops, lossy fallback is forbidden, pending/blocked recovery is honored, the migration guide ships, and failure-injection plus applicable standard gates pass.
