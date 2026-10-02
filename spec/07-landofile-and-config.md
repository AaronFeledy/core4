# Lando v4 — Landofile and Configuration

> **Part 7 of 18** · [Index](./README.md)
> **Read next:** [08 CLI and Tooling](./08-cli-and-tooling.md)

This part defines the user-facing Landofile, global configuration, composition, expression, translation, and schema-publication contracts.

---

## 7. Landofile and Configuration

### 7.1 Discovery

A Landofile-bearing directory contains any §7.2 merge file. Discovery walks upward from CWD to the first such directory, which becomes the app root, and stops at the filesystem root, `.lando.stop`, or the configured bounded depth. Discovery uses `FileSystem` and is cached per CWD for the CLI invocation.

`LandofileService` owns discovery, loading, decoding, and source provenance; consumers MUST NOT reproduce those rules.

After ordinary v4 parse or schema validation fails, the loader MAY perform a bounded raw-key legacy check. An unambiguous legacy canonical file raises `Lando3LandofileDetected` with remediation `lando4 app:config:translate --from lando3 --write`; an unambiguous legacy secondary layer beside a valid canonical v4 file raises `LandofileDialectMixError` with remediation `lando4 app:config:translate --from lando3 --file <layer> --write`. Both are `Schema.TaggedError` values carrying app root, file, and applicable conflicting-layer context. Detection MUST NOT parse legacy YAML, load plugins, call `ConfigTranslator.detect`, plan, contact a provider, or read legacy state. Valid or ambiguous v4-shaped content never triggers automatic detection (§7.4.1, §8.2.1).

#### 7.1.1 Landofile file forms

Each merge layer accepts exactly one form:

| Form | Basename | Contract |
|---|---|---|
| YAML | `.lando[.layer].yml` | Canonical declarative form; `lando init` emits it. |
| TypeScript | `.lando[.layer].ts` | Programmatic form loaded by embedded Bun and default-exporting a value validated by the canonical `Landofile` schema. |

Both forms at one layer fail with `LandofileFormConflictError`. Layers MAY mix forms after each decodes to the same `Landofile` shape.

`defineLandofile` is an identity typing helper exported by `@lando/core/schema` and `@lando/sdk`; runtime decoding still uses the canonical schema. A TypeScript default export MUST be a `Landofile` or a function from `LandofileContext` to `Landofile`, `Promise<Landofile>`, or `Effect.Effect<Landofile, LandofileError>`. `LandofileContext` exposes `cwd`, `env`, host facts, layer, merge accumulator, and deferred `secrets`; `secrets.read` accepts the §7.3.1 reference grammar, resolves through the routed `SecretStore`, and preserves §3.7 redaction.

TypeScript modules MUST be pure at top level. Top-level I/O, await, or terminal output fails with `LandofileTopLevelSideEffectError`; function evaluation is bounded. YAML `${VAR}` substitution is not applied to TypeScript output, but emitted `{{ … }}` expressions resolve normally. `includes:` works in either direction. `lando app config edit` MUST refuse TypeScript Landofiles in v4.0, while resolved views work for both forms. Recipes MUST emit YAML.

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

Later layers override earlier layers; maps deep-merge; scalar arrays replace; object arrays merge by `name`, `id`, `hostname`, `service`, or a schema-specific identity key. Tooling arrays `cmds`, `deps`, `status`, `preconditions`, and `prompt` replace unless entries opt into schema-specific merge with stable `name` or `id`. The highest-precedence `name` wins. Custom basenames and pre/post lists belong to global config.

`.lando.recipe.yml` is not a v4 layer; recipes are init-time scaffolds (§8.8). Explicit Lando 3 translation supplies all seven legacy layers as one ordered set, folds recipe between dist and upstream, preserves source layers where v4 merge algebra permits, and MUST preserve final effective configuration over the representable subset. Structural removals hoist the smallest merge-identity unit to its last-transition output layer and produce a `needs-review` diagnostic naming sources and changed prefix behavior. Prefix equivalence is required where representable. There is no compatibility delete value.

Each file resolves and merges its `includes:` before the six-layer merge, using the same map and array rules (§7.7).

### 7.3 Loading external file content

The pure expression helpers `load(path)` and `import(path)` accept local paths only in v4.0. `load` returns a `FileRef`; `import` returns an `ImportRef<T>` preserving provenance. Remote value retrieval is a non-goal; remote fragments use §7.7.

`FileRef` exposes resolved `path`, `size`, `mime`, `checksum`, and `encoding`. Decoders are `text`, `json`, `yaml`, `fromToml`, and `bytes`; extension inference applies to JSON, YAML, and TOML, otherwise text. The optional decoder argument and pipe form are equivalent. Unknown decoders fail with `ConfigExpressionError`.

Structured values support `get(value, path, default?)`, which returns the default or `null` for missing segments, and direct dotted/bracket access, which fails with `ConfigExpressionError`. `ImportRef<T>` exposes `value`, authored `path`, `basename`, `checksum`, and source `layer`. Only schema positions annotated `acceptsImportRef: true` accept it; misuse fails with `LandofileImportRefMisuseError`.

Paths resolve from the containing Landofile or fragment, recipe, or mount-template directory. They MUST remain under the app root after traversal and symlink resolution. Absolute or escaping paths fail with `LandofileLoadOutsideRootError`; explicit global relaxation is logged on every use. Reads are eager, bounded, and included by content identity in the `app-plan` cache key; limit violations fail with `LandofileLoadLimitError`.

The canonical loader and emitter are tag-free. Source-preserving legacy parsing exists only for explicit translation, is bounded, rejects duplicate keys, and MUST NOT weaken or become reachable from normal v4 loading.

### 7.3.1 Configuration expressions

The pure expression language supports `{{ expr }}` interpolation, dotted and bracket paths, equivalent pipe filters and positional calls, whitespace trimming, comments, whole-file `if`/`else` and `for` blocks, and shell forms `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:?message}`, `${VAR:+alt}`, and unambiguous `$VAR`. `{{{{` and `$${` escape literal openers. Whole-expression strings preserve scalar or structured result type; interpolation mixed with text always yields text. Whole-file rendering always yields text.

Built-in helpers are:

| Family | Names |
|---|---|
| Logical/comparison | `default`, `required`, `eq`, `ne`, `lt`, `gt`, `and`, `or`, `not`, `contains`, `startsWith`, `endsWith` |
| String | `lower`, `upper`, `trim`, `split`, `join`, `replace`, `regexMatch` |
| Collection | `length`, `slice`, `keys`, `values`, `entries`, `get`, `merge`, `range`, `map`, `filter` |
| Format | `json`, `fromJson`, `yaml`, `fromYaml`, `fromToml`, `b64encode`, `b64decode` |
| File | `load`, `import`, `text`, `bytes`, `hash` |
| Shell | `shellQuote`, `shellJoin` |
| Process facts | `which`, `glob` |
| Namespaced | `path.join`, `path.dirname`, `path.basename`, `path.extname`, `path.relative`, `path.resolve`; `fs.exists`, `fs.isFile`, `fs.isDir`, `fs.size`; `url.build`, `url.parse`; `semver.satisfies`, `semver.compare` |

Known namespaces MUST be called; other dotted forms are value access. `path.*` is distinct from the `paths.*` scope. Plugins MAY add non-colliding namespaces and pure helpers through §9.5. `pathJoin`, `pathDirname`, and `pathBasename` remain deprecated aliases through v4.x and emit `DeprecationNotice` (§18).

Helpers are synchronous, pure, deterministic, redaction-safe, non-networked, and non-mutating, except captured `load`/`import` reads. They use flat names unless a domain has multiple operations, fixed format values for polymorphic conversion, and a trailing options object for multiple optional controls. Standard return shapes are preserved. Converters return `null` for uninterpretable input, parsers throw `ConfigExpressionError`, predicates return `false`, and misconfiguration throws. Contributed helpers MUST satisfy the SDK contract suite (§13.1).

Expressions parse to an AST and record their minimum bootstrap level:

| Level | Scopes |
|---|---|
| `none` | `host.*`, `env.*`, `paths.*` |
| `minimal` | `app.*`, safe `global.*`, `recipe.*`, loader helpers |
| origin-dependent | `vars.*` |
| `plugins` | self `service.{name,type,primary,creds.*}`, `plugin.<id>.{root,config,version}` |
| `app` | self routes/endpoints; `services.<name>.*`; permitted `globalServices.<name>.*` (§20.8.3) |
| `provider` | `info.*` |
| invocation-specific | tooling `task`, `flags`, `args`, `raw`, `sources`, `generates`, `checksum`, `timestamp`; event `event`; recipe-init `answers`, `recipe`, `destination`, `flags`, `cwd` |

`ConfigService.resolve` resolves at the consumer's current level or returns opaque `DeferredExpression`; consumers MUST NOT escalate bootstrap level. Cross-service cycles, forbidden global-service access, unknown paths, type mismatch, and invalid indexing fail with `ConfigExpressionError` or `ConfigExpressionScopeNotPermittedError` at the consuming level.

Expressions and templates MUST NOT execute shell commands, perform network I/O, or mutate state. `${secret:<reference>}` resolves through the routed `SecretStore` (§4.3, §9.5.1). A bare id matching `^[A-Za-z0-9_.-]+$` (`${secret:DB_PASS}`) routes to `defaultSecretStore`, default `env`. A scheme reference `<scheme>://seg/seg[/seg[/seg]]` (`${secret:op://Vault/Item/field}`) routes to the store owning `<scheme>`; the scheme matches `^[a-z][a-z0-9-]*$`, each of the two to four segments matches `[A-Za-z0-9 _.-]+` (spaces allowed), and an optional `?attribute=<value>` or `?ssh-format=openssh` suffix passes through to the store. Leading or trailing whitespace, empty segments, `..`, control characters, `}`, an unknown scheme, or an unknown default store fail with `SecretReferenceInvalidError`; store failures surface as `SecretNotFoundError` or `SecretStoreUnavailableError` (§9.5.1). Resolved values MUST be registered with the canonical redactor before any event, result, or transcript can carry them, MUST be redacted, and MUST NOT enter caches decrypted. Recipe secret answers MUST resolve to a secret-store reference or exactly one init-only sink, `postInit.stdin` or `postInit.secretEnv.<name>`, and raw bytes MUST NOT enter templates, argv, files, provenance, diagnostics, journals, transcripts, renderer events, or telemetry (§3.7, §8.8).

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
| App behavior | `services`, `tooling`, `toolingDefaults`, `toolingIncludes`, `commandAliases`, `events`, `proxy`, `router`, `keys`, `sshAgent`, `gpgAgent` |
| Deferred data movement | `remotes`, `sync` (§10.12; implementation deferred to 4.1) |
| Plugins | `plugins`, `pluginDirs` |
| Compose subset | `volumes`, `networks`, `configs`, `secrets`, `include`, `x-*` |

`name` defaults to the app-root basename. `slug` deterministically normalizes it for paths, URLs, and provider labels; an empty normalized value uses a stable root hash. `<app-id>` is the v4.0 slug. Collisions fail with `AppIdCollisionError` and MUST NOT auto-suffix. `global` is reserved and fails with `AppIdReservedError`; scratch apps occupy a separate `AppRef.kind` namespace (§20.2, §21.2). Identity rules are published as schema metadata.

Compose compatibility is a service-key vocabulary, not a whole-project format promise. Supported top-level and service keys have exactly one committed disposition: `normalized`, `preserved`, or `rejected`. Preserved non-`x-*` fields require provider capability and MUST NOT be silently dropped; `x-*` is inert. The vendored tagged Compose schema and coverage gate require every upstream key path to be classified.

`extends`, `container_name`, `network_mode`, `links`, Swarm deployment machinery, and `!reset`/`!override` are rejected with remediation. Native anchors, aliases, and merge keys resolve within each file before schema decode and layer merge; invalid reference graphs fail with source-located `LandofileParseError`. Obsolete top-level `version` is accepted, ignored, and emits `DeprecationNotice` (§18). Lando-specific keys win over equivalent Compose shorthand. Compose `include` normalizes to appended `includes` entries with `kind: compose`; the fragment remains subject to the same disposition matrix.

The optional `lando` semver range is validated after merge and before planning. Constraints from every layer accumulate and include prereleases. Failure raises `LandofileVersionConstraintError` with ranges, layers, running version, and remediation. `LANDO_SKIP_VERSION_CONSTRAINT=1` MAY downgrade it to a warning for one invocation; doctor reports unsatisfied or skipped constraints. `lando` constrains core, `runtime` constrains the Landofile format, and service `api` constrains each service. In v4, `runtime: 4` requires `api: 4`; mismatch fails with `LandofileVersionMismatchError`. Future mixed versions are out of scope.

The top-level wrappers `compose:` and `recipes:` are forbidden and fail with `LandofileForbiddenWrapperError`; Compose keys are direct, and recipe provenance uses singular `recipe`. Bare `recipe: <id>` remains valid and inert. The object form carries `id`, `version`, `producer`, `options`, and optional injective service-name mapping; producer identity and canonical content digest MUST agree with the declaration. Local and bundled source identities MUST NOT collide. The declaration MUST NOT trigger expansion, plugin loading, or runtime lookup. `init` and decomposing frontends MUST emit the object form.

### 7.4.1 Config translation

Translation is explicit conversion through `LandofileAuthoringShape` and recursively partial `LandofileAuthoringFragment`. `LandofileShape` is runtime input and `AppPlan` is provider-neutral output; frontends MUST NOT emit `AppPlan`, and text backends MUST NOT encode runtime or plan shapes. These public Effect Schemas share canonical field definitions and inferred types.

Only `app:config:translate`, `app:config:explain`, `app:config:migrate`, and `apps:init` invoke translators (§8.2.1, §8.8). Translators MUST NOT run during discovery, normal loading, start, or tooling. Core owns bounded reads, ordering, containment, cumulative-prefix and final validation, encoding, and mutation. Frontends own foreign parsing and merge semantics, folding, diagnostics, and output ownership, but MUST NOT read or write files, follow references, plan, contact providers, install plugins, or mutate the app.

`ConfigTranslateInput` is tagged `landofile-document-set` or `recipe-request`. The former carries the ordered bounded source snapshots, source/layer identities, digests, media types, selection mode, lower-v4 context, and writable layers; the latter carries recipe identity, synthetic source id, and decoded nonsecret answers or approved secret references. Raw secrets and deletion intents are forbidden in recipe requests.

`ConfigTranslateResult` contains ordered unique-target authoring fragments, source ids, diagnostics, and deletion intents. Core MUST validate all targets and deletions. `ConfigTranslateDetectInput` contains snapshots and metadata only. `ConfigTranslateEncodeInput` carries an authoring wire tree and validated complete context; encoders emit only the selected fragment. `ConfigTranslateDiagnostic` carries source id, key path, optional source span, kind, message, and remediation.

`ConfigTranslator` names `id`, `summary`, `inputKinds`, `detect`, `translate`, and optional `encode`, returning `Effect` with `ConfigTranslateError` and `never` requirements. `ConfigTranslatorRegistry` is the Effect service selecting these contracts. Factories close over explicit SDK ports such as `RecipeDecomposer`; they MUST NOT import core or request dynamic services. The bundled translators are `lando4` (decode/encode), `recipe` (decode through `RecipeDecomposer`), and decode-only `lando3`. Translation registration is lazy at bootstrap level `plugins`; duplicate ids fail as a tagged producer collision with no precedence winner (§9.5).

Encoder round-trip law: `decodeAuthoring_T(T.encode(v).text)` MUST equal `canonicalAuthoring_T(v)`, including expression AST and expected types, but excluding formatting and the fixed provenance comment.

The six diagnostic kinds are `generated`, `dropped`, `rewritten`, `unsupported`, `non-portable`, and `needs-review`. Every omitted input path MUST produce `dropped`; diagnostics are deterministic and ordered, and preview and write report the same array. `unsupported` blocks encoding and writing. `non-portable` blocks target writes unless the target preserves semantics. There is no residual runtime interpretation bag.

Preview is default. `--to lando4 --write` writes only declared v4 YAML targets through the managed-file transaction (§12.4) and invalidates affected caches. Other encoders MAY preview but MUST fail closed on write until a safe target mapping exists. Core MUST NOT guess filenames or overwrite foreign text. TypeScript and includes remain opaque and MUST NOT execute. Dynamic or remote references produce `needs-review`; translators MUST NOT fetch or inspect them.

### 7.5 Global config

Global config loads `<userConfRoot>/config.yml` then `<userConfRoot>/config.d/*.yml`; later layers win and maps deep-merge. Root defaults are platform-conventional and resolved by `@lando/core/paths` and `PathsService`, never re-derived by consumers.

| Root | Purpose |
|---|---|
| `userConfRoot` | User-edited configuration |
| `userCacheRoot` | Disposable caches and logs |
| `userDataRoot` | Persistent Lando-managed data |
| `systemPluginRoot` | Read-only system plugin search root (§9.3) |

Per-root precedence is explicit runtime option, root-specific environment variable, global config where applicable, then platform default. `userConfRoot` is fixed before reading global config and cannot relocate its own load. `systemPluginRoot` is never a `meta:plugin:add` destination.

| Group | Global keys |
|---|---|
| Files/roots | `envPrefix`, `domain`, `landoFile`, `landoLockFile`, `preLandoFiles`, `postLandoFiles`, `userConfRoot`, `userCacheRoot`, `userDataRoot`, `systemPluginRoot` |
| Providers/apps | `defaultProvider`, `providers`, `appEnv`, `appLabels`, `globalServices` |
| Plugins | `plugins`, `pluginDirs`, `disablePlugins`, `pluginConfig` |
| Network/router | `bindAddress`, `router`, `network.proxy`, `network.ca`, `scanner`, `healthcheck` |
| Experience | `logger`, `renderer`, `notify`, `toolingEngine`, `commandAliases`, `agentEnv`, `keys`, `maxKeyWarning`, `logLevelConsole` |
| Agents/secrets | `sshAgent`, `gpgAgent`, `defaultSecretStore` |
| Automation | `mcp`, `build`, `experimental`, `stats` |
| Landofile evaluation | discovery, include, load, and TypeScript-evaluation bounds; `defaultTemplateEngine`; unsafe-engine opt-in; outside-root relaxations |

Published nested keys include `router.{enabled,bindAddress,httpPort,httpsPort,httpFallbacks,httpsFallbacks}`, `network.proxy.{http,https,noProxy,injectIntoServices}`, `network.ca.{trustHost,certs,injectIntoServices}`, `notify.{enabled,thresholdMs,commands}`, `commandAliases.{enabled,disabled,custom}`, `agentEnv.{enabled,allow,deny}`, `sshAgent.{sidecar,socket}`, `gpgAgent.{forward,socket}`, `mcp.{allow,deny,tooling,maxConcurrent}`, `scanner.{path,okCodes,retries,timeout}`, `healthcheck.{retry,delay}`, `build.{concurrency,failFast,transcripts}`, and `stats.report`. Evaluation-policy keys are `discovery.maxDepth`, `landofile.tsTimeoutMs`, `loadMaxFileBytes`, `loadMaxFilesPerExpression`, `loadMaxRecursionDepth`, `includeMaxDepth`, `allowLoadOutsideRoot`, `allowIncludeOutsideRoot`, and the unsafe-template-engine opt-in. Values are bounded and schema-validated; tuning defaults are not architecture contracts.

`notify` is the only Beta 1 key published through `PublishedGlobalConfigKey`/`configKey`; it decodes as `NotifyConfig` (§8.9.7). Its canonical-command allowlist is validated against the cwd-independent global registry, so global validity MUST NOT depend on app discovery.

`appEnv` and `appLabels` are bounded whole maps applying only to user apps. Service-authored values win per key. Core-owned `LANDO`/`LANDO_*` environment keys and `dev.lando.*` labels MUST be rejected from these maps, and values MUST be redacted (§3.7). `router.enabled: false` MUST prevent router startup and route publication. `scanner` is `false` or bounded `{ path?, okCodes?, retries?, timeout? }`; failures warn after redaction and MUST NOT fail start (§10.5). Build concurrency, failure policy, and transcript retention live under `build` (§6.13).

`sshAgent` (`sidecar`, default `true`; `socket`, an explicit host agent path for host mode) and `gpgAgent` (`forward`, default `false`; `socket`) are also top-level Landofile keys (§7.4). Each field resolves Landofile, then global config, then default; `socket` is checked at start and never enters the plan cache (§10.4). `defaultSecretStore` names the store that resolves bare `${secret:...}` ids and defaults to the bundled `env` store; scheme references ignore it (§7.3.1). Naming a store that is not installed fails with `SecretReferenceInvalidError` at first use.

#### 7.5.1 Root and path resolution primitive

`@lando/core/paths` is the pure Effect-free module exposing `resolveLandoRoots`, `makeLandoPaths`, and `normalizeHostPlatform`. `PathsService` is the level-`minimal` Effect tag wrapping the same primitive (§3.4). `RootOverrides` supports roots, platform, environment, and home for host/test isolation. The primitive returns `LandoPaths` builders for every §9.3 and §12 path. It is host- and test-overridable but MUST NOT be a plugin contribution surface (§4.2).

### 7.6 Environment overrides

Every global key is overridable with the configured prefix, default `LANDO`: camelCase path segments become `UPPER_SNAKE_CASE`, for example `notify.thresholdMs` becomes `LANDO_NOTIFY_THRESHOLD_MS`. JSON-parseable values decode as arrays or objects.

`appEnv`, `appLabels`, `commandAliases.disabled`, and `commandAliases.custom` are whole-document JSON setters and MUST NOT have per-entry scalar setters. `LANDO_PLUGIN_CONFIG_<NAME>` supplies plugin JSON; `LANDO_PROVIDER_<PROVIDER>_*` supplies provider extension values. Standard proxy variables are honored unless explicit `network.proxy` overrides them. `LANDO_NETWORK_CA_CERTS`, `LANDO_NETWORK_CA_INJECT_INTO_SERVICES`, and `LANDO_NETWORK_PROXY_INJECT_INTO_SERVICES` control outbound trust and service injection. The generic `LANDO_CONFIG__<path>` overlay covers every remaining key, so `LANDO_CONFIG__DEFAULT_SECRET_STORE=1password` selects the default secret store for one invocation without editing `config.yml`.

Any §7.4–§7.6 key MAY carry the §18.5 `deprecated` annotation, propagated to schema, generated docs, runtime warning, and `DeprecationService`; removal is gated by §18.7.

### 7.7 Includes and fragments

`includes:` composes pure configuration from local, git, npm, or registry sources before the containing file enters §7.2 merge. A reference is a source string or object carrying `source`, optional `kind`, condition, version, and kind-specific namespace/visibility/variable controls.

#### 7.7.1 Source schemes

| Scheme | Contract |
|---|---|
| Local | Relative or absolute path resolved from the including source; MUST remain under app root unless explicitly relaxed. |
| Git | Hosted shorthand or `git+https`; resolved ref is locked and content-addressed. |
| npm | Package and optional path/version; resolved package is locked and cached. |
| Registry | `registry:<id>` syntax is reserved; implementation is deferred until after v4.0 and MUST require signature verification. |

`kind` is `landofile` (default), `tooling`, or `compose`. Landofile and Compose fragments resolve per file before §7.2; tooling resolves during app-plan compilation and shares the §8.5.8 `toolingIncludes` contract. Compose `include` normalizes to `kind: compose`. A `when` expression uses the including context and skips on false.

#### 7.7.2 Fragment shape

A Landofile fragment is partial YAML or JSON and MAY contain top-level configuration except `name` and `runtime`. It MAY include further fragments. Cycles fail with `IncludeCycleError`; depth is bounded. Tooling fragments nest only through `toolingIncludes` and fail closed on bare `includes` (§8.5.8).

#### 7.7.3 Merge semantics

Includes resolve in array order; later includes override earlier ones; the including file's inline keys override all of its includes; §7.2 map and array rules apply. File helper paths remain relative to the fragment source. Expressions use the including context and cannot export bindings.

#### 7.7.4 Lockfile

The configurable `<appRoot>/.lando.lock.yml` records exact versions, refs, and checksums for non-local includes and app-declared plugins and is committed. Existing entries MUST be used and verified; absent entries resolve and are added. `app:includes:update` refreshes entries and `app:includes:verify` verifies without updating (§8.2). Drift or absence fails with `IncludeLockError`. The lockfile uses `StateStore` with its stable YAML codec, atomicity, and containment (§12.7).

#### 7.7.5 Caching

Resolved fragments are content-addressed and cross-app cached under `<userCacheRoot>/includes/`. Complete caches, lockfile, and built artifacts MUST permit routine start and tooling without network access (§12.6).

#### 7.7.6 Security

Local sources MUST remain contained by default. Git and npm sources MUST be pinned and checksum-verified on every load; drift fails closed. Fragments MUST NOT execute code. Normal parsing allows bounded anchors, aliases, and merge keys but rejects unsupported tags and invalid reference graphs with `LandofileParseError`. Translator-only legacy parsing MUST NOT be reachable from includes.

#### 7.7.7 Distinction from related keys

`includes:` is canonical. `toolingIncludes:` remains a non-deprecated shorthand using the same tooling resolver. Compose `include:` appends `kind: compose` entries. None creates a second resolution path.

### 7.8 Schema and documentation publication

Public Effect Schemas, including `Landofile`, `GlobalConfig`, service/tooling/route/healthcheck configuration, expression AST and errors, plugin manifest, events, prompts, and command result contracts, are published from `@lando/sdk`, registered in `@lando/sdk/schema`, and re-exported by `@lando/core/schema`. Build publication emits JSON Schema, generated reference MDX, and a metadata index. Annotations MUST support validation, editor integration, generated docs, and deprecation (§13.2, §17.2, §18.5).

#### 7.8.1 Canonical Landofile serializer

`@lando/sdk/landofile`, re-exported by `@lando/core/landofile`, owns `emitLandofileYaml`, `emitLandofileYamlEither`, and `parseLandofile`. The emitter accepts encoded `LandofileAuthoringShape` or context-validated `LandofileAuthoringFragment`, preserves expression text, emits tag-free block YAML, and raises `LandofileEmitError` for unsupported keys or values. The parser returns plain authoring data or `LandofileParseError`.

Round-trip law: `parseLandofile(emitLandofileYaml(v))` MUST deep-equal the canonical authoring value, including expression text. A fixed leading provenance comment MAY be emitted but is not parsed state. All authoring writes MUST use this serializer; hand-written per-command or per-recipe YAML is forbidden where it applies. Fragment encoding validates complete context but emits only the selected fragment. Encoding MUST NOT resolve expressions; optional key sorting MUST NOT reorder arrays.
