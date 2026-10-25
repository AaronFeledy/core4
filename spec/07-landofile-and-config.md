# Lando v4: Landofile and Configuration

> **Part 7 of 20** · [Index](./README.md)
> **Read next:** [08 CLI and Tooling](./08-cli-and-tooling.md)

This part defines the user-facing Landofile, global configuration, composition, expression, translation, and schema-publication contracts.

---

## 7. Landofile and Configuration

### 7.1 Discovery

A Landofile-bearing directory contains any §7.2 merge file. Discovery walks upward from CWD to the first such directory, which becomes the app root, and stops at the filesystem root, `.lando.stop`, or the configured bounded depth. Discovery uses `FileSystem` and is cached per CWD for the CLI invocation.

`LandofileService` owns discovery, loading, decoding, and source provenance; consumers MUST NOT reproduce those rules.

After ordinary canonical parse or schema validation fails, the loader MAY perform a bounded raw-key legacy check. An unambiguous legacy canonical file raises `Lando3LandofileDetected` with remediation `lando4 app:config:translate --from lando3 --write`; an unambiguous legacy secondary layer beside a valid canonical file raises `LandofileDialectMixError` with remediation `lando4 app:config:translate --from lando3 --file <layer> --write`. Both are `Schema.TaggedError` values carrying app root, file, and applicable conflicting-layer context. Detection MUST NOT parse legacy YAML, load plugins, call `ConfigTranslator.detect`, plan, contact a provider, or read legacy state. Valid or ambiguous canonical-shaped content never triggers automatic detection (§7.4.1, §8.2.1).

#### 7.1.1 Landofile file forms

Each merge layer accepts exactly one form:

| Form | Basename | Contract |
|---|---|---|
| YAML | `.lando[.layer].yml` | Canonical declarative form; `lando init` emits it. |
| TypeScript | `.lando[.layer].ts` | Programmatic form loaded by embedded Bun and default-exporting a value validated by the canonical `Landofile` schema. |

Both forms at one layer fail with `LandofileFormConflictError`. Layers MAY mix forms. Overlays are authored input and need not be complete runtime Landofiles; the loader decodes once, after composition, merged expression materialization, and tooling assembly.

`defineLandofile` is an identity typing helper accepting expression-bearing, partial, directive-capable authored layers. `override(value)` and `reset()` are exported by `@lando/sdk/landofile`, `@lando/sdk/schema`, `@lando/sdk`, and the corresponding core re-exports; they have the same semantics as native YAML `!override` and `!reset`. Preparation validates directive placement without decoding field forms; composition consumes directives, and effective Landofiles contain none. A TypeScript default export MUST be a `LandofileOverlayInput`, or a function from `LandofileContext` returning that value, its Promise, or its Effect. SDK authoring helpers MAY decode individual fragments for authoring and lint, never as part of normal runtime loading. `LandofileContext` exposes `cwd`, `env`, host facts, layer, merge accumulator, and deferred `secrets`; `secrets.read` accepts the §7.3.1 reference grammar, resolves through the routed `SecretStore`, and preserves §3.7 redaction.

TypeScript modules MUST be pure at top level. Top-level I/O, await, or terminal output fails with `LandofileTopLevelSideEffectError`; function evaluation is bounded. YAML `${VAR}` substitution is not applied to TypeScript output, but emitted `{{ … }}` expressions resolve normally. `includes:` works in either direction. `lando app config edit` MUST refuse TypeScript Landofiles, while resolved views work for both forms. Recipes MUST emit YAML.

Decoded dynamic forms use the `app-plan` cache (§12.1). File inputs trigger re-decode; environment, host, secret, and render inputs do not. Full planning commands re-decode them, while cache-only routing exposes the last full decode. Deterministic provenance and cache-only freshness for non-file inputs and transitive imports are deferred.

### 7.2 Merge order

Layers load at low-to-high precedence:

| Order | Layer | Status |
|---|---|---|
| 1 | `.lando.base.{yml,ts}` | advanced |
| 2 | `.lando.dist.{yml,ts}` | first-class |
| 3 | `.lando.upstream.{yml,ts}` | advanced |
| 4 | `.lando.{yml,ts}` | canonical, first-class |
| 5 | `.lando.local.{yml,ts}` | first-class |
| 6 | `.lando.user.{yml,ts}` | advanced |

Before layer 1, the loader injects the generated translation prelude: the recorded `output` of each effective `translate:` entry (§7.4.2). Effective entries are resolved from the six authored layers only after their own merge; generated outputs never contribute `translate:` declarations, so the prelude is not recursive. The loader reads only the recorded declared output paths, never a directory glob, in deterministic ascending entry-id order, and merges them as ordinary fragments beneath layer 1 so every authored layer overrides them. Ordinary loading never runs a translator or touches the network to produce the prelude; a missing output follows the §7.4.2 inspection-versus-mutation rules.

Later layers override earlier layers. Maps deep-merge and scalar values use the higher-precedence value. Every modeled array whose items admit object values declares an unambiguous layer merge rule in its schema, covering its encoded and decoded forms: replace wholesale or merge by its declared identity. Scalar-only arrays replace without a declaration. A declared rule applies in every authored spelling, including string routes and dependency maps; if either side of a keyed collection holds an entry with no usable identity, the higher-precedence collection replaces it. An explicitly empty array clears inherited entries. Routes merge by scheme, case-insensitive hostname, and path prefix in either spelling; omitted scheme means HTTPS, omitted path prefix means `/`, and `both` participates in both scheme identities. Dependencies merge by service, logs by id, and route filters by name or otherwise type; named filters never match unnamed filters, and a type-changing filter replaces the matched entry. Endpoints and ports merge by name only when every entry on both sides is named. Other arrays, including tooling `cmds` and event step lists, replace. Opaque extension arrays replace. At a mapping member, `!override` replaces the entire inherited value with its validated payload, bypassing map and collection merge rules; `!reset` removes the member. Reset accepts an ignored scalar or empty payload, including empty collections, and removing an absent member is a no-op. Directives are consumed recursively, including in newly added subtrees and the lowest layer. Directives are not supported at document roots, directly on sequence items, or on keyed-list identity fields; deleting an individual keyed-list entry requires overriding its collection. Placements that cannot survive layer decoding fail with remediation to operate on the containing value. The highest-precedence `name` wins. Custom basenames and pre/post lists belong to global config.

Directive paths may traverse sequence entries only in schema-declared keyed collections, excluding identity fields. Dependency-map decoding and security CA alias paths reject directives with containing-value remediation; CA directives use canonical `ca`.

Composition merges authored values before shorthand interpretation or load-owned expression materialization. The three service aliases `working_dir`, `env_file`, and `depends_on` canonicalize before merge; canonical spelling wins within one source, while a higher layer's alias overrides a lower canonical spelling. Other spelling conflicts remain subject to strict effective validation. Maps merge; list/scalar/form changes replace. Defaults, including log stream, port protocol, and build context, apply late. Collection identities compare authored values; expression sites match as literal text, and hostnames containing them retain their authored case. There is no second identity merge after materialization. An untouched route retains its authored scheme spelling. A matched `both` entry expands into its atomic scheme parts, including any unmatched part; an unmatched overlay `both` entry appends as authored, while a partially matched overlay appends only its unmatched part.

`.lando.recipe.yml` is not a canonical layer; recipes are init-time scaffolds (§8.8). Explicit Lando 3 translation supplies all seven legacy layers as one ordered set, folds recipe between dist and upstream, preserves source layers where the canonical merge algebra permits, and MUST preserve final effective configuration over the representable subset. Translation expresses mapping-member removals with native `!reset` and collection transitions not representable by ordinary merging with native `!override`, preserving effective configuration after every representable prefix. Unrepresentable native directive placements use a valid containing-value replacement; remaining unsupported semantics produce diagnostics. There is no translator-only compatibility delete value.

Each file resolves its includes before entering six-layer precedence. Resolution retains recursively ordered fragment and inline overlays until the effective fold so intermediate materialization cannot erase reset or override intent (§7.7).

Load-owned expressions (`recipe.*`, `env.*`) resolve against the merged recipe options and one captured load environment before the single strict effective decode. Whole-value results retain their type and replace the expression slot, with no retroactive merge or app-fragment discovery pass. Generated values and failures inherit the expression site's origin. An unresolved load-owned expression fails with `LandofileValidationError` naming the authoring file and value path. A site that also references a planner-owned scope stays deferred whole (§7.3.1).

Results of load-owned evaluation, including recipe/env expressions and `load()`/`import()` data, are data. A produced string is stored verbatim: no delimiter escaping, no rescanning, and no later pass inspects it for expression syntax or secret-reference spelling. FileRef and ImportRef metadata and ImportRef contents remain opaque. Authored escapes (`$${`, `{{{{`) are decoded exactly once, when the authored site is parsed. Later passes visit only the pending sites the compilation carrier still records (§7.2.1); runtime consumers MUST NOT apply an escape decoder to environment values or secret-store results.

#### 7.2.1 Compilation carrier

Loading and planning exchange one schema-owned carrier (`CompiledLandofile`): the document, its stage, the surviving `pendingSites`, and an ephemeral `context` holding the canonical app root and one captured host environment. Each pending site records a stable id, its canonical destination path in the current document, source attribution including the original list index, and the parsed `ExpressionTemplate`. Stages advance `source` → `composed` → `load-scoped` → `identity-scoped` → `service-scoped` → executable plan; `discover` returns the load-scoped carrier and `AppPlanner` consumes it. Authored sites are parsed once at the source stage and carried through include resolution, keyed-array merges, aliases, overrides, resets, and list-form environments by identity, not by string equality. Consuming a site replaces its value and removes the site. Environment-list duplicates keep last-wins semantics and original index attribution. Recipe snapshot literal nodes that carry expressions compile before option evaluation and propagate their surviving sites; option- and helper-produced strings are data. The carrier never enters applied state or caches.

Lint validates individual authored layers as well as the effective root composition; a lower invalid value shadowed by a valid higher value does not by itself invalidate runtime loading.

### 7.3 Loading external file content

The pure expression helpers `load(path)` and `import(path)` accept local paths only. `load` returns a `FileRef`; `import` returns an `ImportRef<T>` preserving provenance. Remote value retrieval is a non-goal; remote fragments use §7.7.

`FileRef` exposes resolved `path`, `size`, `mime`, `checksum`, and `encoding`. Decoders are `text`, `json`, `yaml`, `fromToml`, and `bytes`; extension inference applies to JSON, YAML, and TOML, otherwise text. The optional decoder argument and pipe form are equivalent. Unknown decoders fail with `ConfigExpressionError`.

Structured values support `get(value, path, default?)`, which returns the default or `null` for missing segments, and direct dotted/bracket access, which fails with `ConfigExpressionError`. `ImportRef<T>` exposes `value`, authored `path`, `basename`, `checksum`, and source `layer`. Only schema positions annotated `acceptsImportRef: true` accept it; misuse fails with `LandofileImportRefMisuseError`.

Paths resolve from the containing Landofile or fragment, recipe, or mount-template directory. They MUST remain under the app root after traversal and symlink resolution. Absolute or escaping paths fail with `LandofileLoadOutsideRootError`; explicit global relaxation is logged on every use. Reads are eager, bounded, and included by content identity in the `app-plan` cache key; limit violations fail with `LandofileLoadLimitError`.

The canonical loader and emitter support native `!override` and `!reset` merge directives; other YAML tags remain unsupported. Source-preserving legacy parsing exists only for explicit translation, is bounded, rejects duplicate keys, and MUST NOT weaken or become reachable from normal canonical loading.

### 7.3.1 Configuration expressions

The pure expression language supports `{{ expr }}` interpolation, dotted and bracket paths, equivalent pipe filters and positional calls, whitespace trimming, comments, whole-file `if`/`else` and `for` blocks, and shell forms `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:?message}`, `${VAR:+alt}`, and unambiguous `$VAR`. `{{{{` and `$${` escape literal openers. The grammar accepts every form above, but Landofile loading currently evaluates only a subset of it; see the shipped-versus-deferred paragraph below. Whole-expression strings preserve scalar or structured result type; interpolation mixed with text always yields text. Whole-file rendering always yields text. The one exception is a Landofile value site that references planner-owned `app`, `proxy`, or `services` data: it stays deferred whole, including any load-owned references in the same site, is valid only where the schema accepts text, and MUST evaluate to text. Loading reports such a site at a non-text field with a suggestion to use a literal or a load-owned expression; a non-text result fails during planning with `ConfigExpressionError`.

Built-in helpers are:

| Family | Names |
|---|---|
| Logical/comparison | `default`, `required`, `eq`, `ne`, `lt`, `gt`, `and`, `or`, `not`, `contains`, `startsWith`, `endsWith` |
| String | `lower`, `upper`, `trim`, `split`, `join`, `replace`, `regexMatch` |
| Collection | `length`, `slice`, `keys`, `values`, `entries`, `get`, `merge`, `range`, `map`, `filter` |
| Format | `json`, `fromJson`, `yaml`, `fromYaml`, `fromToml`, `b64encode`, `b64decode` |
| Conversion | `number`, `boolean` |
| File | `load`, `import`, `text`, `bytes`, `hash` |
| Shell | `shellQuote`, `shellJoin` |
| Process facts | `which`, `glob` |
| Namespaced | `path.join`, `path.dirname`, `path.basename`, `path.extname`, `path.relative`, `path.resolve`; `fs.exists`, `fs.isFile`, `fs.isDir`, `fs.size`; `url.build`, `url.parse`; `semver.satisfies`, `semver.compare` |

Shipped support versus deferred host-shell substitution. `$${` and `{{{{` are supported literal escapes at text-valued Landofile sites. The YAML parser preserves scalar text, including unquoted `${VAR}` (§7.8.1); the parsed load walk decides expression permission with the actual value path. Escapes decode exactly once, when the authored site is parsed into the compilation carrier (§7.2.1); composition, validation, and `app:config` resolved-authoring output then carry the literal text. Evaluating host-shell forms (`${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:?message}`, `${VAR:+alt}`) against the captured load environment remains deferred and MUST NOT be presented as shipped. An unescaped host-shell form, other than an exact secret reference at an authorized binding site (below), fails with `LandofileValidationError` naming its authoring file and value path. Remediation names `$${...}` for literal shell text and `{{ env.* }}` for a host value. Escaping MUST NOT invoke host-environment or secret-store IO.

##### Environment values and secret bindings

`EnvironmentValue` is the one value model for service environments, tooling environments, and credential password fields: a literal string, a `SecretRef` (`_tag: "SecretRef"`, validated raw store `reference`), or flat `BoundText` (`_tag: "BoundText"`, ordered parts that are literal strings or `{ reference, encoding: "raw" | "uri-component" }`). Normalization merges adjacent literals, collapses all-literal `BoundText` to a string, and collapses a sole raw reference to `SecretRef`; the existing expression output budgets apply. A `SecretRef` or `BoundText` is a descriptor and contains no decrypted bytes.

Only recognized authored binding sites create bindings: `${secret:<reference>}` in a service `environment` entry, a database `creds.password` or `creds.rootPassword`, a Redis `password`, or a tooling `env` entry. A sole reference becomes `SecretRef`; surrounding authored text or multiple references become normalized `BoundText` with raw reference parts. Deliberate typed projections by trusted service types and features (§6.12.4) preserve bindings they received. Nothing else has authority: raw authoring objects carrying a reserved `SecretRef`/`BoundText` tag, loaded or imported data, recipe options, helper results, `env_file:` values, `appEnv` defaults, and ordinary produced text are data and fail or stay literal at their source site without a SecretStore call. Produced text is never escaped or rescanned.

Bindings follow ordinary deterministic environment precedence. A higher authored layer, a feature, or a plugin that writes a key replaces that entire value regardless of its variant; there is no final reference-restoration overlay and no secret-specific priority. Keys owned by a database type are governed by connection-fact agreement (§6.12.4), not by overwrite.

Expression evaluation over a binding supports whole-value copy, concatenation, and explicit `url.encodeComponent()`, which is RFC 3986 UTF-8 component encoding and is never inferred from context. Any other helper consuming a binding fails with a located `ConfigExpressionError`. Interpolating a binding into text yields `BoundText`.

Runtime resolution reads descriptors only (§5.5.2); it MUST NOT infer authority from strings, decode their contents, or mutate the reusable plan. Plan-cache, build, and container-create identities hash descriptors, never resolved bytes, so identical environment bytes with different lookup authority cannot share an identity. Resolved values never enter those identities or persisted plans.

Known namespaces MUST be called; other dotted forms are value access. `path.*` is distinct from the `paths.*` scope. Plugins MAY add non-colliding namespaces and pure helpers through §9.5. `pathJoin`, `pathDirname`, and `pathBasename` are deprecated aliases and emit `DeprecationNotice`; removal follows the metadata and compatibility policy in §18.

Helpers are synchronous, pure, deterministic, redaction-safe, non-networked, and non-mutating, except captured `load`/`import` reads. They use flat names unless a domain has multiple operations, fixed format values for polymorphic conversion, and a trailing options object for multiple optional controls. Standard return shapes are preserved. Converters return `null` for uninterpretable input, parsers throw `ConfigExpressionError`, predicates return `false`, and misconfiguration throws. `number(value)` accepts finite numbers and trimmed signed decimal or exponent strings whose conversion is finite. `boolean(value)` accepts booleans, numeric `1`/`0`, and trimmed case-insensitive `true`, `yes`, `on`, `1`, `false`, `no`, `off`, and `0`. Other resolved inputs return `null`; missing arguments, unresolved values, and invalid arity fail evaluation. Both support call and pipe forms, have static result kinds number and boolean, and exist so environment text can fill typed fields while `null` lets the field's validation report the bad value. Contributed helpers MUST satisfy the SDK contract suite (§13.1).

Expressions parse to an AST and record their minimum bootstrap level:

| Level | Scopes |
|---|---|
| `none` | `host.*`, `env.*`, `paths.*` |
| `minimal` | `app.*`, safe `global.*`, `recipe.*`, loader helpers |
| origin-dependent | `vars.*` |
| `plugins` | self `service.{name,type,primary,creds.*}`, `plugin.<id>.{root,config,version}` |
| `app` | `proxy.defaultDomain`; self routes/endpoints; `services.<name>.*`; permitted `globalServices.<name>.*` (§20.8.3) |
| `provider` | `info.*` |
| invocation-specific | tooling `task`, `flags`, `args`, `raw`, `sources`, `generates`, `checksum`, `timestamp`; event `event`; recipe-init `answers`, `recipe`, `destination`, `flags`, `cwd` |

`ConfigService.resolve` resolves at the consumer's current level or returns opaque `DeferredExpression`; consumers MUST NOT escalate bootstrap level. For shared configuration validation only, a consumer at `plugins` MAY evaluate `app.{name,slug}`, `proxy.defaultDomain`, and `services.<name>.creds.*` through the provider-independent resolve pass (§7.8), without escalating bootstrap or building an `AppPlan`; this does not change load-time deferral (§7.2) or expose finalized routes, endpoints, global-service data, or `info.*`. Cross-service cycles, forbidden global-service access, unknown paths, type mismatch, and invalid indexing fail with `ConfigExpressionError` or `ConfigExpressionScopeNotPermittedError` at the consuming level.

Expressions and templates MUST NOT execute shell commands, perform network I/O, or mutate state. `${secret:<reference>}` resolves through the routed `SecretStore` (§4.3, §9.5.1). A bare id matching `^[A-Za-z0-9_.-]+$` (`${secret:DB_PASS}`) routes to `defaultSecretStore`, default `env`. A scheme reference `<scheme>://seg/seg[/seg[/seg]]` (`${secret:op://Vault/Item/field}`) routes to the store owning `<scheme>`; the scheme matches `^[a-z][a-z0-9-]*$`, each of the two to four segments matches `[A-Za-z0-9 _.-]+` (spaces allowed), and an optional `?attribute=<value>` or `?ssh-format=openssh` suffix passes through to the store. Leading or trailing whitespace, empty segments, `..`, control characters, `}`, an unknown scheme, or an unknown default store fail with `SecretReferenceInvalidError`; store failures surface as `SecretNotFoundError` or `SecretStoreUnavailableError` (§9.5.1). Resolved values MUST be registered with the canonical redactor before any event, result, or transcript can carry them, MUST be redacted, and MUST NOT enter caches decrypted. Provider apply receives an operation-scoped resolver callback that returns the complete concrete service environment only for actual creation or recreation. Plan descriptors remain unchanged; there is no separate secret override map or final reference-restoration pass. Recipe secret answers MUST resolve to a secret-store reference or exactly one init-only sink, `postInit.stdin` or `postInit.secretEnv.<name>`, and raw bytes MUST NOT enter templates, argv, files, provenance, diagnostics, journals, transcripts, renderer events, or telemetry (§3.7, §8.8).

- The runtime provider registry MUST register plan tokens, provider environment read-back of exact-secret keys from the union of desired and applied plans plus host-proxy credentials for eligible services, and trusted owner-only worker-record credentials before any output-producing provider member runs. Registration failures MUST fail closed with typed `ProviderError` before output. Host-only tooling and provider-free inspection MUST NOT initialize a provider for redaction. Read-back MUST NOT resolve secret-store references or persist decrypted values; removed containers' historical secrets are not recoverable. Each member call lists current app containers; inspections MAY be cached by immutable container Id, pruning removed Ids after each list.
- `op://` MUST mean 1Password only. Durable `${secret:lando://<namespace>/<id>}` MUST use the injective plugin namespace encoding in §9.5.1 and exactly two grammar-safe segments, without query suffixes.
- `${secret:lando-session://<session>/<id>}` MUST resolve only in its owning live scope, never across sessions or after closure. These references MUST NOT persist in a Landofile, plan cache, or future-start configuration; they are operation context, not a global plugin store.

### 7.3.2 Template engines

`TemplateEngine` is pluggable through `templateEngines:` (§4.2, §9.5). `TemplateEngineRegistry` selects engines and `TemplateRenderer` performs staged rendering (§3.4). The engine contract names `TemplateCompileInput`, `CompiledTemplate`, `TemplateRenderContext`, `TemplateCompileError`, `TemplateRenderError`, and capabilities `wholeFile`, `stringInterpolation`, `partials`, and `unsafe`. Unsafe engines are disabled by default and require explicit global opt-in.

| Engine id | Contract |
|---|---|
| `lando` | Built into core, mandatory default, supports whole-file control flow and Landofile string interpolation. |
| `handlebars` | Bundled whole-file engine with strict missing-key behavior, no HTML escaping, helpers, and site-supplied partials. |
| `mustache` | Bundled logic-less whole-file engine; helpers are not callable. |

Selection order is explicit site `engine`, extension match, Landofile `defaultTemplateEngine`, global `defaultTemplateEngine`, sole installed implementation, then `TemplateEngineUnresolvedError`. Only `lando` MAY render Landofile string interpolation and cannot be disabled; other engines apply only to whole-file sites.

Every engine receives schema-defined `TemplateRenderContext`, limited to scopes available at the site's bootstrap level. `vars` precedence is per-render `vars`, Landofile `templateVars`, then engine defaults. Compile and render results are content-addressed in the `template-compile` and `template-render` caches (§12.1).

### 7.4 Top-level Landofile keys

| Group | Keys |
|---|---|
| Identity/version | `name`, `runtime`, `lando`, `recipe`, `agentEnv` |
| Composition/defaults | `includes`, `defaultTemplateEngine`, `templateVars`, `env_file` |
| Runtime/provider | `provider`, `toolingEngine`, `providers` |
| App behavior | `services`, `tooling`, `toolingDefaults`, `toolingIncludes`, `commandAliases`, `events`, `proxy`, `router`, `checks` (§10.5.2), `sshAgent`, `gpgAgent` |
| Remote sync | `remotes`, `sync` (§10.12 authored orchestration contract; bundled implementations are sequenced in the ROADMAP) |
| Translation sources | `translate` (§7.4.2) |
| Plugins | `plugins`, `pluginDirs` |
| Compose subset | `volumes`, `networks`, `configs`, `secrets`, `include`, `x-*` |

`name` defaults to the app-root basename. `slug` deterministically normalizes it for paths, URLs, and provider labels; an empty normalized value uses a stable root hash. `<app-id>` is the slug. Collisions fail with `AppIdCollisionError` and MUST NOT auto-suffix. `global` is reserved and fails with `AppIdReservedError`; scratch apps occupy a separate `AppRef.kind` namespace (§20.2, §21.2). Identity rules are published as schema metadata.

Compose compatibility is a service-key vocabulary, not a whole-project format promise. Supported top-level and service keys have exactly one committed disposition: `normalized`, `preserved`, or `rejected`. Preserved non-`x-*` fields require provider capability and MUST NOT be silently dropped; `x-*` is inert. The vendored tagged Compose schema and coverage gate require every upstream key path to be classified.

`extends`, `container_name`, `network_mode`, `links`, and Swarm deployment machinery are rejected with remediation; `!reset` and `!override` are normalized by native Landofile layer merging (§7.2). Native anchors, aliases, and merge keys resolve within each file before schema decode and layer merge; invalid reference graphs fail with source-located `LandofileParseError`. Obsolete top-level `version` is accepted, ignored, and emits `DeprecationNotice` (§18). Lando-specific keys win over equivalent Compose shorthand. Compose `include` normalizes to appended `includes` entries with `kind: compose`; the fragment remains subject to the same disposition matrix.

The optional `lando` semver range is validated after merge and before planning. Constraints from every layer accumulate and include prereleases. Failure raises `LandofileVersionConstraintError` with ranges, layers, running version, and remediation. `LANDO_SKIP_VERSION_CONSTRAINT=1` MAY downgrade it to a warning for one invocation; doctor reports unsatisfied or skipped constraints. `lando` constrains core, `runtime` constrains the Landofile format, and service `api` constrains each service. `runtime: 4` requires `api: 4`; mismatch fails with `LandofileVersionMismatchError`. Future mixed versions are out of scope.

The top-level wrappers `compose:` and `recipes:` are forbidden and fail with `LandofileForbiddenWrapperError`; Compose keys are direct, and recipe provenance uses singular `recipe`. Bare `recipe: <id>` remains valid and inert. The object form carries `id`, `version`, `producer`, `options`, and optional injective service-name mapping; producer identity and canonical content digest MUST agree with the declaration. Local and bundled source identities MUST NOT collide. The declaration MUST NOT trigger expansion, plugin loading, or runtime lookup. `init` and decomposing frontends MUST emit the object form.

### 7.4.1 Config translation

`ConfigTranslator` remains authoring-fragment-only. Configuration-backed scratch uses the explicit input path in §21.4.3, not translation refresh; programmable execution adds no mandatory Landofile key (§22.9).

Translation is explicit conversion through `LandofileAuthoringShape` and recursively partial `LandofileAuthoringFragment`. `LandofileShape` is runtime input and `AppPlan` is provider-neutral output; frontends MUST NOT emit `AppPlan`, and text backends MUST NOT encode runtime or plan shapes. These public Effect Schemas share canonical field definitions and inferred types.

Only `app:config:translate`, `app:config:explain`, `app:config:migrate`, `apps:init`, and the §7.4.2 refresh phase invoke translators (§8.2.1, §8.8). Translators MUST NOT run during discovery, normal loading, or tooling; the refresh phase is the single bounded lifecycle entry and applies only to declared `translate:` entries. Core owns bounded reads, ordering, containment, cumulative-prefix and final validation, encoding, and mutation. Frontends own foreign parsing and merge semantics, folding, diagnostics, and output ownership, but MUST NOT read or write files, follow references, plan, contact providers, install plugins, or mutate the app.

`ConfigTranslateInput` is tagged `landofile-document-set` or `recipe-request`. The former carries the ordered bounded source snapshots, source/layer identities, digests, media types, selection mode, lower-layer canonical context, and writable layers; the latter carries recipe identity, synthetic source id, and decoded nonsecret answers or approved secret references. Raw secrets and deletion intents are forbidden in recipe requests.

`ConfigTranslateResult` contains ordered unique-target authoring fragments, source ids, diagnostics, and deletion intents. Core MUST validate all targets and deletions. `ConfigTranslateDetectInput` contains snapshots and metadata only. `ConfigTranslateEncodeInput` carries an authoring wire tree and validated complete context; encoders emit only the selected fragment. `ConfigTranslateDiagnostic` carries source id, key path, optional source span, kind, message, and remediation.

`ConfigTranslator` names `id`, `summary`, `inputKinds`, `detect`, `translate`, and optional `encode`, returning `Effect` with `ConfigTranslateError` and `never` requirements. `ConfigTranslatorRegistry` is the Effect service selecting these contracts. Factories close over explicit SDK ports such as `RecipeDecomposer`; they MUST NOT import core or request dynamic services. The bundled translators are `lando4` (decode/encode), `recipe` (decode through `RecipeDecomposer`), and decode-only `lando3`. Translation registration is lazy at bootstrap level `plugins`; duplicate ids fail as a tagged producer collision with no precedence winner (§9.5).

Encoder round-trip law: `decodeAuthoring_T(T.encode(v).text)` MUST equal `canonicalAuthoring_T(v)`, including expression AST and expected types, but excluding formatting and the fixed provenance comment.

The six diagnostic kinds are `generated`, `dropped`, `rewritten`, `unsupported`, `non-portable`, and `needs-review`. Every omitted input path MUST produce `dropped`; diagnostics are deterministic and ordered, and preview and write report the same array. `unsupported` blocks encoding and writing. `non-portable` blocks target writes unless the target preserves semantics. There is no residual runtime interpretation bag.

Preview is default. `--to lando4 --write` writes only declared canonical YAML targets through the managed-file transaction (§12.4) and invalidates affected caches. Other encoders MAY preview but MUST fail closed on write until a safe target mapping exists. Core MUST NOT guess filenames or overwrite foreign text. TypeScript and includes remain opaque and MUST NOT execute. Dynamic or remote references produce `needs-review`; translators MUST NOT fetch or inspect them.

### 7.4.2 Translation sources and refresh

An app authored in a foreign configuration (a `pantheon.yml`, an Upsun `.upsun/` tree) keeps a generated Landofile fragment in step with it through a top-level `translate:` map:

```yaml
translate:
  upsun:
    translator: upsun
    inputs: [.upsun, .environment]
    output: .lando/translated/upsun.lando.yml
    refresh: auto
```

- `translator` names an installed `ConfigTranslator` whose contribution declares `refreshable: true`. `recipe` and `lando3` are never refreshable. `inputs` are app-root-contained files or directories read under the §7.3 bounds; `output` defaults to `.lando/translated/<id>.lando.yml` and MUST be an app-root-contained canonical YAML target; `refresh` is `auto` (default) or `manual`; optional `options` pass to the translator unchanged.
- Optional `remote: <name>` selects nonsecret metadata (runtime generation, service versions, add-ons) from the resolved remote/environment/branch identity. `RemoteSource.metadata(cfg, env, branch?)` MUST return a schema-validated nonsecret snapshot with identity and revision/digest; it MUST NOT return credentials, live endpoints, or arbitrary environment values. A source without that method MUST reject metadata-dependent translation.
- Automatic refresh on start, restart, rebuild, or cache refresh MUST use local input snapshots and previously stored metadata only. It MUST NOT probe an API, renew metadata by TTL, or attempt network then fall back. Missing required metadata MUST block mutation with `ConfigRefreshError` reason `metadata-missing` and explicit refresh remediation.
- Explicit `app:config:translate --refresh`, the initial code-sync refresh for `app:pull --code` or `app:remote:switch`, and §8.8.13 init materialization of newly emitted entries MAY fetch metadata through the source method and bounded `runProbe`. An attempted fetch failure MUST fail with reason `metadata-fetch`; it MUST NOT return stale success. Offline explicit refresh MUST fail if it requires remote metadata rather than silently skip fetching.
- Metadata MUST be keyed by source/config identity, resolved remote, environment, and branch (including absent branch), with a schema version. Switch MUST resolve the new identity and MUST NOT reuse another environment's snapshot. Explicit refresh MUST report its identity and metadata revision before materialization.
- The output is an ordinary §7.7 Landofile fragment injected through the §7.2 generated prelude beneath all authored layers and read by its recorded path. Once committed, it follows ordinary include resolution, load-owned materialization, strict layer decoding, and §7.8 validation. Refresh MUST NOT inject translator-returned authoring objects into the loader or bypass canonical serialization and validation. Side-effect-free precommit previews MAY validate canonically serialized candidate bytes against bounded source snapshots; ordinary loading still reads committed declared outputs. Translator-produced literal text follows the §7.2 escaping rule; only deliberately emitted expression slots remain expressions. The managed owner is `translate:<id>` (§10.13), provenance records the input fingerprint, and user edits MUST conflict rather than be overwritten silently.
- The fingerprint MUST cover every input path/byte (including directory additions/deletions), metadata identity/revision/content digest, translator id/version/options, encoder version, and consumed lower-layer canonical context; generated outputs MUST be excluded. An unchanged fingerprint MUST skip translation, not an explicitly requested metadata fetch. The app-plan cache MUST include the same fingerprint and output digest (§12.1).
- Declaration loading never expands. Discovery and §7.2 merge read the `translate:` block and the recorded output as plain data, tolerate a missing output, and never run a translator. Help, `app:info`, `app:config`, tooling, and the cold path never refresh.
- `refresh: auto` MUST run before plan-cache lookup: local snapshots, pure translation over a `landofile-document-set`, fragment validation, `lando4` encoding, managed-file transaction (§12.4.1), then reload. Start/restart/rebuild/cache refresh MUST complete this before lifecycle mutation. Pull-with-code and switch MUST follow the shared §10.12.1 sequence after their code phase, before hooks or data mutation, and report the completed code phase if refresh fails.
- Blocking `unsupported`/`non-portable` diagnostics, managed-file conflicts, or encoding failures MUST fail with `ConfigRefreshError` and remediation, never fall back to a stale fragment. Declaration loading MAY tolerate absent output for inspection, but mutating commands MUST refuse missing required output.
- `refresh: manual` MAY plan from an existing same-identity fragment while reporting local fingerprint drift through `config-source-drift` and lint. It MUST NOT reuse an old-environment fragment after switch; remediation is `lando app:config:translate --refresh <id>`.
- `app:config:translate --refresh [<id>]` MUST materialize the selected entry or all entries at `plugins` bootstrap. With `--check`, it MUST compare local snapshots and stored metadata only, report drift, and neither fetch nor write; `--check` MUST NOT be combined with `--write`. This inspection is not an explicit fetch and MUST NOT claim remote freshness.
- Translators keep §7.4.1 purity: core snapshots inputs and passes them; the translator MUST NOT read files, plan, contact providers, or install plugins. Unsupported foreign constructs keep producing blocking or `dropped` diagnostics; refresh never makes them disappear.

Events are `pre-config-refresh`, `post-config-refresh`, and `config-source-drift`. `ConfigRefreshError` reasons are `translate`, `encode`, `conflict`, `input`, `not-refreshable`, `metadata-missing`, `metadata-fetch`, and `metadata-identity`.

### 7.5 Global config

Global config is one ordered source stack: built-in defaults, `<userConfRoot>/config.yml`, `<userConfRoot>/config.d/*.yml` (lexical order, `.yml` only), §7.6 environment overrides, then the §16.5 host `config` option. Later layers win; maps deep-merge; arrays and scalars replace; `appEnv` and `appLabels` replace as whole maps. Root defaults are platform-conventional and resolved by `@lando/core/paths` and `PathsService`, never re-derived by consumers.

| Root | Purpose |
|---|---|
| `userConfRoot` | User-edited configuration |
| `userCacheRoot` | Disposable caches and logs |
| `userDataRoot` | Persistent Lando-managed data |
| `systemPluginRoot` | Read-only system plugin search root (§9.3) |

Per-root precedence is explicit runtime option or host `config`, root-specific environment variable, config files where applicable, then platform default. `userConfRoot` is fixed before reading global config and cannot relocate its own load; a `userConfRoot` key in `config.yml` or a drop-in is ignored. `systemPluginRoot` is never a `meta:plugin:add` destination.

The stack is read and decoded against `GlobalConfig` with `errors: "all"` exactly once per runtime build, while the `ConfigService` layer constructs; the result is an immutable snapshot for that runtime's lifetime, and `ConfigService.load`/`get` are infallible reads of it. Long-lived runtimes (MCP serve, embedding hosts, detached workers) keep their snapshot until rebuilt. A decode failure fails runtime construction with one `ConfigError` carrying the `config.yml` `path`, every problem as `issues` (`ValidationIssue`, §7.8), and a `remediation`. Each issue carries `source` provenance for the layer that supplied the effective value (§7.8) and a `suggestion` naming the exact fix for that layer: `lando config set`/`unset` for `config.yml`, `Edit <file>` for a drop-in, unset or correct the named variable for env, the host option for host. The message is `Invalid config file <path>: ...` when every issue is file-authored and `Invalid global configuration (<sources>): ...` otherwise, naming each failing source. Unparseable YAML in any file layer is a `ConfigError` without `issues` whose message is `Invalid YAML in config file <path>: <category> at line N, column M` for raw and resolved reads alike; it MUST NOT echo file contents. Issue messages state the expected shape and MUST NOT include input values; suggestions are complete sentences. An invalid `renderer` or `logLevel` from a config layer falls back to the default presentation and is still reported as an issue; only the `--renderer` flag and `LANDO_RENDERER`/`LANDO_LOG_LEVEL` fail before dispatch. `notify.commands` ids are validated by the global decoder against canonical and enabled-plugin command ids (closest-id suggestion), so `meta:config validate`, `meta:doctor`, and runtime build all report them. Unknown keys with a near match and control-character root paths are warnings with code `LANDO_MESSAGE_WARN`, published once per command in every output mode, not failures. Every command except the repair and maintenance set (`meta:config`, `meta:doctor`, `meta:uninstall`, `meta:version`, `meta:shellenv`) therefore fails at startup with that `ConfigError` unwrapped, never re-tagged as a bootstrap, provider, router, or Landofile error. `meta:doctor` handles it per §10.9.1.

| Group | Global keys |
|---|---|
| Files/roots | `envPrefix`, `landoFile`, `landoLockFile`, `preLandoFiles`, `postLandoFiles`, `userConfRoot`, `userCacheRoot`, `userDataRoot`, `systemPluginRoot` |
| Providers/apps | `defaultProviderId`, `providers`, `appEnv`, `appLabels`, `globalServices` |
| Plugins | `plugins`, `pluginDirs`, `disablePlugins`, `pluginConfig` |
| Network/router | `bindAddress`, `router`, `proxy.defaultDomain`, `network.proxy`, `network.ca`, `checks`, `healthcheck` |
| Experience | `logger`, `renderer`, `notify`, `toolingEngine`, `commandAliases`, `agentEnv`, `keys`, `maxKeyWarning`, `logLevelConsole` |
| Agents/secrets | `sshAgent`, `gpgAgent`, `defaultSecretStore` |
| Automation | `mcp`, `build`, `experimental`, `stats` |
| Landofile evaluation | discovery, include, load, and TypeScript-evaluation bounds; `defaultTemplateEngine`; unsafe-engine opt-in; outside-root relaxations |

Published nested keys include `router.{enabled,bindAddress,httpPort,httpsPort,httpFallbacks,httpsFallbacks}`, `proxy.defaultDomain`, `network.proxy.{http,https,noProxy,injectIntoServices}`, `network.ca.{trustHost,certs,injectIntoServices}`, `notify.{enabled,thresholdMs,commands}`, `commandAliases.{enabled,disabled,custom}`, `agentEnv.{enabled,allow,deny}`, `sshAgent.{sidecar,socket}`, `gpgAgent.{forward,socket}`, `mcp.{allow,deny,tooling,maxConcurrent}`, `checks.{retries,timeout}`, `healthcheck.{retry,delay}`, `build.{concurrency,failFast,transcripts}`, and `stats.report`. Evaluation-policy keys are `discovery.maxDepth`, `landofile.tsTimeoutMs`, `loadMaxFileBytes`, `loadMaxFilesPerExpression`, `loadMaxRecursionDepth`, `includeMaxDepth`, `allowLoadOutsideRoot`, `allowIncludeOutsideRoot`, and the unsafe-template-engine opt-in. Values are bounded and schema-validated; tuning defaults are not architecture contracts.

`notify` is currently the only key published through `PublishedGlobalConfigKey`/`configKey`; it decodes as `NotifyConfig` (§8.9.7). Its canonical-command allowlist is validated against the cwd-independent global registry, so global validity MUST NOT depend on app discovery.

`appEnv` and `appLabels` are bounded whole maps applying only to user apps. Service-authored values win per key. Core-owned `LANDO`/`LANDO_*` environment keys and `dev.lando.*` labels MUST be rejected from these maps, and values MUST be redacted (§3.7). `router.enabled: false` MUST prevent router startup and route publication. `checks` is app-owned (§10.5.2): at the app level it is `false` or `{ profiles?, run?, rules?, retries?, timeout? }`, where `run` is the authored check list and `rules` classify every `http` check in the app; per service it is `false` or `{ path?, okCodes?, retries?, timeout? }` and only tunes or disables that service's generated probes, never carrying rules or verdicts. Rule precedence is service-scoped app rules, app rules, named profiles in order, service-type defaults, Lando built-ins, then the status-code fallback. Check results never fail start, and only `lando-error` verdicts warn. The Lando 3 translator maps `scanner` to service-level `checks`. Build concurrency, failure policy, and transcript retention live under `build` (§6.13).

`sshAgent` (`sidecar`, default `true`; `socket`, an explicit host agent path for host mode) and `gpgAgent` (`forward`, default `false`; `socket`) are also top-level Landofile keys (§7.4). Each field resolves Landofile, then global config, then default; `socket` is checked at start and never enters the plan cache (§10.4). `defaultSecretStore` names the store that resolves bare `${secret:...}` ids and defaults to the bundled `env` store; scheme references ignore it (§7.3.1). Naming a store that is not installed fails with `SecretReferenceInvalidError` at first use.

#### 7.5.1 Root and path resolution primitive

`@lando/core/paths` is the pure Effect-free module exposing `resolveLandoRoots`, `makeLandoPaths`, and `normalizeHostPlatform`. `PathsService` is the level-`minimal` Effect tag wrapping the same primitive (§3.4). `RootOverrides` supports roots, platform, environment, and home for host/test isolation. The primitive returns `LandoPaths` builders for every §9.3 and §12 path. It is host- and test-overridable but MUST NOT be a plugin contribution surface (§4.2).

### 7.6 Environment overrides

Every global key is overridable with the configured prefix, default `LANDO`: camelCase path segments become `UPPER_SNAKE_CASE`, for example `notify.thresholdMs` becomes `LANDO_NOTIFY_THRESHOLD_MS`. JSON-parseable values decode as arrays or objects.

`appEnv`, `appLabels`, `commandAliases.disabled`, and `commandAliases.custom` are whole-document JSON setters and MUST NOT have per-entry scalar setters. `LANDO_PLUGIN_CONFIG_<NAME>` supplies plugin JSON; `LANDO_PROVIDER_<PROVIDER>_*` supplies provider extension values. Standard proxy variables are honored unless explicit `network.proxy` overrides them. `LANDO_NETWORK_CA_CERTS`, `LANDO_NETWORK_CA_INJECT_INTO_SERVICES`, and `LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES` control outbound trust and service injection. The generic `LANDO_CONFIG__<path>` overlay covers every remaining key, so `LANDO_CONFIG__DEFAULT_SECRET_STORE=env` selects the environment-backed store for bare ids for one invocation without editing `config.yml`. Aliases, root variables, and the generic overlay form one `env` layer in the §7.5 stack; an issue in a value it supplied is attributed to the longest variable whose path prefix covers the issue path, as `source: { layer: "env", variable, path }`. 1Password requires an explicit `op://` reference; selecting it as the default does not create a bare-id mapping.

Any §7.4–§7.6 key MAY carry the §18.5 `deprecated` annotation, propagated to schema, generated docs, runtime warning, and `DeprecationService`; removal is gated by §18.7.

### 7.7 Includes and fragments

`includes:` composes pure configuration from local, git, npm, or registry sources before the containing file enters §7.2 merge. A reference is a source string or object carrying `source`, optional `kind`, condition, version, and kind-specific namespace/visibility/variable controls.

#### 7.7.1 Source schemes

| Scheme | Contract |
|---|---|
| Local | Relative or absolute path resolved from the including source; MUST remain under app root unless explicitly relaxed. |
| Git | Hosted shorthand, `https`, `git+https`, `ssh`, `git+ssh`, or `git@host:path`; `version` or an `@ref` suffix requests a tag, branch, or full commit SHA. The resolved commit is locked and content-addressed. |
| npm | Package and optional path/version; the archive is verified against the registry integrity before extraction, and the resolved package is locked and cached. |
| Registry | `registry:<id>` syntax is reserved; implementation is sequenced in the ROADMAP and MUST require signature verification. |

`kind` is `landofile` (default), `tooling`, or `compose`. Landofile and Compose fragments expand into ordered prepared overlays before §7.2. Tooling contributions assemble on the composed document before the single full runtime decode, without decoding whole fragment documents, and share the §8.5.8 `toolingIncludes` contract. Tooling sources read local fragments only, resolve file helpers in their own directory, and materialize against merged recipe options before wire-task validation and namespace assembly. Compose `include` normalizes to `kind: compose`. A `when` expression uses the including context and skips on false.

#### 7.7.2 Fragment shape

A Landofile fragment is partial YAML or JSON and MAY contain top-level configuration except `name`, `runtime`, and `recipe`. It MAY include further fragments. A relative include inside a git or npm fragment resolves within the same repository or package at the parent's resolved revision, MUST stay contained to it, and is locked as its own entry. Cycles fail with `LandofileIncludeError` (`kind: "cycle"`); depth is bounded. `LandofileIncludeError` has optional `path`, `file`, and `layer`: whenever a failure is attributable to one `includes:` or Compose `include:` entry, the resolver supplies its path in the declaring document (`["includes", i]` or `["include", i]`), that document's file, and the Landofile layer whose resolution reached it, preserving the innermost failing entry; a depth failure is attributed to the entry that crosses the limit. Failures not attributable to one entry MAY omit them. Tooling fragments nest only through `toolingIncludes` and fail closed on bare `includes` (§8.5.8).

#### 7.7.3 Merge semantics

Includes resolve in array order; later includes override earlier ones; the including file's inline keys override all of its includes; §7.2 map and array rules apply. File helper paths remain relative to the fragment source. Expressions use the including context and cannot export bindings: load-owned expressions in every fragment, including nested and tooling fragments, read the including app's merged recipe options and captured environment, and a fragment cannot introduce or replace recipe options.

#### 7.7.4 Lockfile

The configurable `<appRoot>/.lando.lock.yml` records exact versions, refs, and checksums for non-local includes and app-declared plugins and is committed. An include entry pins one fragment request, keyed by source and fragment path, to its requested version, resolved revision (commit SHA or package version), and fragment SHA-256. Existing entries MUST be used and verified: a load reads the pinned revision from cache or acquires exactly that revision, and verifies the checksum before parsing the fragment; it MUST NOT re-resolve a floating ref. Absent entries resolve and are added. A load re-resolves a request whose requested version differs from its entry and replaces that entry, so editing `version` behaves like editing a package manifest; it never re-resolves an unchanged request. A checksum mismatch fails with `LandofileLockMismatchError`, and an undecodable lockfile fails with `LandofileParseError`. `app:includes:update` re-resolves requests and refreshes entries, and its `--check` mode reports what a refresh would change. `app:includes:verify` checks that entries pin every request at its requested version and that pinned content matches, without resolving floating refs or updating (§8.2). The lockfile uses `StateStore` with its stable YAML codec, atomicity, and containment (§12.7).

#### 7.7.5 Caching

Resolved fragments are content-addressed and cross-app cached under `<userCacheRoot>/includes/`. Complete caches, lockfile, and built artifacts MUST permit routine start and tooling without network access (§12.6).

#### 7.7.6 Security

Local sources MUST remain contained by default. Git and npm sources MUST be pinned and checksum-verified on every load; drift fails closed. Fragments MUST NOT execute code. Normal parsing allows bounded anchors, aliases, merge keys, and native `!reset`/`!override` directives; it rejects other tags and invalid reference graphs with `LandofileParseError`. Directives follow the same placement, decoding, and merge rules as containing Landofile layers. Translator-only legacy parsing MUST NOT be reachable from includes.

#### 7.7.7 Distinction from related keys

`includes:` is canonical. `toolingIncludes:` remains a non-deprecated shorthand using the same tooling resolver. Compose `include:` appends `kind: compose` entries. None creates a second resolution path.

### 7.8 Schema and documentation publication

Config lint findings MUST carry a stable `rule` identifier and `severity` (`error` or `warning`), derived from schema decoding or a named semantic check; `valid` means no error-severity finding. The resolved-Landofile rules are `landofile.service` (service resolution and its configuration checks, including env files and endpoint declarations), `landofile.hostname` (`hostnames:` grammar), `landofile.healthcheck` (unsupported authored probe kinds), `landofile.route` (authored route fields and HTTP endpoint binding), `landofile.event` (unknown `events:` names), and `landofile.tooling` (enabled tooling tasks whose names are reserved for built-in commands). Existing validation failures remain errors. Bare healthcheck argv beginning with `CMD`, `CMD-SHELL`, or `NONE` warns without reinterpreting argv. Cross-source Lando/Compose healthcheck dialect mixing warns only when disjoint dialect fields survive in the merged document with different retained source origins. Shared fields alone and discarded false/reset/override/form-replacement origins MUST NOT warn. Lint MUST use retained sources, not reload configuration to infer origins.

Load-time structural validity is composition plus load-owned materialization plus one strict effective decode (`errors: "all"`, excess-property error); resolved-Landofile and planning-only semantic checks are separate stages (§7.8). Diagnostics retain effective issue paths and optional `source: { file, layer, path }` pointing to authored spellings, including keyed-list relocation and deletion tombstones. Coordinates MUST NOT be invented. The top-level error file is its primary issue's source, and `LandofileValidationError` always carries actionable `remediation`. Codec tests require strict `decode(encode(decode(x))) == decode(x)`, not general `decode(decode(x))`. Authoring/editor/Standard Schema contracts remain distinct from runtime decoding.

Public Effect Schemas, including `Landofile`, `GlobalConfig`, service/tooling/route/healthcheck configuration, expression AST and errors, plugin manifest, events, prompts, and command result contracts, are published from `@lando/sdk`, registered in `@lando/sdk/schema`, and re-exported by `@lando/core/schema`. Build publication emits JSON Schema, generated reference MDX, and a metadata index. Annotations MUST support validation, editor integration, generated docs, deprecation, and layer merge metadata (`x-lando-merge`, §7.2) (§13.2, §17.2, §18.5).

Published JSON Schema artifacts (`dist/schemas/**`, `dist/command-schemas/**`) are draft 2020-12 documents (`$defs`). Editors get two draft-07 artifacts, `landofile.schema.json` and `global-config.schema.json`, emitted through `JsonSchema.toDocumentDraft07` with `onExcessProperty: "error"` (closed objects) and generated descriptions. The Landofile editor artifact and the Landofile Standard Schema views describe the Landofile as authored: every non-text value site accepts its literal type or a whole-value `{{ ... }}` expression, text sites accept plain and interpolated text, and objects stay closed. A whole-value expression is one the parser marks whole: a single interpolation with no surrounding text. `LandofileStandardSchema` returns decoded authoring values containing parsed `AuthoringExpression` slots, not evaluated runtime values, and rejects planner-owned scopes at non-text sites; `LandofileStandardJSONSchema.input` describes authoring input and `output` describes decoded authoring output. At non-text sites the JSON Schema expression arm is a lexical approximation, so parsed scope and helper-type checks remain authoritative and some valid bodies, such as quoted delimiters, may be rejected. Runtime `LandofileShape` and its `dist/schemas` document stay strict and describe load-materialized values. `LANDOFILE_EDITOR_SCHEMA_URL` in `@lando/sdk/schema` is the one URL for the editor Landofile artifact; the docs build publishes the artifact at exactly that URL. New Landofiles written by `lando init` and `lando app:config:translate` start with `# yaml-language-server: $schema=<url>`; existing files are never rewritten to add it.

`@lando/sdk/schema/standard` exports Standard Schema V1 and Standard JSON Schema V1 views of the Landofile input, global config, plugin manifest, and recipe manifest schemas. The subpath imports individual schema modules and schema-projection helpers, never aggregate schema or service barrels, runtime loaders, or host I/O.

**Parity contract.** Lando's loader defines load-time structural validity, and schema parity is stage-specific; resolved-Landofile and planning-only semantic checks are outside that comparison. Runtime parity holds the published `LandofileShape` JSON Schema document (loaded with `SchemaRepresentation.fromJsonSchemaDocument`) to the `LandofileShape` decoder over every guide and recipe Landofile fixture plus a curated invalid set (unknown keys, wrong types, out-of-range ports, `null` for an optional key). Input parity holds the editor artifact to the Landofile Standard Schema input view, which MUST accept every guide and recipe fixture except an explicit, reasoned list of intentionally invalid ones, plus curated typed-expression cases. Accept/reject must agree within each stage, Standard Schema issue paths and messages must equal that stage's decoder, and every intentional JSON Schema mismatch, including syntax-approximation false positives and false negatives and parsed expression scopes and helper types, is listed in the test with its reason.

**Validation issues.** Authored-file decoders run with `errors: "all"`. `LandofileValidationError`, `RecipeManifestValidationError`, and `ConfigError` (§7.5) carry `issues` as `{ path: Array<string | number>, message, rule?, suggestion?, source? }` (`ValidationIssue`), where `source` is the Landofile arm `{ file, layer, path }` or a global-config arm (`config-file` or `config-drop-in` with `file`, `env` with `variable`, `host`, or `default`); `ConfigLintResult` carries `violations` with required `rule` and `severity`, optional `scopes`, and optional source `line` and `column`. An unknown key's `suggestion` names the closest allowed key within edit distance 2. Every Landofile validation entry point shares these issue semantics. Error summaries distinguish unknown keys, invalid values, or both, and MUST NOT describe a value failure as an unsupported key. Lint validates retained root and included fragments in their authoring role and attempts normal effective finalization, including load-owned materialization using the invocation environment and one strict effective decode (§8.2.1). Runtime validation covers the effective composition, including acquired fragments. Planner-owned sites stay deferred during load validation, and neither validation surface builds an `AppPlan` nor contacts a provider.

For the same unchanged defect, fragment and effective decodes MUST report the same validation message. Validation messages MUST NOT expose authoring machinery: merge-directive wrappers, expression slots, or derived authoring schema names. Partial validation, deferred expressions, and composition can legitimately check different defects.

When effective finalization succeeds, `app:config:lint` runs the planner's resolve pass from that retained snapshot: it evaluates planner-owned expression sites, resolves each service type, projects service and app endpoint declarations (§6.11), and applies the resolved-Landofile validation stage. This still MUST NOT build an `AppPlan`, contact or acquire a provider, inspect images, run general feature application, issue certificates, or write a plan cache. Planning inherits the same projection and validation code, so for the same resolution inputs lint and planning produce the same shared diagnostics; lint omits provider capabilities. The shared checks cover evaluated route fields, authored route-to-HTTP-endpoint binding, and `hostnames:` (§6.6), authored healthcheck kinds, service resolution and configuration, unknown event names, and reserved tooling names. Service checks include unsupported types and versions, service-type configuration issues, env files, storage scopes, log sources, `appMount`, explicit `webroot`, endpoint declaration failures, and normalized endpoint invariants.

A completed resolve pass aggregates independent resolve and authored binding issues with event and tooling-name issues: lint appends them as violations, and planning fails once with `LandofileValidationError` carrying every issue with its `rule`. Binding issues retain the indexed effective route path and authored provenance separately, including local overrides, includes, and TypeScript sources; filtering an earlier invalid route MUST NOT renumber later findings. Authored and service-type reserved tooling names are rejected alike. Event names are checked only once every service resolved, since service-type tooling extends the valid set; reserved tooling names do not extend it. An unknown event's suggestion is only `Did you mean "<name>"?` when a match within edit distance 2 exists, otherwise `Use one of: <valid names>.`.

**Incomplete facts are not empty endpoints.** A service resolver or an individual storage or log-source check MAY stop at its first failure. When a service cannot resolve, type resolution and seed-dependent checks are skipped for its transitive credential consumers, and values that read its credentials are not checked; independent fields, including sibling fields of the same route, are still checked. A failed declaration or invalid endpoint set MUST report its underlying issue and suppress dependent missing-HTTP findings. Incomplete service facts cannot prove app-feature activation absence or a dynamic selector's result: potentially affected endpoint projections remain unavailable. For a successfully resolved service, an explicit valid `endpoints:` list remains authoritative even when feature contributions are unavailable, including an empty list that can independently prove an authored route has no HTTP target. This does not erase the underlying declaration or resolution failure. Blocked route expressions are not eligible for binding, while independent eligible routes still accumulate findings. A `ConfigExpressionError` aborts the resolve pass at its first expression failure, keeps its tag in planning, and becomes one `landofile.expression` violation in lint; this contract does not promise arbitrary expression-error recovery.

An authored top-level `proxy:` route whose target service is undeclared MUST produce an indexed `landofile.route` finding with source provenance and remediation to declare the service or correct the proxy key. An undeclared target is not a declared-but-unavailable service: it has no underlying service-resolution failure to justify silently skipping the binding. Malformed entries retain their syntax findings without renumbering later unknown-target findings.

Internal endpoint projection MUST represent every declared service explicitly, distinguishing an available empty declaration from unavailable preparation, contributions, or normalized endpoints. Known selector facts survive a declaration failure. Unavailable results carry the attributed root reasons; propagating those reasons to credential dependents or affected app selections MUST NOT emit duplicate public findings. Successful assembly consumes established contributions rather than treating an absent result as an empty declaration.

Infrastructure failures and unimplemented features remain command failures rather than violations. Checks that need provider capabilities or the assembled plan (capability gates and capability-dependent resolution, general feature application, automatic route generation/selection, route conflicts, and `dependsOn`) remain planning-only. Existing findings, including warnings and fragment findings, retain their source attribution. Lint findings identical except for `scopes` form one machine record with unique scopes ordered fragment then effective; text output prints those scopes (§8.2.1).

The same unchanged defect therefore produces one lint finding with both `fragment` and `effective` scopes; distinct defects or physical sources remain separate findings.

#### 7.8.1 Canonical Landofile serializer

`@lando/sdk/landofile`, re-exported by `@lando/core/landofile`, owns `emitLandofileYaml`, `emitLandofileYamlEither`, and `parseLandofile`. The emitter accepts native YAML authoring values: ordinary encoded field values with branded merge directives. Transport wire envelopes MUST be decoded to that representation before emission. It preserves expression text, emits block YAML preserving native merge directives, and raises `LandofileEmitError` for unsupported keys or values. The parser returns authoring data with branded native merge directives, or `LandofileParseError`.

Round-trip law: `parseLandofile(emitLandofileYaml(v))` MUST deep-equal the canonical authoring value, including expression text, directive kind, and override payload; ignored reset payloads normalize to a payload-free reset directive. A fixed leading provenance comment MAY be emitted but is not parsed state. Whole-document authoring writes MUST use this serializer; hand-written per-command or per-recipe YAML is forbidden where it applies. Format-preserving config `set`/`unset` (§8.2.1) MAY splice source offsets instead, but each inserted fragment MUST come from this serializer and each resulting document MUST satisfy the same parse-back equality. Fragment encoding validates complete context but emits only the selected fragment. Encoding MUST NOT resolve expressions; optional key sorting MUST NOT reorder arrays.
