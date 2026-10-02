# Lando v4 — Plugin Specification

> **Part 10 of 18** · [Index](./README.md)
> **Read next:** [11 Subsystems](./11-subsystems.md)

A v4 plugin is a Bun-loadable package whose manifest declares its public contribution surface. The pluggable abstractions themselves are cataloged in §4.

---

## 9. Plugin Specification

### 9.1 Plugin identity

A plugin has a `package.json` with `name` and `version`, a manifest with `api: 4`, and optionally the `lando-plugin` package keyword for registry discovery. The manifest lives in `package.json#lando`, `plugin.yaml`, `plugin.yml`, `plugin.json`, `plugin.ts`, or `plugin.js`.

`PluginSource` adapters support registry packages, local `file:` directories, Git URLs or shorthands, remote tarballs, and plugins bundled into the compiled binary.

### 9.2 Plugin runtime rules

- Plugin entries SHOULD use ESM; Bun-loadable TypeScript and build outputs are accepted, and CommonJS is supported only through loader interop.
- Plugins run with host permissions; v4.0.0 provides no sandbox.
- Plugins receive `LandoPluginContext`, never internal core objects.
- Contributions MAY return Effect Layers, plain values, or factories; the loader normalizes them to Layers.
- Public contributions MUST be declared under `provides:`. Manifest validation, compatibility checks, and module containment occur before import.
- Module top levels SHOULD remain cheap and side-effect-light. Lazy import limits execution timing but cannot detect arbitrary JavaScript side effects.

### 9.3 Discovery order

CLI discovery precedence, from earliest to latest, is bundled plugins, system plugins under the system plugin root, user plugins under the user data root, app-local `pluginDirs:`, explicit app-scoped `plugins:`, then experimental plugins when enabled. Later sources override earlier sources unless dependency constraints reject the result; `disablePlugins:` removes plugins before resolution.

App-local plugins are trusted host code and do not receive a separate execution prompt. `pluginDirs:` are local-only. Explicit `plugins:` resolve during app materialization, install into an app-scoped store, and lock in `.lando.lock.yml` (§7.7.4). Routine startup MUST use the locked local copy and MUST NOT contact the source unless the lock changes, the cache is missing or corrupt, or the user explicitly updates it.

Library runtimes discover nothing by default and independently opt into bundled, system, user, and app sources (§16.4). Enabling all four produces CLI-equivalent discovery.

### 9.4 Manifest schema

The manifest is an Effect Schema validated before module import.

| Key | Meaning |
|---|---|
| `name` | Package identity and collision key. |
| `version` | Plugin version. |
| `api` | Plugin API version; v4 uses `4`. |
| `description` | Human-readable summary. |
| `enabled` | Default enablement. |
| `updateable` | Whether update management may update the plugin. |
| `channels` | Release channels in which updates may appear. |
| `cspace` | Plugin-owned command namespace. |
| `deprecated` | Plugin-wide `DeprecationNotice` (§18). |
| `config.schema` | Module exporting the plugin config schema. |
| `config.defaults` | Plugin configuration defaults. |
| `provides` | Manifest-declared public contributions. |
| `provides.providers` | Runtime providers and optional platform defaults. |
| `provides.serviceTypes` | Service-type resolvers or declarative service types. |
| `provides.serviceFeatures` | Single-service plan features. |
| `provides.appFeatures` | App-wide plan features. |
| `provides.globalServices` | Global-app service definitions (§20.4). |
| `provides.commands` | Canonical command contributions. |
| `provides.initSources` | `apps:init` sources. |
| `provides.routerServices` | Router implementations. |
| `provides.tunnelServices` | Public-sharing implementations (§10.2.2). |
| `provides.remoteSources` | Remote data transports (§10.12). |
| `provides.datasets` | Syncable data units (§10.12). |
| `provides.certificateAuthorities` | Certificate-authority implementations. |
| `provides.loggers` | Logger implementations. |
| `provides.renderers` | Renderer implementations. |
| `provides.rendererPanels` | Named default-renderer panel slots (§8.9.5). |
| `provides.toolingEngines` | Tooling program executors. |
| `provides.httpClients` | Lando-owned HTTP egress implementations (§10.3.2). |
| `provides.downloaders` | Verified artifact downloaders (§10.3.3). |
| `provides.interactionServices` | Prompt and answer transports (§8.10). |
| `provides.routeFilters` | Provider-neutral route transforms. |
| `provides.healthcheckRunners` | Healthcheck executors. |
| `provides.urlScanners` | URL readiness scanners. |
| `provides.pluginSources` | Plugin distribution adapters. |
| `provides.secretStores` | Secret resolution stores with owned reference schemes (§9.5.1). |
| `provides.configTranslators` | Explicit authoring-fragment translators (§7.4.1). |
| `provides.templateEngines` | Whole-file template engines (§7.3.2). |
| `provides.doctorChecks` | Isolated diagnostic checks. |
| `provides.messages` | Lifecycle message factories. |
| `subscribers` | Bounded lifecycle-event subscribers (§11.3.1). |
| `requires` | Core version, service, and capability requirements. |
| `conflicts` | Incompatible plugins. |

Contribution entries use schema-defined identity plus a contained `module` path where code is required. They MAY carry `deprecated`; loading registers notices and use emits `deprecation-used` under §18. Entry-specific fields include provider `defaultFor`; service-type `base`, `extends`, `schema`, `creds`, `artifacts`, `tooling`, and `features`; global-service `enabledByDefault`, `requires`, `conflicts`, `summary`, and `commands`; command `id`, `namespace`, `aliases`, and `topLevelAlias`; panel `id`, `slot`, and `watch`; translator `inputKinds`, `detects`, and `optionsSchema`; template `extensions` and `capabilities`; doctor-check `summary` and `tags`; secret-store `schemes`; and subscriber `id`, `selectors`, `priority`, `abortOnError`, and `configKey`.

Command ids MUST be canonical and namespaced. `namespace` MUST equal the id prefix and be `app`, `apps`, `meta`, or the plugin’s `cspace`. Plugins MUST NOT contribute under `plugin:` or reserved `meta:plugin:*`/`meta:global:*` namespaces. Namespaced aliases use `aliases`; bare aliases require `topLevelAlias` and follow §8.1.2 collision rules.

### 9.5 Contribution surfaces

| Surface | Loaded by | Architectural rule |
|---|---|---|
| `providers` | Provider registry | Implements `RuntimeProvider` (§5). |
| `serviceTypes` | App planner | Resolves or declaratively defines service types (§6.11). |
| `serviceFeatures` | Service planner | Mutates one service through published context. |
| `appFeatures` | App planner | Mutates selected services through published context. |
| `globalServices` | `GlobalAppService` | Contributes global-app services (§20.4). |
| `commands` | Command registry | Obeys namespace and alias rules (§8.1). |
| `initSources` | Init command | Supplies app initialization sources. |
| `routerServices`, `tunnelServices` | Networking subsystems | Implements routing or sharing contracts. |
| `remoteSources`, `datasets` | Remote-sync subsystem | Contract-only for Beta 1; implementation is deferred to 4.1 (§10.12). |
| `certificateAuthorities` | Certs subsystem | Implements certificate authority contracts. |
| `loggers`, `renderers`, `rendererPanels` | Output services | Implements logging, rendering, or frozen panel contracts. |
| `toolingEngines` | Tooling service | Executes compiled tooling graphs. |
| `httpClients`, `downloaders` | Egress services | Preserves the HTTP/download chokepoints. |
| `interactionServices` | Interaction service | Implements prompt transport and redaction guarantees. |
| `routeFilters`, `healthcheckRunners`, `urlScanners` | Runtime subsystems | Implements the corresponding published contract. |
| `pluginSources` | Plugin install | Resolves a distribution source. |
| `secretStores` | Routed `SecretStore` registry | Resolves the `${secret:...}` references whose scheme it owns, or bare ids when selected as default (§9.5.1). |
| `configTranslators` | Explicit conversion APIs | Produces authoring fragments, never runtime plans. |
| `templateEngines` | Template rendering | Renders whole files under §7.3 purity rules. |
| `doctorChecks` | `DoctorService` | Produces isolated diagnostics and remediation. |
| `messages`, `subscribers` | Lifecycle service | Produces messages or handles bounded events. |

There are no legacy autoload directories; every contribution enters through the manifest.

Contribution invariants:

- Config translators MUST declare unique identity and input kinds, run only on explicit request, decode ordered document sets or recipe requests into authoring fragments, and MUST NOT emit plans, perform IO, mutate files, contact providers, or install plugins. Duplicate ids fail without a precedence winner. Optional encoders MUST preserve expressions and secret references under §7.4.1 and §7.8.1.
- Template engines MUST declare identity, extensions, and capabilities. `lando` is reserved. Plugin engines MUST NOT claim Landofile string interpolation; unsafe engines require explicit opt-in and otherwise fail with `TemplateEngineUnsafeRejectedError`. Engines MUST implement the published tag and SHOULD provide the portable helper set.
- Renderer panels MUST declare valid id, slot, watch set, and contained module. Watch names are limited to the closed event taxonomy. Invisible panels remain unloaded; visible panels run isolated, bounded, and are dropped on load or identity failure as `PluginLoadError` (§8.9.5).
- Subscribers MUST use exact event selectors or the published command-terminal family, remain in the plugin priority band, default to non-aborting failure behavior, and MAY request only published config projections. Factories load on first matching event, run once, and cache their handler. Invalid shape is `PluginManifestError`; escaping modules fail with `PluginModulePathError`.
- Service types MUST declare `name`, `base`, and either a resolver module or the published declarative shape. Inheritance is single, bounded, acyclic, and references an earlier type. Landofile tooling overrides type tooling; reserved surviving names fail with `CommandAliasConflictError`. Type tooling MUST NOT claim top-level aliases. Credentials are exposed only when declared.
- App features MUST declare identity, module, priority, and activation or selectors; no-op entries are rejected. They MUST use published mutators, MUST declare provider-extension access, and MUST be idempotent across replanning.
- Global services MUST declare identity, module, default enablement, required capabilities, and conflicts. They MUST be pure service-config Effects, MUST NOT consume the active provider or perform network/process IO, and MUST reference a published service type. Listed commands MUST also exist in the same plugin’s `provides.commands`. Capability, collision, conflict, unknown-type, and command-reference failures remain tagged under §20. Plugins SHOULD pair global services with activating app features.
- Doctor checks MUST use bounded `DoctorCheckContext`, MUST NOT import container-runtime internals, MUST provide remediation or sufficient explanation, MUST redact secrets, and MUST fail in isolation rather than taking down the doctor run. Automatic fixes run only with explicit `--fix` (§10.9).
- Interaction services MUST truthfully declare prompt capabilities, preserve answer precedence and secret redaction, fail unsupported prompts with `InteractionUnavailableError`, never block on stdin in non-interactive mode, and pass the §13.1 interaction contract suite. `stdio` is reserved by core.
- Secret stores MUST declare `id`, `module`, and `schemes`, MUST NOT log, persist, or embed secret values, MUST fail with the §9.5.1 error trio and nothing broader, and MUST pass the §13.1 secret-store contract suite. Reference validation runs in the store before any backend call.
- Tunnel services MUST truthfully declare capabilities, accept app-local targets, keep arbitrary host-port forwarding behind an advanced option, route egress through `HttpClient`, provision connectors through `Downloader`, bind foreground processes to `Scope`, persist detached sessions in `StateStore`, use §10.5.1 probing, redact URLs, tokens, codes, and paths, and pass the §13.1 tunnel contract suite. v4.0 has no core default tunnel service.

#### 9.5.1 SecretStore contribution

A plugin contributes stores under manifest `contributes.secretStores[]`, each entry `{ id, module, schemes }` plus optional `summary` and `deprecated`. `schemes` is the list of `${secret:<scheme>://...}` prefixes the store owns; it MAY be empty for stores that only serve bare ids. The module exports `secretStores`, a map from `id` to a lazily loaded `SecretStore` Layer that MAY require `ProcessRunner`, `PathsService`, and `FileSystem`. A manifest id the module does not export is `PluginManifestError`.

The engine composes every installed store, including the built-in `env` store, into one routed `SecretStore` (§4.3). Schemes are unique across installed plugins; a duplicate is a bootstrap error naming both plugins, never a precedence winner. The router parses each reference with the §7.3.1 grammar, sends scheme references to the owning store, sends bare ids to `defaultSecretStore` (default `env`), and fails unknown schemes or an uninstalled default with `SecretReferenceInvalidError`.

The store contract is `id`, `schemes`, `get`, `has`, and `list`:

- `get` fails with `SecretNotFoundError`, `SecretStoreUnavailableError { storeId, reason }` with `reason` one of `locked`, `unauthenticated`, `denied`, `timeout`, or `cli-missing`, or `SecretReferenceInvalidError { reference }`. The union is exported as `SecretStoreError`; every failure carries remediation.
- `has` is fallible: a store that cannot reach its backend fails with `SecretStoreUnavailableError` rather than answering `false`.
- `list` returns ids only. A CLI-backed store returns only the references it resolved in the current process; it MUST NOT enumerate the backend.
- Values are never logged, never written to `StateStore`, caches, journals, transcripts, or telemetry, and never embedded in errors. Any in-process cache is process-lifetime only.
- Resolved values are registered with the canonical redactor (§3.7) before the resolving operation emits any event, result, transcript, or failure; consumers that resolve secrets (`resolveServiceEnvironmentSecrets`, `ShellInteractiveSpec.resolveSecret`, start, rebuild, scratch, and global flows) propagate `SecretStoreError` untouched through their tagged result channels.

Bundled stores:

| Store id | Schemes | Contract |
|---|---|---|
| `env` | none | Default store. Resolves bare ids from the Lando process environment; `list` returns the ids present. |
| `1password` | `op` | Plugin `@lando/secret-store-1password`. `get` validates the reference locally, requires scheme `op`, then runs `op read --no-newline <ref>` through `ProcessRunner` under a bounded, cancellable timeout long enough for a biometric or desktop-app prompt. Successful references are cached in process only, never persisted. Failures are classified from exit status and stderr into the error trio (`not signed in` is `unauthenticated`, lock prompts are `locked`, permission text is `denied`, deadline is `timeout`, missing binary is `cli-missing`, missing item is `SecretNotFoundError`); errors never include stdout or raw stderr. Non-interactive hosts authenticate through `OP_SERVICE_ACCOUNT_TOKEN` or `OP_CONNECT_*`, which pass through untouched and are redacted. |

### 9.6 Plugin install and update

`meta:plugin:add` (`lando plugin add`) resolves through `PluginSource`, validates the manifest, checks dependencies and API compatibility, installs through the embedded Bun execution contract (§3.4), and invalidates plugin and command caches. `meta:plugin:remove` (`lando plugin remove`) removes the selected user plugin and refreshes the same caches. A standalone Bun installation MUST NOT be required; library mode MAY use system Bun only when no embedded Bun exists.

Install scripts are disabled by default. They MAY run only for explicitly trusted package identities or authoring roots; Git installs require per-install trust. Grants remain until removed by `meta:plugin:trust:revoke`, and `meta:plugin:trust:list` exposes current grants. Registry, Git, and local trust domains MUST NOT imply one another. Install lifecycle events MUST be observable, cancellable, and redacted.

`meta:update` (`lando update`) checks plugin channels `stable`, `next`, and `dev` through `UpdateService`, honors manifest channel constraints, and updates plugins through the same install path. Binary self-update remains the separate §17.6 protocol.

Plugin login/logout stores registry credentials in the plugin-auth store. Tokens MUST travel only through child environment, MUST NOT appear in argv, and MUST be redacted from lifecycle events and non-debug logs.

App-declared plugins install only into their app-scoped store, use the same trust and validation path, and mirror their lock into `.lando.lock.yml`; they MUST NOT enter the user-global plugin set.

### 9.7 Plugin loading rules

- Manifest validation, source resolution, compatibility, module resolution, and realpath containment precede import.
- Bundled modules are statically included; external modules use absolute file URLs. Cwd-relative imports and paths escaping the plugin root are forbidden.
- App-scoped plugins load only from their lockfile-selected local copy.
- The validated plugin-command cache is the sole command-metadata owner. It follows discovery precedence, invalidates on plugin-set or manifest change, and MUST NOT be treated as an executable registry.
- Duplicate command ids retain the first occurrence in resolved manifest order. Executable plugin command loaders remain lazy and keyed by canonical id.
- Native top-level dispatch of plugin-contributed commands is deferred until a public command implementation contract exists; command steps MAY invoke their lazy implementation.
- Each contribution module loads on first use. Config translators load only for explicit translation requests.
- Layer results compose into the runtime; plain objects are wrapped as Layers.
- A throwing module becomes `PluginLoadError`, marks that plugin unhealthy, and MUST NOT prevent unrelated plugins from loading.
- Experimental-source runtime loading is not implemented; when added, it MUST join the same cache at final discovery precedence.

### 9.8 The `LandoPluginContext`

| Member | Access granted |
|---|---|
| `id`, `version`, `config` | Plugin identity and decoded configuration. |
| `cwd`, `userConfRoot`, `userCacheRoot`, `userDataRoot`, `platform` | Validated host context and roots. |
| `logger` | Host logger. |
| `stateStore` | Durable store pre-rooted to `plugins/<id>` (§12.7). |
| `managedFiles` | Managed-file view pre-namespaced to `owner:<id>` (§10.13). |
| `events.publishRender` | Publish-only access to the closed `RenderEvent` union (§8.9). |

`stateStore` MUST prevent access to core or other-plugin state, and plugins MUST NOT hand-roll atomic writes or lockfiles outside it. `managedFiles` MUST prevent cross-owner remove, adopt, or release operations. `events.publishRender` schema-validates and redacts events and does not expose arbitrary publish, subscribe, wait, or query access. Plugins never receive `LandoRuntimeLive`; they receive only declared services.

### 9.10 Plugin authoring toolkit

Core provides `meta:plugin:new`, `meta:plugin:test`, `meta:plugin:build`, `meta:plugin:link`, `meta:plugin:unlink`, and `meta:plugin:publish`. These are not contribution surfaces and have no default top-level aliases. Templates cover service types, providers, tooling engines, template engines, route filters, config translators, recipes, and bare plugins, and MUST emit a buildable, testable, linkable v4 package.

Authoring commands MUST route Bun work through the embedded Bun contract, MUST keep changes within the plugin store or selected source tree, MUST NOT mutate global config or app lifecycle, and MUST keep generated plugin top-level imports within cold-start policy. Link trust applies only to explicitly permitted authoring roots and MUST NOT trust registry extraction paths. Publishing MUST rebuild stale artifacts, test unless explicitly skipped, revalidate manifest and contained module paths, keep tokens out of argv, and support a non-publishing dry run.

---
