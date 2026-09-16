# Spec: Config translation and recipe provenance

Status: normative authored design, pre-implementation. This specification supersedes the earlier `spec-config-formats.md` draft (deleted) and amends the core sections listed in §7 below.

Where this document says **MUST**, **MUST NOT**, **SHOULD**, or **MAY**, those words carry RFC 2119 weight.

## 1. Model

Configuration enters through frontends, lowers to the canonical authoring IR, and either proceeds through normal loading to the runtime input IR or is encoded as a file:

```text
frontends                      authoring IR                    runtime IR        plan IR
─────────                      ────────────                    ──────────        ───────
lando4 YAML loader ──────────┐
Lando 3 set translator ──────┼─► LandofileAuthoringShape ────► LandofileShape ─► AppPlan
recipe + safe answers ───────┤             │
other explicit translators ──┘             └─► ConfigTranslator.encode ─► target text
```

`LandofileAuthoringShape` is the expression-aware authoring wire tree. `LandofileShape` is the resolved runtime input IR. `AppPlan` is the provider-neutral plan IR. Frontends MUST NOT emit `AppPlan`, and text backends MUST NOT encode from `LandofileShape` or `AppPlan`.

Three verbs use the pipeline:

| Verb | Frontend | Backend | Planning |
|---|---|---|---|
| `start` | The normal `lando4` YAML/TS loader | Active provider | Builds and applies `AppPlan` |
| `init` | Bundled `recipe` translator with resolved answers | Bundled `lando4` encoder | Never plans or contacts a provider |
| `translate` | Explicitly selected or detected `ConfigTranslator` | Encoder selected by `--to`; default `lando4` | Never plans or contacts a provider |

`start` is deliberately not format discovery. The normal loader remains the only bootstrap path. `init` and `translate` are explicit conversion operations.

### 1.1 Authoring-IR invariant and ownership

**Invariant:** core invokes a translator once for one ordered document set, not once per document. Core owns discovery, bounded reads, canonical layer ordering, path policy, authoring-prefix validation, final authoring validation, encoding, and mutation. The selected frontend owns foreign parsing, foreign merge semantics, source-to-target folding, diagnostics, and output ownership.

`ConfigTranslateInput` is a tagged union:

- `landofile-document-set` carries `documents`, `mode`, `selectedSourceIds`, `currentLowerV4Fragments`, and `writableLayerIds`. Each document carries bounded raw bytes plus `sourceId`, allowlisted `layerId`, `contentDigest`, and `mediaType`. `documents` are already in core's canonical source order. `mode` is `full` or `single-layer`. In single-layer mode, selected source ids are nonempty and current lower-precedence v4 authoring fragments provide validation context. Raw foreign documents are never predecoded as v4.
- `recipe-request` carries recipe identity, a core-assigned synthetic `sourceId`, and schema-decoded nonsecret answers or approved secret references. Raw secret answers are omitted. This variant is separate from a document set and has no implied app-root discovery; output `sourceIds` refer to that synthetic source, and deletion intents are forbidden.

`ConfigTranslateResult` contains `outputs: [{ targetLayer, fragment, sourceIds }]`, ordered diagnostics, and ordered deletion intents. Each `fragment` is a recursive partial `LandofileAuthoringFragment`. Multiple source documents MAY fold into one output. Output `targetLayer` values MUST be unique and drawn from the core-provided writable-layer allowlist. Every `sourceId` MUST name a source declared by the input variant: a document source for `landofile-document-set`, or the synthetic source for `recipe-request`. A translator MUST NOT invent a layer id, read a file, follow a reference, write, delete, plan, or mutate the app.

`ConfigTranslateDetectInput` contains the same core-read bounded raw snapshots and source metadata needed for matching, without current v4 fragments or mutation fields. Detection and translation perform no plugin filesystem reads.

`ConfigTranslateDiagnostic` carries source id, key path, optional start/end line and column span, kind, message, and remediation. Diagnostics and deletion intents are ordered by input-document order, source span, then key path. Core validates deletion paths and performs every deletion.

Consequences:

- The `lando4` encoder is lossless over the supported `LandofileAuthoringShape` domain, including authoring expressions.
- A capability present in runtime `LandofileShape` but not expressible by the authoring schema is a schema defect, not grounds for a frontend-local extension or residual bag.
- Until a capability enters the authoring IR, a frontend MUST omit it with a `dropped` diagnostic or reject the input with `unsupported`; it MUST NOT conceal the loss.

### 1.2 Expression-aware authoring schemas

`LandofileAuthoringShape` and `LandofileAuthoringFragment` are public Effect Schema values derived from the same field definitions as runtime `LandofileShape`; there are no parallel handwritten public types. The complete shape requires every final Landofile invariant. The fragment is recursively partial and exists only for layer merge and emission.

An authorable field admits its ordinary literal type and the expression form allowed by its shared field definition. A whole-value expression is legal only where its declared expected type is the field type. Composite interpolation is legal only at string-valued sites. Parsing validates expression syntax, the allowed scope/helper name, and the expected output type. Authoring parse, merge, validation, and encoding MUST NOT resolve environment values, secrets, files, provider data, app code, or commands.

Core validates each cumulative merge prefix as a partial authoring value and validates the final merged value as complete `LandofileAuthoringShape`. Full runtime `LandofileShape` validation happens only through normal loading and staged expression resolution. Tests MAY perform runtime validation with fixtures whose expressions use known pure values.

`ConfigTranslateEncodeInput` carries an authoring wire tree and, for fragment emission, its already-validated complete merge context plus the exact output fragment. The encoder validates the fragment in that full context but emits only the fragment, so writing one layer never flattens lower layers.

### 1.3 Extended `ConfigTranslator`

`ConfigTranslator` is extended in place. Its name, service identity, manifest metadata, and `configTranslators:` contribution surface remain unchanged.

```ts
export interface ConfigTranslator {
  readonly id: string;
  readonly summary: string;
  readonly inputKinds: ReadonlyArray<string>;

  readonly detect: (input: ConfigTranslateDetectInput) =>
    Effect.Effect<ReadonlyArray<ConfigTranslateMatch>, ConfigTranslateError, never>;

  readonly translate: (
    input: ConfigTranslateInput,
  ) => Effect.Effect<ConfigTranslateResult, ConfigTranslateError, never>;

  readonly encode?: (
    input: ConfigTranslateEncodeInput,
  ) => Effect.Effect<ConfigTranslateEncodeResult, ConfigTranslateError, never>;
}
```

`detect` remains the authoritative explicit-detection operation. `translate` consumes one selected set or one recipe request and returns authoring fragments plus diagnostics and deletion intents. Optional `encode` accepts `LandofileAuthoringShape` or a context-validated authoring fragment and returns target-format text plus `non-portable` or other diagnostics. A decode-only translator is valid.

Public translator methods require `never`. Factories close over explicitly injected SDK ports such as `RecipeDecomposer`; translators do not request Effect services dynamically and do not import core. `RecipeDecomposer` accepts the translator's already foreign-merged recipe options and returns schema-encoded authoring data. This keeps foreign merge ownership in the plugin.

For every translator `T` that ships `encode`, the contract suite MUST enforce this law on its supported decoded domain:

```text
decodeAuthoring_T(T.encode(v).text) ≡ canonicalAuthoring_T(v)
```

`≡` compares canonical authoring values, including expression AST and expected types, not resolved runtime values or wrapper composition. Formatting and a leading comment block are not parsed state. The law does not promise recipe recomposition.

Two translators are bundled:

| Translator | `detect` | `translate` | `encode` |
|---|---|---|---|
| `lando4` | Detects canonical v4 YAML only when explicit detection is requested | Parses the supplied bounded v4 YAML set into authoring fragments; `.lando.ts` and includes are opaque and never executed | Calls the expression-aware canonical authoring emitter |
| `recipe` | Never matches an app root | Delegates a recipe request with nonsecret answers/references to `RecipeDecomposer` | Absent |

Plugin authors continue to contribute translators through `configTranslators:` as specified in §9.5. **Translators still never run during discovery, normal config loading, `start`, or tooling bootstrap.** Their `detect` methods run only for an explicit translation request.

### 1.4 Registration and bootstrap

Registration is a required implementation chain, not descriptive metadata. `PluginContribution` in `sdk/src/schema/plugin.ts` and `LandoPluginModule` in `sdk/src/plugins/module.ts` both gain `configTranslators`. `engine/src/plugins/module-set.ts` validates translator ids and builds the capability index. Generated bundled-plugin code carries translator factories without eagerly importing them. Duplicate ids from any bundled, system, user, app, or library-injected source fail with a tagged collision listing both stable producer identities. There is no precedence winner.

CLI `app:config:translate` and the matching library operation request the translator-capable bootstrap tier only after native argument routing identifies explicit conversion. That tier receives the generated bundle and host-injected modules through the same module-set constructor. Help, version, ordinary app loading, and tooling hot paths do not construct translator factories. Initially no translator is bundled; the policy changes explicitly as `lando4`, `recipe`, then `lando3` gain contract-suite coverage.

The `lando3` package remains plugin-only and depends only on `@lando/sdk` and `@lando/paths`. Recipe decomposition is supplied when its translator factory is constructed. The injected SDK `RecipeDecomposer` port accepts merged foreign options and has schema-backed inputs and outputs. The plugin never imports core or recipe implementation modules.

### 1.5 Target output policy

`--to lando4` preview and write encode allowlisted v4 YAML layers only. Full conversion maps outputs through the declared layer map. Single-layer conversion writes only the selected dependency closure authorized by §1.1. Core never guesses a filename and never overwrites foreign text in `.lando.yml` merely because that path is canonical.

A non-v4 translator with `encode` MAY serve preview. `--write --to <non-v4>` fails closed until that encoder registers a separate safe target mapping with allowlisted destinations, overwrite policy, and deletion policy. This set registers no such mapping.

`.lando.ts` and includes are opaque and never executed by translate, explain, or migrate. When an operation requires semantic comparison against either, it blocks that target as read-only and reports manual remediation. Normal trusted `.lando.ts` loading remains outside these automatic workflows.

## 2. Recipes as decomposers

A recipe is a decomposer:

```text
decompose(options) → LandofileAuthoringFragment
```

`decompose` replaces every bundled recipe's `render` operation and obeys these rules:

1. **Everything is written.** The result contains every service, route, tooling task, event, default, and other Landofile value the recipe selected. Runtime recipe expansion is forbidden.
2. **Landofile only.** `decompose` returns only `LandofileAuthoringFragment`. It does not write files, run `postInit`, or perform other init work.
3. **Expressions are for values, never structure.** An option MAY decide at decomposition time whether a key or service exists. No emitted expression may gate the existence of a key, array item, or service.
4. **Persistable options remain visible.** Resolved nonsecret options are written under `recipe.options`. Every secret prompt declares exactly one disposition in its schema: `secret-store` with a named reference field, or `init-only` with one named `postInit.stdin` or `postInit.secretEnv.<name>` sink. The core prompt resolver passes only the reference or omission to `decompose`, never raw secret bytes. Raw answers MAY flow directly from the prompt resolver to the declared init sink and MUST NOT enter templates, argv, files, provenance, diagnostics, journals, transcripts, renderer events, or telemetry. Central redaction covers every sink error. A recipe without a secret prompt uses the shared negative contract fixture rather than a fabricated recipe-specific secret case.
5. **Expressions preserve authoring.** Every generated value site derived from a persistable option uses a schema-valid authoring expression such as `{{ recipe.<option> }}`. Whole expressions produce the field's expected type; composite interpolation appears only at string sites. Decomposition does not resolve the expression.
6. **Recipes are versioned.** The required `RecipeManifest.version` supplies the coordinate used by provenance and migrations.

Recipe `files:` and `postInit:` remain init-only and retain every auxiliary file and action currently declared by each bundled recipe. `init` MAY execute them only after recipe translation, Landofile encoding, and successful transaction commit; raw secret bytes may reach only the prompt's declared init sink. A foreign frontend that decomposes a recipe MUST consume only the returned Landofile and MUST NOT execute either surface. The bundled `node-ts` recipe converts its automatically generated Landofile artifact to YAML; its programmatic `.lando.ts` example remains documentation-only and is never auto-generated by the CLI.

The unused runtime expansion path in `core/src/recipes/expander.ts` is deleted when this pipeline lands.

Users who require live, code-owned generation use `.lando.ts` and import the recipe module directly. That module is code the user owns; the CLI MUST NOT generate this form.

## 3. Provenance

Generated Landofiles record ordinary, inert provenance in this top-level shape. Every object-form schema, example, fixture, and table uses the same required `producer` object:

```yaml
recipe:
  id: <recipe-id>
  version: <recipe-semver>
  producer:
    sourceKind: bundled
    packageName: "@lando/recipe-<recipe-id>"
    recipeId: <recipe-id>
    manifestVersion: <recipe-semver>
    contentDigest: <sha256>
  options:
    <option>: <resolved-value>
  services:                         # optional generated-name → current-name map
    <generated-service>: <user-service>
```

The schema is `recipe: { id, version, producer: { sourceKind, packageName, recipeId, manifestVersion, contentDigest }, options, services? }`. `id == producer.recipeId` and `version == producer.manifestVersion` are mandatory. `sourceKind + packageName + recipeId` is stable family identity; adding `manifestVersion + contentDigest` yields versioned identity. Local and bundled source kinds cannot collide even when package and recipe names match. The already-accepted bare string form, `recipe: <id>`, remains valid and inert. `init` and any frontend that decomposes a recipe MUST emit the object form.

`contentDigest` is SHA-256 over canonical manifest data excluding the digest field itself and migration/history data. It includes the recipe id/version, option schemas, defaults, declarative template, file-asset metadata and digests, post-init metadata excluding secret values, and every transitive declarative recipe input in stable order. It never hashes runtime prompt answers. A changed transitive input changes versioned identity without creating a circular digest.

`{{ recipe.<option> }}` is a §7.3.1 expression scope available at bootstrap level `minimal`. It reads only `recipe.options` from the merged file data. It performs no recipe lookup and cannot run recipe code.

Management is per generated site:

- A site that still contains `{{ recipe.<option> }}` follows that option.
- Replacing the expression with a literal opts that site out. No separate opt-out field is written.
- “Accepted” versus “chosen” is a bounded heuristic, never evidence of user intent: option `<o>` is accepted-by-value when `recipe.options.<o> == default(<o>, recipe.version)` and chosen-by-value otherwise. Explain labels the heuristic. Migration may use equality to decide proposal eligibility, but every literal replacement is taken-over even when it equals or differs from generated output.
- `recipe.services` maps each generated service name to its current user-selected name. `explain` and `migrate` MUST apply this map before matching decomposed service paths, so renaming a service does not sever provenance.

`emitLandofileYaml` gains a leading-comment-block capability used only for the provenance header. Comments are emitted and never parsed, so §7.8.1's value round-trip law is unchanged.

A generated file uses this exact explanatory shape:

```yaml
# Recipe knobs. Change a value here to change every `{{ recipe.<option> }}` site below.
# Replace a `{{ recipe.<option> }}` reference with a literal to take that site over.
recipe:
  id: drupal
  version: 1.4.0
  producer:
    sourceKind: bundled
    packageName: "@lando/recipe-drupal"
    recipeId: drupal
    manifestVersion: 1.4.0
    contentDigest: "<sha256-of-canonical-recipe-inputs>"
  options: { php: "8.5", webroot: web, database: mariadb:11.8 }
services:
  appserver:
    type: "php:{{ recipe.php }}"
    webroot: "{{ recipe.webroot }}"
```

### Why not tags

§7.3 removes YAML tags in v4.0. Provenance therefore MUST remain schema-visible file data plus ordinary §7.3.1 expressions; `emitLandofileYaml` stays tag-free. This avoids hidden parser state while preserving a user-editable opt-out at each value site.

## 4. Diagnostics and drop policy

`ConfigTranslateDiagnostic.kind` is the closed set below:

| Kind | Meaning |
|---|---|
| `generated` | The frontend inferred or generated a value not authored directly in its input. |
| `dropped` | An input path has no input-IR home or is intentionally omitted. |
| `rewritten` | Input semantics were represented in a different Landofile shape and should be visible in review. |
| `unsupported` | The selected input or a required format-level feature cannot be translated. |
| `non-portable` | The target encoder cannot represent a valid input-IR value. |
| `needs-review` | Translation succeeded, but user judgment is required before treating the result as settled. |

Every omitted input path MUST produce a `dropped` diagnostic containing its source path and remediation when one exists. `dropped` is never silent. A translator MUST NOT retain an unmodeled residual bag for later runtime interpretation.

Diagnostics from identical input and options MUST be byte-stable. Frontend diagnostics precede backend diagnostics in a translation result.

The three verbs surface diagnostics as follows:

| Verb | Diagnostic behavior |
|---|---|
| `start` | Does not invoke a translator and therefore prints no `ConfigTranslateDiagnostic` values. Ordinary loader, validation, and planner diagnostics continue through the normal renderer. |
| `init` | Prints recipe-translation and `lando4`-encoding diagnostics before the final init summary; machine output contains the same ordered array. |
| `translate` | Prints all frontend and target-encoder diagnostics beside the preview and again in the write report; `--format json` carries the same ordered array. Preview and `--write` MUST report identical diagnostics for identical input. |

An `unsupported` failure prevents encoding or writing. `non-portable` diagnostics prevent a target write unless that target's documented policy can preserve the value without semantic loss. No diagnostic may be suppressed merely because `--write` was requested.

## 5. `app:config:explain`

`app:config:explain` is a read-only provenance report. For every entry in `recipe.options`, it MUST report:

- the option name and current value;
- the recipe default at `recipe.version`;
- computed heuristic status `accepted-by-value` or `chosen-by-value`;
- every current Landofile site containing `{{ recipe.<option> }}`; and
- every decomposed site whose current literal no longer contains the complete generated expression, labeled `taken over`, whether equal or unequal.

Composite expressions are managed only while the complete parsed expression tree equals the generated expression tree from the matched snapshot. Keeping the same option references while changing an operator or constant is a takeover, not proof of management. Replacing any composite expression with a literal takes over that site. The command renders only matched declarative snapshots for comparison. It validates exact producer agreement and validates that `recipe.services` is injective and maps known generated services before matching service paths. It MUST NOT rewrite the file, execute app code, execute `.lando.ts`, follow includes, build an `AppPlan`, or contact a provider. If matched producer snapshots are unavailable, it fails closed without editing and reports only the bounded facts it can prove from current authoring data: recorded producer identity/version, current option values, and current expression references. Default output goes through the active renderer; `--format json` returns the same redacted facts through a schema-backed result.

## 6. Migrations

`RecipeManifest` gains declarative, schema-backed migration data. Serialized manifests contain no callable `apply`:

```text
migrations: [{ from, to, fromSnapshot, toSnapshot, hunks }]
snapshot: { identity, optionTypes, defaults, template, assets }
```

`from` and `to` are exact versioned producer identities. `fromSnapshot` and `toSnapshot` are parameterizable inert schema data, not one static old fragment. Each snapshot carries the full producer identity, option types, defaults, a declarative template, and asset metadata. The migration renderer evaluates both snapshots with the current persistable option values, then derives old/new authoring fragments and validates declared hunks against that diff. A missing or identity-mismatched old snapshot means no mutation.

Snapshot templates use the repository's existing expression parser grammar: literals, arrays, objects, paths/property/index access, grouping, calls, `||`, `&&`, equality/comparison, unary `!`, and conditional `?:`. The exact pure helper allowlist is `default`, `required`, `eq`, `ne`, `lt`, `gt`, `le`, `ge`, `and`, `or`, `not`, `contains`, `startsWith`, `endsWith`, `lower`, `upper`, `trim`, `split`, `join`, `replace`, `regexMatch`, `length`, `slice`, `keys`, `values`, `entries`, `get`, `merge`, `range`, `map`, `filter`, `json`, `fromJson`, `b64encode`, `b64decode`, `shellQuote`, `shellJoin`, `path.join`, `path.dirname`, `path.basename`, `path.extname`, `path.relative`, `path.resolve`, `url.build`, `url.parse`, `semver.satisfies`, and `semver.compare`. Snapshot validation rejects `load`, `import`, `text`, `bytes`, `hash`, `which`, `glob`, every `fs.*` helper, unsupported YAML/TOML/JSON5/JSONC/JSONL decoder, remote access, commands, arbitrary JavaScript, and any helper not in that allowlist.

A snapshot `template` is one serialized expression AST whose only data scope is `options`; evaluating it produces an authoring fragment. Quoted authoring strings such as `{{ recipe.php }}` in the result are data, not recursively evaluated snapshot expressions. Template evaluation has fixed step, output-size, collection-size, and depth budgets; pure path helpers use explicit POSIX roots and never consult process cwd or host environment. Option schema/default data uses the serializable Effect Schema descriptor subset owned by US-609B, not serialized JavaScript closures. Unsupported refinements make a recipe nonmigratable rather than execute code.

Every bundled recipe MUST publish safely renderable declarative current snapshot data even if normal init is implemented by TypeScript today. Snapshot rendering never executes arbitrary `recipe.ts`; local programmatic recipes remain valid for normal trusted init but are not explainable or migratable unless they separately publish valid declarative snapshots. No workflow automatically looks up remote history, local app code, or an old package. Bare or older provenance without matching producer snapshot can report bounded current facts but cannot migrate.

`hunks` is an ordered declarative union of option-default, add, remove, rename, and replace operations with old/new values and target ownership. Serialized edges contain templates, schemas, and hunks only, never a callback or `apply`. A migration chain MUST be unique and advance monotonically to the selected producer identity; gaps, forks, overlaps, reverse edges, cycles, or content changes under one versioned identity fail before any write.

Each edge computes stable hunk ids from producer family, `from`, `to`, owning layer, operation kind, and canonical path. Analysis classifies every hunk as exactly one of `already-satisfied`, `selected`, `retained-option`, or `blocking`.

There are two hunk classes:

| Hunk | Target | Decision rule |
|---|---|---|
| Option-default change | `recipe.options.<option>` | A chosen or declined new default MAY retain the user's current option value as `retained-option` and still satisfy the edge. Updating a selected option default updates intact references even when another site is a taken-over literal; the literal remains unchanged. Source ownership prevents a lower-layer default edit from overwriting a higher-layer chosen option. |
| Structural add/remove/rename/replace | Explicit layer-owned paths in rendered old/new snapshots | Apply only when ownership and exact old presence/value match or exact after presence/value is already satisfied. An arbitrary equal literal is not managed evidence. A declined, conflicting, or dependency-blocked structural hunk makes the entire edge `blocking`. |

Each hunk MUST name its owning layer and carry enough old/new context to render a deterministic file diff and decide whether its target is untouched. Includes and `.lando.ts` are blocked opaque/read-only inputs: semantic comparison or hunks targeting them stop the edge with manual remediation. A taken-over literal is user-owned and MUST NOT be overwritten automatically. Lossy mutation never becomes an automatic fallback.

Service-map validation checks exact generated/current names, unknown or missing entries, cycles, and target collisions. A structural service rename updates `recipe.services` and every managed tooling, route, dependency, event, and expression reference in one edge or blocks that entire edge.

Only a contiguous prefix of fully satisfied edges commits. For a committed edge, every hunk is `already-satisfied`, `selected`, or `retained-option`; no `blocking` hunk exists. Provenance version and producer update exactly once after that edge's file edits. There is no durable per-hunk progress bag and no partial edge commit. A blocked edge blocks every later edge. A completed no-op repeat is byte-deterministic.

`app:config:migrate` behaves as follows:

1. Read object-form `recipe` provenance and resolve a target from the already injected declarative-snapshot registry in the same `sourceKind + packageName + recipeId` family. Bundled provenance targets the bundled producer; local provenance needs matching host-supplied snapshots. The CLI defaults to the bundled registry and never searches for or executes local recipe code to obtain history. Missing targets or cross-family selection fail closed. Resolve the chain between the exact recorded and target versioned identities.
2. Process edges in order against an in-memory prospective file set. Render the old snapshot with the current edge's options; apply selected new defaults or retained values to a prospective option map, then render the new snapshot with that map. Validate the resulting structural hunks before advancing the prospective state to the next edge. Compute all selected edits before writing. Default interactive mode asks once per selectable hunk.
3. `--yes` selects untouched option and structural hunks. Taken-over sites remain unchanged. Chosen options may be retained while the edge advances. Structural conflicts block the edge and all later edges.
4. `--dry-run` prints the complete ordered hunk set and writes nothing.
5. A real write uses the core multi-file transaction in §6.1 below and commits only the longest fully satisfied edge prefix. It writes the final version and producer once with the same transaction.
6. On success, print `run \`lando rebuild\`` and exit. The command MUST NOT plan or apply the app.

`lando update` remains the §17.6 binary self-update command. It MAY mention that an app has pending recipe migrations; it MUST NOT run `app:config:migrate` or edit a Landofile.

### 6.1 Core multi-file transaction

Conversion and migration share a private transaction module owned by `@lando/managed-file`. It uses `ManagedFileService`/`FileSystem` for every user-file operation and `StateStore` for journal persistence and canonical app-root locks. No command or translator bypasses those services. It resolves the canonical app-root identity, rejects source and destination symlinks, requires every app-file/stage/backup parent realpath to remain under that root, and uses `PathsService` only where the existing services require it. Journal files live under the existing state-store root and are the explicit exception to app-root containment.

For every existing regular input, the immutable backup name is `<file>.bak.<full-before-sha256>`. An existing backup is reusable only when it is a regular non-symlink file with the exact recorded digest and an owner-safe mode; any mismatch fails before mutation. A newly created target whose before-state is absent has no backup. Same-directory stages record exact byte digest and intended mode. Existing nonsecret outputs preserve their mode; newly created outputs use a restrictive default; any output classified secret is owner-only. Raw before bytes, backups, and journal data may contain user secrets and MUST NOT reach renderer events, diagnostics, telemetry, or transcripts. New raw secret prompt answers never enter the transaction.

The owner-only journal has states `prepared`, `committing`, `committed`, and `blocked`. Before target mutation, the coordinator creates or verifies every required immutable backup and stage, then durably fsyncs a `prepared` record containing the complete ordered before/after plan, path absence/presence, byte hashes, modes, backup identity/existence, stage identity/hash, and removals. Commit changes the state to `committing`, performs per-file renames with digest rechecks, then durably fsyncs `committed` before cleanup. Recovery determines applied renames from before/after digests, so a crash after rename but before an applied flag is recoverable. Recovery of `committed` performs cleanup only.

Preparation uses exclusive owner-only `<target>.lando-stage.<transaction-id>` files. A crash before `prepared` can leave stages but cannot have changed a target. A later transaction uses a new id, reuses only hash-verified immutable backups, and does not guess ownership or automatically delete unjournaled stages. Document their manual cleanup in §12.4; scoped cancellation removes the current process's own stages. Prepared-journal recovery removes only stages whose recorded identity and hash match.

Before recovering an incomplete transaction, the coordinator preflights every path and lock against recorded before or after state, including expected absence, symlink status, hashes, and stages. A conflict preserves all user files, sets the journal to `blocked`, and reports manual resolution. Recovery MUST NOT overwrite a detected concurrent edit during forward completion or rollback. Cooperative canonical-root locking plus immediate digest rechecks prevents cooperating writers from racing; this is not a compare-and-swap guarantee against malicious or noncooperative editors and is not filesystem-wide atomicity.

Normal native file loading and `start` use a thin transaction-guard service that checks the app-root journal before reading a possibly partial set. It runs guarded recovery or refuses a `blocked` transaction without loading translators. Dry-run reports pending recovery but never acquires a write lock or mutates stages, journals, backups, targets, or deletions. The future core-spec amendment catalogs journal, stage, and backup lifecycle under §12.4. This uses existing package seams and adds no boundary scanner.

## 7. Core spec amendments this set makes

| Core section | Required change |
|---|---|
| §1.2, §1.3, §14.1 | Soften the v3 boundary to: core runs nothing v3; a bundled plugin may translate. |
| §4.2 | Rewrite the `ConfigTranslator` row as a two-way translation contract with optional `encode`; list bundled `lando4` and `recipe` translators while preserving the name and contribution surface. |
| §7.3 | Keep YAML tags removed and the canonical emitter tag-free. |
| §7.3.1 | Add `recipe.<option>` at level `minimal`, sourced only from merged `recipe.options`. |
| §7.3.1, §8.8.3, §8.8.8 | Remove any recipe wording that permits raw secret values in templates, argv, files, or provenance; require `secret-store` references or named init-only stdin/secret-env sinks with central redaction. |
| §7.4 | Remove `recipe:` from forbidden wrappers. Accept inert `recipe: { id, version, producer, options, services? }` with mandatory producer agreement and the existing bare string form. |
| §7.4.1 | Add `encode?` to `ConfigTranslator`; define set input, authoring schemas, fragment outputs, target policy, round-trip law, bundled translators, and diagnostic kinds `generated | dropped | rewritten | unsupported | non-portable | needs-review`. Reaffirm explicit-only invocation. |
| §7.8.1 | Make `emitLandofileYaml` expression-aware, permit the fixed leading provenance comment block, and define round trips over canonical authoring values rather than resolved runtime values. |
| §8.2.1 | Add `--to` to `app:config:translate` with default `lando4`; register `app:config:explain` and `app:config:migrate` with the flags defined here. |
| §8.8 | Replace recipe `render` with `decompose`; add the §2 rules, mandatory producer provenance, `migrations:`, and the wording “inert at runtime; migratable by file edit.” |
| §8.8.3 | Extend the `recipe.yml` schema with declarative ordered migration edges carrying inert historical evidence and schema-backed hunks; serialized manifests contain no callable. |
| §9.5 | Preserve `configTranslators:` and state that translators may decode and optionally encode but still run only on explicit requests, never bootstrap. |
| §12.4 | Catalog owner-only transaction journals, same-directory stages, immutable digest-named backups, recovery states, retention, and cleanup. |
| §13.1 | Extend `makeConfigTranslatorContractSuite` / `runConfigTranslatorContractSuite` with determinism, diagnostic stability, and the encode round-trip law on decomposed inputs. |
| `spec/README.md` | Add topic-lookup rows for the input-IR invariant, two-way config translation, recipe provenance and expressions, explain, and recipe migrations. |

## 8. Stories

The decision-complete order, gate class, and dependency list for US-607 through US-611B are canonical in [`prd-config-translation-00-index.md`](./prd-config-translation-00-index.md). The set contains 18 stories: the early transaction coordinator/recovery pair, codec and orchestration, private init integration, six implementation batches covering each of the exact 24 bundled recipe ids once, the single US-609E registry cutover and verification milestone, provenance explanation, and edge-based migration.
