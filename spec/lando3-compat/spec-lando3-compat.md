# Spec: Lando 3 compatibility (`@lando/lando3`)

Status: authored design, pre-implementation. Normative for the PRD set in this directory. Core translation work is sequenced in [`../config-translation/`](../config-translation/); Landofile IR completion is sequenced in [`../ir-gaps/`](../ir-gaps/).

## 1. Goal

Lando 4 MUST support migration from Lando 3 through side-by-side binaries and explicit conversion. During Alpha and Beta, installation names the Lando 4 binary `lando4`; the package-manager-owned `lando` binary remains Lando 3. Conversion is:

```sh
lando4 app:config:translate --from lando3 --write
```

| Situation | Required behavior |
|---|---|
| Lando 3 directory and `lando4 <app verb>` | Fail with `Lando3LandofileDetected`. Remediation MUST quote `lando4 app:config:translate --from lando3 --write`. |
| Lando 3 directory and `lando <app verb>` | Lando 3 runs exactly as it did before Lando 4 was installed. |
| Converted directory and `lando4 <app verb>` | Load, plan, and run as an ordinary Lando 4 app on normal provider precedence. |

Conversion MUST be explicit. Lando 4 MUST NOT execute or translate a Lando 3 Landofile in memory during normal app bootstrap (§9.5).

## 2. Decisions (recorded)

These decisions are closed:

1. **Binaries remain side by side.** Alpha and Beta install Lando 4 as `lando4` (§17.7). The GA executable name is decided at RC.
2. **Conversion is explicit and set-based.** Core supplies every standard Lando 3 layer once. Outputs preserve source layers where v4 merge algebra permits, fold `.lando.recipe.yml`, and use diagnosed minimal-unit hoisting where a structural removal is otherwise impossible (§6).
3. **Translation is best effort.** Every source key is translated, rewritten, rejected as unsupported, or reported as dropped. A drop MUST NOT be silent.
4. **Translation is hard.** Output contains no `!lando3` marks, residual source bag, or compatibility delete operator. Recipe output uses the full `recipe: {id, version, producer, options, services?}` contract and authoring expressions.
5. **Recipe decomposition is shared.** The translator maps Lando 3 `recipe:` and `config:` to bundled recipe options, then calls the bundled recipe `decompose` contract. It MUST NOT re-encode recipe services, tooling, or defaults.
6. **Lando 3 user state is isolated.** Nothing in this plugin or its host integration reads or writes `~/.lando`.
7. **Upgrade and adoption are not operations.** This plan adds no `lando4 setup --upgrade`, container adoption, volume adoption, or resource migration. Existing v3 resources remain owned by v3.
8. **The translator is decode-only in 4.0.** A `lando3` `encode` arm is deferred to 4.1.

## 3. Non-goals

- Adopting Lando 3 containers, volumes, or networks into the Lando 4 engine in 4.0.
- Emulating Lando 3 images, entrypoints, helpers, environment, or execution order.
- Hoster synchronization, including pull or push behavior.
- Honoring custom Landofile names from `~/.lando/config.yml`. Explicitly supplied custom-name settings are diagnosed only.
- Downloading or managing a Lando 3 binary.

## 4. Package and installed coexistence

`plugins/lando3` publishes the bundled package `@lando/lando3`. It MUST depend only on `@lando/sdk` and `@lando/paths`. It MUST NOT depend on `@lando/core` or `@lando/container-runtime`.

The plugin is wired through `core/build.config.ts` and `core/src/plugins/generated/**`. Its module contributes:

```ts
definePlugin({
  configTranslators: [lando3],
});
```

The initial plugin scaffold contributes only `lando3`. US-622A first lands the SDK app-identity, selected-provider name/label inspector, and executable-path locator ports and their core implementations. Only then does it add `doctorChecks: [lando3Leftovers, lando3Shadow]`. No scaffold story injects a future doctor port.

The package MUST expose only its root export. It has no subpath exports. It has no cold-start or pre-dispatch entry and MUST NOT participate in normal app bootstrap (§3.2, §9.5).

The npm package retains `package.json#bin` name `lando4`. Release asset filenames retain platform ids such as `lando-v4-<version>-windows-x64.zip`; asset naming never selects the installed executable name. Source execution and every relocated compiled artifact dispatch the same registry as `lando4` or `lando4.exe`. Installer, update, uninstall, and shellenv operate only on the v4-owned install record and executable. They reject a destination already owned by another installation, never rename, replace, chmod, shim, remove, or rewrite an existing `lando` executable, and never edit v3 state. Windows update uses the v4-owned running-executable replacement protocol and leaves `lando.exe` untouched. Coexistence tests seed hostile v3 binaries and state, then prove byte and metadata identity before and after install, update, uninstall, and shellenv.

## 5. Lando 3 shape model

The plugin owns an Effect Schema model for Lando 3 Landofiles. Decode is permissive: modeled keys decode to typed fields and unknown keys are retained with source paths for diagnostics. A dedicated source-preserving `LEGACY` parser mode accepts quoted scalars, literal and folded block scalars, populated flow maps/sequences, anchors and bounded aliases, and arbitrary tags as tagged data. It rejects duplicate mapping keys, aliases beyond the configured count, nesting beyond the configured depth, and documents beyond the configured byte limit. It records source spans. This mode does not weaken normal v4 parsing restrictions.

[`reference/kitchen-sink.lando.yml`](./reference/kitchen-sink.lando.yml) is the authored inventory. [`reference/kitchen-sink.config.yml`](./reference/kitchen-sink.config.yml) records the Lando 3 global-config shape for model and diagnostic tests only. Implementation copies the pinned upstream YAML corpus into the owning package test fixtures with source repository, exact commit, source path, checksum manifest, GPL notice, and the repository's reviewed fixture-license policy. Production code and tests MUST NOT read `spec/**`. The notice records provenance and license terms without claiming legal conclusions beyond the reviewed policy.

### 5.1 Discovery and layering

Lando 3 discovers the first ancestor containing a recognized Landofile and loads files from that one app root in this order, later winning:

```text
.lando.base.yml
.lando.dist.yml
.lando.recipe.yml
.lando.upstream.yml
.lando.yml
.lando.local.yml
.lando.user.yml
```

Merge MUST match Lando 3 `utils/legacy-merge.js`: mappings deep-merge; arrays concatenate and then deduplicate by legacy equality. A later layer cannot remove an earlier legacy array item. The translator receives the full core-ordered set once and retains source ids/spans through foreign merge and lowering.

Final effective-config equivalence is mandatory over the representable subset. Prefix equivalence is required only where v4 merge algebra can represent the legacy transition. There is no compatibility-only v4 delete value. When a structural removal cannot be represented as a later delta, the translator hoists the smallest affected merge-identity unit to the highest output layer containing that unit's last transition, omits lower copies of that unit, preserves every unrelated field in its original layer, and emits one `needs-review` relocation diagnostic naming all source ids and every earlier-prefix behavior that changed.

Examples:

- If dist decomposition emits service `redis` and local changes the option to false, final v4 omits `redis`. The complete `services.redis` unit is owned by local, no lower copy is emitted, and the diagnostic says that the dist-only prefix no longer contains redis in translated files.
- If local removes one nested generated key that v4 deep merge cannot delete, only the nearest merge-identity object containing that key is hoisted; sibling services and unrelated keys remain in their source layers.
- Legacy scalar arrays retain concatenate/deduplicate semantics. Object arrays use v4 identity keys; only the conflicting identity unit is hoisted when deletion/replacement cannot be expressed.
- `.lando.recipe.yml` is folded at its real interval between dist and upstream. Tests compare prefixes before the interval and after the folded effect, never a nonexistent v4 recipe-layer prefix.

Live edits to structural recipe options do not dynamically add or remove emitted services at runtime. The user runs explicit regeneration or recipe migration to edit file structure.

### 5.2 Detect

The Lando 3 sniff is the translator's `detect` operation. Parsing uses the source-preserving `LEGACY` mode, never `Bun.YAML`. Detection reads only supplied bounded bytes and filenames. It performs no referenced-file IO. `!load` and `!import` are inspected as tagged data and translated later.

A document or layer set is Lando-3-positive when any Lando-3-only signal exists:

- top-level `recipe:` and `config:` occur together;
- `services.<name>.api: 3`;
- an API-3 `type: lando` or `type: compose` service contains nested `services:`;
- a service contains `overrides:`;
- a service contains `build_as_root`, `run_as_root`, `build_internal`, or `run_internal`;
- `tooling.<name>.options` exists;
- `tooling.<name>.cmd` is a list of one-entry `{service: command}` maps;
- a service contains `portforward:`;
- `proxy.<service>` contains a string entry;
- top-level `compose:`, `pluginDirs:`, `plugins:`, or `excludes:` exists; or
- `.lando.recipe.yml` is present in the layer set.

These are explicitly not signals:

- `type: php:8.3` or any other catalog `type:version` spelling;
- `services.<name>.api: 4`; or
- absence of `runtime: 4`.

Automatic detection is conservative. It may return no match for an ambiguous document whose shape is valid v4. Explicit `--from lando3` bypasses that ambiguity and parses in `LEGACY` mode. Positive corpus claims are split into an unambiguous detected subset and an intentional explicit-only subset; malformed, unsupported, and ambiguous fixtures are rejection fixtures, not promised positives.

The signal list MUST be used only by `app:config:translate --detect`, `app:config:translate --from lando3`, the v4 loader's tagged-error path, and the per-layer dialect-mix check. A successful v4 load MUST NOT invoke `ConfigTranslator.detect`. The loader checks raw key presence directly as specified in §7; it never resolves or invokes the translator.

If explicitly supplied input contains Lando 3 `landoFile`, `preLandoFiles`, or `postLandoFiles` settings, translation emits a `needs-review` diagnostic naming those custom files. Detection only returns matches; it does not locate, honor, or open the custom files.

### 5.3 Naming

Naming is reimplemented in the plugin for the `lando3-leftovers` doctor check:

| Value | Rule |
|---|---|
| `name` | `slugify(name, {lower: true, strict: true})` |
| `project` | `name.toLowerCase().replace(/_|-|\.+/g, "")` |
| container | `<project>_<service>_1` |
| service volumes | `<project>_data_<service>`, `<project>_home_<service>` |
| top-level volume | `<project>_<volume>` |
| network | `<project>_default`; shared legacy network `lando_bridge_network` |
| proxy | `landoproxyhyperion5000gandalfedition_proxy_1` on `landoproxyhyperion5000gandalfedition_edge` |

The Lando 3 `app.id` object hash is not needed and MUST NOT be reimplemented.

## 6. Translation

The `lando3` translator is decode-only. It lowers one Lando 3 document set to valid `LandofileAuthoringFragment` outputs (§7.4.1); it never emits an `AppPlan` or invokes a provider.

### 6.1 Per-layer conversion

Input is one `landofile-document-set` containing every recognized Lando 3 layer present in core order. The plugin parses and foreign-merges the set once. Outputs are unique `targetLayer` authoring fragments with contributing `sourceIds`:

| Lando 3 input | Lando 4 output |
|---|---|
| `.lando.base.yml` | `.lando.base.yml` |
| `.lando.dist.yml` | `.lando.dist.yml` |
| `.lando.recipe.yml` | folded into `.lando.dist.yml` |
| `.lando.upstream.yml` | `.lando.upstream.yml` |
| `.lando.yml` | `.lando.yml` |
| `.lando.local.yml` | `.lando.local.yml` |
| `.lando.user.yml` | `.lando.user.yml` |

Each output retains target layer, contributing source ids, source spans/paths, and ownership class. `.lando.recipe.yml` folds at its exact interval. Recipe decomposition receives each required foreign-merged effective `recipe:` plus `config:` option view through the injected SDK port. The layer introducing the recipe receives object provenance with mandatory producer; later representable changes emit deltas, while unrepresentable removals use §5.1 hoisting. Non-recipe fields remain source-owned where algebra permits.

Full mode writes the declared output set and removes `.lando.recipe.yml` only through the shared transaction after its folded effect is staged. `--file` MAY read every standard layer as context but writes only the selected source's target dependency closure. If correctness requires editing a lower legacy or nonselected target, it fails before staging with remediation to run full conversion. It never silently broadens the write set.

The v4 emitter writes expression-aware, tag-free authoring fragments. Core validates partial authoring prefixes and the complete final authoring shape. Normal load performs runtime-value resolution/validation. Repeating conversion against identical bytes produces byte-identical files and diagnostics.

### 6.2 Recipes

The translator maps options and delegates decomposition:

| Lando 3 recipe | Bundled Lando 4 recipe | `config:` to option mapping |
|---|---|---|
| `drupal7` through `drupal11` | `drupal` | major from suffix; `php`, `via`, `database` (`engine:version`), `webroot`, `composer_version` to `composer`, `xdebug`, `drush` |
| `wordpress` | `wordpress` | `php`, `via`, `database`, `webroot`, `composer_version` to `composer`, `xdebug` |
| `lamp`, `lemp` | same id | `php`, `database`, `webroot`, `composer_version` to `composer`, `xdebug`; `via` for `lamp` |
| `laravel`, `symfony`, `backdrop`, `joomla`, `mean` | same id | The bundled recipe's published option map |
| `pantheon`, `platformsh`, `lagoon`, `acquia` | none | `unsupported`; fail with `Lando3UnsupportedRecipeError` |
| unknown | none | `unsupported`; fail with `Lando3UnsupportedRecipeError` |

An unmapped `config:` key is `dropped` with its source span and manual-edit remediation. Recipe-generated services and tooling come from the injected `RecipeDecomposer` SDK port over foreign-merged options; the translator does not import core or maintain a second recipe expansion. Safe bundled declarative decomposition/template evaluation is permitted. Arbitrary `recipe.ts`, remote code, and app code are prohibited. Core supplies only nonsecret answers or approved references; raw secret answers never reach the translator.

### 6.3 Services

Targets below describe the IR after the linked [`../ir-gaps/`](../ir-gaps/) story lands. Before a required story lands, the affected source key is `dropped` and its remediation MUST name that story id.

| Lando 3 source | Lando 4 target | Diagnostic / prerequisite |
|---|---|---|
| Catalog `type: <type>[:<version>]` | Same catalog type and version; `via`, `webroot`, `creds`, and supported type options normalize to the catalog schema | `rewritten` when key spelling changes |
| `composer_version`; type `config.*` | `composer`; Solr config copied to `/var/solr/data/<core>/conf`; PostgreSQL `/etc/lando/postgresql.conf`; MySQL/MariaDB `/etc/mysql/conf.d/99-lando.cnf`; MongoDB `/etc/lando/mongod.conf`; other documented generic config mounts | `rewritten`; file config waits for US-618A and Composer packages wait for US-618B |
| `portforward: true` or a number | `ports:` with an unpinned or fixed published port | `rewritten`; core does not gain `portforward:` |
| API-3 nested `type: lando` / `type: compose` | Flat `type: compose` service | `rewritten` |
| `build_as_root`, `build_internal`, `build`, `run_as_root`, `run_internal`, `run` | Ordered `build.artifact` / `build.app` step objects with explicit `user` | `rewritten`; waits for US-616 |
| API-4 `type: lando` / `l337` | `type: lando` with image, command, entrypoint, user, endpoints, mounts, environment, appMount, storage, certs, security, healthcheck, and hostnames | Unsupported image-object or mount fields are `dropped` individually |
| Unknown type with `overrides.image` | `type: compose` with the image and representable Compose fields | `rewritten`; without an image the service is `unsupported` |
| `overrides:` | Supported keys move to the first-class service shape | `rewritten`; disposition-rejected keys are `dropped` |
| `ssl`, `sslExpose`, `sport`, `meUser` | `certs`, endpoint protocol, and `user` | `rewritten` |
| `scanner` | v4 `scanner:` and post-start scan | waits for US-617B |
| Implicit per-service home persistence | v4 default `home` storage | waits for US-617A |
| `moreHttpPorts` | none | `dropped` |
| top-level `compose:` | `includes: [{kind: compose, path: <path>}]` | `rewritten` for a syntactically valid path; core validates literal local target existence without executing or reading include contents |
| top-level `excludes:` | `appMount.excludes` on each app-mounted service | `rewritten` |
| `env_file`, `volumes`, `networks`, `x-*`, anchors | Equivalent v4 / supported Compose fields | preserved or normalized |
| `plugins`, `pluginDirs`, `keys` | none | `dropped` with manual plugin or SSH remediation |
| Catalog gaps including Node globals, Solr/database config, Redis password/persistence, PHP Composer packages, and Mailpit sender wiring | Typed US-618A/B/C fields, including `mailFrom?: false | ServiceName[]` with omitted/all-PHP and false/none semantics | waits for US-618A, US-618B, and US-618C by row |

When a translated script string references `LANDO_INFO`, the translator emits `needs-review` with migration guidance for typed `LANDO_DB_*` variables and checks known external `settings.lando.php` and `wp-config` script references without claiming complete app equivalence. The coordinated core-spec amendment removes the aggregate credentials alias if present. A `LANDO_MOUNT` reference emits `needs-review` naming `LANDO_PROJECT_MOUNT`. No compatibility alias is added.

### 6.4 Tooling, events, and proxy

| Lando 3 source | Lando 4 target | Diagnostic / prerequisite |
|---|---|---|
| Tooling `service`, string `cmd`, `description`, `dir`, `env` | Same tooling fields | normalized |
| Tooling `user`, `disabled`, `options`, positional key args, multi-service `cmd` maps, `service: :<flag>`, `service: :host` | `user`, `disabled`, `flags`, `args`, and `cmds` step objects | `rewritten`; waits for US-613 |
| Tooling `level`, `usage`, `examples`, `interactive`, trailing background `&` | none | `dropped` with explicit manual remediation |
| App lifecycle events | Same event names and explicit service-targeted task steps | normalized |
| `pre-<tool>` / `post-<tool>` and `pre-restart` / `post-restart` | Tooling-scope and restart event names | `rewritten`; waits for US-614 |
| Untargeted event command | Explicit service selected by Lando 3 order: first primary API-4 service, first API-3 service, first Compose service, then `appserver` | `generated` |
| `proxy.<service>` string or object route | v4 route object with hostname, scheme, endpoint, pathPrefix, and filters | `rewritten`; waits for US-615 |
| Proxy `pathname` | `pathPrefix` plus `filters: [{type: stripPrefix}]` | `rewritten`; waits for US-615 |
| Proxy `-secured` suffix | `scheme: https` | `rewritten`; waits for US-615 |
| Header middleware | Bundled request / response header `RouteFilter` | `rewritten`; waits for US-615 |
| Other middleware | none | `dropped` with the middleware name |

Lando 3 `!load` and `!import` YAML tags MUST become the §7.3 expression helpers `{{ load(...) }}` and `{{ import(...) }}`. Decoder suffixes such as `@string` become the corresponding helper pipeline, for example `{{ load('script.sh') | text }}`. Each conversion emits `rewritten`; files are not inlined.

Every lowerer also follows the closed per-variant `target`, `drop`, or `unsupported` disposition in [`lando3-gap-analysis.md`](./lando3-gap-analysis.md#6-residual-option-disposition). The inventory has no unspecified fallback.

Core post-translation validation checks literal app-local Compose include paths for existence, regular-file type, symlink rejection, and containment by metadata only. A missing or unsafe target blocks writing and is reported in preview and write validation, without changing the frontend's emitted include or claiming it was dropped. Dynamic or remote include targets are opaque: report `needs-review`, do not fetch, and block only operations requiring their semantic contents. Translators never inspect referenced-file metadata themselves.

### 6.5 Identity

The translated `name` is the Lando 3 slug. Provider selection follows ordinary Lando 4 precedence. Lando 4 derives its own app id, labels, networks, volumes, and service names. Source records retained by conversion are immutable `<file>.bak.<full-before-sha256>` backups and the managed-file transaction journal lifecycle defined by the shared spec.

### 6.6 Diagnostics

The translator uses the §7.4.1 diagnostic kinds extended by [`../config-translation/`](../config-translation/):

| Kind | Meaning |
|---|---|
| `generated` | A target value was inferred or supplied by recipe decomposition. |
| `dropped` | A source key has no emitted target. Remediation is mandatory. |
| `rewritten` | Semantics are retained under a different shape or spelling. |
| `unsupported` | The recipe, service, or whole input cannot produce a valid v4 fragment. |
| `non-portable` | The closest target requires provider-specific behavior. |
| `needs-review` | Output is valid, but a script, custom filename, or semantic edge requires user review. |

Every diagnostic MUST include source file, source key path, kind, message, and remediation. Ordering is layer order, then source location, then key path. A report MUST list every dropped key exactly once.

## 7. Load-time errors

`loadUserLandofile` in `landofile/src/app-resolution.ts` remains v4-only (§7.1, §9.5).

- **`Lando3LandofileDetected`.** After ordinary v4 parse or schema validation fails, the loader may perform a bounded, dependency-free raw-key check in that existing failure path. It does not parse legacy YAML, load the plugin, or invoke a translator. The error names the canonical file and quotes `lando4 app:config:translate --from lando3 --write`.
- **`LandofileDialectMixError`.** A valid v4 canonical file is not followed by automatic translator detection. If a secondary layer fails ordinary v4 loading and its bounded raw-key failure check is unambiguously legacy, fail before merge and quote `lando4 app:config:translate --from lando3 --file <layer> --write`. Ambiguous valid-v4-shaped legacy content requires explicit conversion and is not promised automatic detection.

Neither check translates, plans, contacts a provider, or reads `~/.lando`.

## 8. Doctor checks

After the required ports and core implementations exist, the plugin contributes two read-only §10.9 checks through `DoctorCheckContext`. The context adds optional app identity, selected provider identity, a bounded resource name/label inspector, and a bounded executable-path locator. The locator performs filesystem/PATH resolution only and returns the normalized running executable basename plus the resolved candidate `lando` path. It does not read executable contents, execute a candidate, or read user/Lando state. Basename comparison treats `lando4` and case-insensitive Windows `lando4.exe` as the v4 name.

| Check | Behavior |
|---|---|
| `lando3-leftovers` | With app context, derive the Lando 3 project name and inspect for `<project>_*` volumes or containers labeled `io.lando.root=<root>`. On selected provider `docker` or actual id `podman`, use the bounded inspector. With no app context, emit informational skip. On managed provider `lando`, skip before any daemon call. A hit names resources and tells the user to back up or confirm data before removal with Lando 3. |
| `lando3-shadow` | When the normalized running basename is `lando4`, locate a PATH candidate named `lando` without executing it. A distinct path is an unverified informational potential shadow and recommends continued side-by-side use. No version or safety claim is made. Missing/ambiguous paths are informational only. |

The plugin MUST NOT import `@lando/container-runtime` for inspection. It MUST NOT add a proxy-port check. The shipped §10.2.3 preferred-port holder table already identifies Lando 3, and §20.10.3 `LegacyProxyContainerDetected` MUST be folded into or cross-referenced by that existing owner rather than duplicated.

## 9. Errors

All errors are `Schema.TaggedError` values with machine `_tag`, structured context, and human remediation:

| Error | Required context and remediation |
|---|---|
| `Lando3LandofileDetected` | App root and source file; quote `lando4 app:config:translate --from lando3 --write`. |
| `LandofileDialectMixError` | Canonical file and conflicting layer; quote `lando4 app:config:translate --from lando3 --file <layer> --write`. |
| `Lando3UnsupportedRecipeError` | Recipe id and source layer; run the app with Lando 3 or replace the recipe with explicit v4 services before conversion. |
| `Lando3LayerMergeError` | Layer, key path, and parse or merge detail; repair the named layer and rerun conversion. |

## 10. Testing

- **Unit:** §5.2 precision and recall against the copied Lando 3 corpus; every bundled recipe's generated Landofile as a negative; the same negatives with `runtime: 4` removed; the legacy array merge rule; naming including `adppo`, `lando-restart` to `landorestart`, and unicode `sluggy`; custom-name diagnostics; every translation-table row as a golden; per-layer output and recipe-layer folding; backup behavior; diagnostic ordering; byte determinism.
- **Reference:** `reference/kitchen-sink.lando.yml` MUST decode with zero unknown keys and detect positive.
- **Contract:** `makeConfigTranslatorContractSuite` runs against `lando3` in decode-only mode.
- **Planning:** Every supported translated fixture MUST load and plan on the `test` provider. Unsupported-version, hoster, malformed, unsafe, and intentionally rejected fixtures MUST remain rejected and are never counted as plan positives.
- **Guides:** `docs/guides/landofile/convert-from-lando-3.mdx` and the rewritten `docs/guides/tutorial/from-lando-3.mdx` are executable coverage.

No integration tier may require a Lando 3 binary.

## 11. Open items

None. US-619B1 through US-622B sequence this closed design.
