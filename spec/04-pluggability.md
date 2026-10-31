# Lando v4: Pluggability Catalog

> **Part 4 of 20** · [Index](./README.md)
> **Read next:** [05 Runtime Providers](./05-runtime-providers.md)

This part is the master contract index for replaceable abstractions, selection, registration, and conformance.

---

## 4. Pluggability Catalog

### 4.1 Pluggability principles

1. A service tag and its Schema-defined interface are the only way core consumes a capability.
2. Implementations are Effect Layers composed into the runtime Layer built by `makeLandoRuntime` at the imperative shell.
3. Plugin manifests register implementations; core wires their Layers.
4. Selection is config- or capability-driven, never import order or filesystem position.
5. A plugin replaces an abstraction in full. Cross-cutting behavior composes Layers explicitly; partial overrides do not exist.

### 4.2 The catalog

| Abstraction | Service tag | Default | Swap mechanism |
|---|---|---|---|
| Containerization | `RuntimeProvider` | `@lando/provider-lando` | `providers:`; select by app `provider:` or global `defaultProviderId`. One provider is selected per app. |
| File sync | `FileSyncEngine` | No engine on native providers; bundled `@lando/file-sync-mutagen` eligible for Windows prepared-volume targets | `fileSyncEngines:`; required support metadata gates eligibility independently of preference: global `defaultFileSyncEngine` → matching eligible `defaultFor` → sole eligible implementation (§4.3). No eligible automatic candidate means ordinary binds; explicit unsupported choices and ambiguity fail with `FileSyncSelectionError`. `passthrough` is a reserved no-session policy, not an engine; `appMount.accelerate: false` opts one service out. Neither ordinary path acquires an engine. Landofiles MUST NOT name an engine id. Engines MUST use provider ports and preserve lifecycle/scope semantics (§3.5, §5.4). |
| Tooling execution | `ToolingEngine` | Core `providerExec` and `host` | `toolingEngines:`; per-step/task/default/Landofile/global selection (§8.6). Core ids MUST NOT be replaced; implementations MUST pass the tooling-engine contract suite (§13.1). |
| Template rendering | `TemplateEngine` | Core `lando`; bundled `handlebars` and `mustache` whole-file engines | `templateEngines:`; explicit `engine`, extension, Landofile `defaultTemplateEngine`, then global config (§7.3.2). Only `lando` interpolates Landofile string values. |
| Console logging | `Logger` | Effect logger, quiet unless configured; TTY-pretty or JSON | `loggers:`; select by `--log-level`, `LANDO_LOG_LEVEL`, or `logLevel`; `--debug` raises the floor. |
| Output rendering | `Renderer` | `lando`, `plain`, `json`, `verbose` | `renderers:`; `--renderer`, `LANDO_RENDERER`, global `renderer:`, then the bundled `lando` default (§8.9). Event consumers MUST receive stderr-only narration IO. Implementations MUST pass `makeRendererContractSuite` / `runRendererContract` from `@lando/sdk/test`, exercised in each implementation's owning package (§13.1). |
| Schema validation | `SchemaValidator` | Effect Schema | Reserved and not user-swappable. |
| Config translation | `ConfigTranslator` | `lando4` decode/encode, `recipe` decode, bundled `lando3` decode-only | `configTranslators:`; explicit `app:config:translate`, `app:config:explain`, `app:config:migrate`, `apps:init`, or the §7.4.2 refresh phase for declared `translate:` entries whose translator is `refreshable`. Never discovery or normal loading. Implementations MUST pass the config-translator contract suite (§13.1). |
| CLI framework | `CommandFramework` | Native shared command registry/dispatcher (§8.4.1) | Replaceable, though not recommended; `@effect/cli` adapters are permitted. |
| Filesystem | `FileSystem` | `Bun.file`/`Bun.write` | Replace for sandbox or remote filesystem use. |
| Process execution | `ProcessRunner` | `Bun.spawn` | Replace for telemetry, sandbox, or dry-run. It remains argv-precise and MUST NOT imitate `ShellRunner` (§3.4). |
| Shell execution | `ShellRunner` | Embedded Bun Shell through an embedded `bun exec` self-spawn | `shellRunners:`; replace for audited, dry-run, or sandboxed shell behavior. It MUST NOT imitate `ProcessRunner` (§3.4). |
| Outbound HTTP | Effect `effect/http` `HttpClient` (§3.4) | `@lando/http-client` `layer`, the single Lando-owned egress boundary | `httpClients:` (`HttpClientContribution`: `id`, `module`, `enabledByDefault`, `summary`, `deprecated`; no capability discovery, the standard client surface is fixed); replacements provide the same Effect `HttpClient` tag and MUST preserve proxy/CA trust, scheme policy, redaction, cancellation, and route all Lando-owned egress (§10.3.2). |
| Verified downloads | `Downloader` | `@lando/http-client` downloader `layer` over `HttpClient`, `CacheService`, and `FileSystem` | `downloaders:`; bytes MUST flow through resolved `HttpClient`; checksum, containment, redaction, and atomic-write guarantees MUST remain (§10.3.3). |
| Privilege escalation | `PrivilegeService` | Platform `sudo`, `pkexec`, or UAC | Replace for `polkit`, `doas`, or custom credential flows. |
| CA / certificates | `CertificateAuthority` | `@lando/ca-mkcert` | `certificateAuthorities:`. |
| Router / routing | `RouterService` | `@lando/proxy-traefik` with id `traefik` | `routerServices:`. |
| Public tunnels / sharing | `TunnelService` | No always-on default; bundled quick-share implementation when installed | `tunnelServices:`; explicit `--provider`, Landofile/global default, then sole implementation. MUST use `HttpClient`, `Downloader`, `ProcessRunner`, and `StateStore` as specified, MUST NOT move app data, and MUST pass its contract suite (§10.2.2, §13.1). |
| Remote data sync | `RemoteSource` | No assumed bundled source; authored orchestration contract (§10.12) | `remoteSources:`; remote request, configured source, then sole implementation. MUST declare per-kind access/preference, resolve exact units per operation, enforce §10.12.8, and pass §13.1. Optional members/catalogs express tunnel and operation support. |
| Dataset | `Dataset` | Bundled `dotenv` plugin for `config`; no assumed bundled database/files/blob implementation | `datasets:`; binding id, service-type default, then sole implementation per kind. MUST use `DataMover`, stream scoped client capture, preserve private config landing, never move code, and pass §13.1. |
| Healthcheck runner | `HealthcheckRunner` | `RuntimeProvider.exec` | `healthcheckRunners:` for native or external probes. |
| App check kind | `CheckKind` | Built-in `http` over `HttpClient`, `command` over `RuntimeProvider.exec`/`ShellRunner`, `tcp` | `checkKinds:`; a kind observes only and declares its observation schema; judging stays declarative (§10.5.2). Implementations MUST pass the check-kind contract suite (§13.1). |
| App check profile | No service tag | Built-in router and web-server page rules | `checkProfiles:`; named declarative rule sets and checks, resolved into `CheckPlan` at plan time (§10.5.2). |
| Doctor diagnostics | `DoctorService` | Core app/provider checks | `doctorChecks:`; checks receive `DoctorCheckContext` and MUST pass the doctor-check contract suite (§10.9, §13.1). |
| Plugin source | `PluginSource` | Registry, git, local, tarball | `pluginSources:`; implementations MUST pass the plugin-source contract suite (§13.1). |
| Init source | `InitSource` | Built-in `cwd`, `git`, and `tarball` | `initSources:`; selected by `apps:init --source`. Implementations supply prompts, source auth, dynamic choices, and locators only; core acquires and commits, and implementations MUST pass the init-source contract suite (§8.8.13, §13.1). |
| Service type | `ServiceType` | Bundled canonical catalog (§6.11) | `serviceTypes:` adds or replaces types under collision rules. |
| Service feature | `ServiceFeature` | Plugin-only | `serviceFeatures:`. |
| App feature | `AppFeature` | Plugin-only | `appFeatures:`; selector-driven, app-scoped, and idempotent (§6.11.4). |
| Global service | No service tag | Plugin-only | `globalServices:` contributes `ServiceConfig`; `enabledByDefault` is overridden in `<userConfRoot>/global.config.yml` and by `meta:global:install`/`meta:global:uninstall` (§20). |
| Route filter | `RouteFilter` | `requestHeader`, `responseHeader`, `redirect`, `rewritePath`, `stripPrefix`, `addPrefix` | `routeFilters:`; implementations MUST pass the route-filter contract suite (§13.1). |
| Telemetry | `Telemetry` | Core collector, enabled by default | Sinks compose only through Telemetry and MUST honor disablement. |
| Update channel | `UpdateService` | Registry-channel updater | Replace for air-gapped or vendor-managed distributions. |
| Secret store | `SecretStore` | `env` (default bare ids), `lando` (persistent writable), `1password` (exclusive `op` owner) | `secretStores:`; schemes route to their owner, bare ids to `defaultSecretStore`. Contract includes ids-only `list` and metadata-only `describe`; writable stores add `put`/`remove`. `lando` is the only bundled persistent writable store (§9.5.1). |
| Interaction / prompts | `InteractionService` | Core implementation `layer`; CLI `auto`, library `non-interactive` | `interactionServices:`; replace for CI, recording/test, or GUI hosts. Secret redaction, answer precedence, non-interactive failure, and the interaction contract suite are mandatory (§8.10, §13.1). |

`EmbeddedAssetService`, `StateStore`, `PathsService`, `RedactionService`, the `@lando/sdk/probe` primitive, `DataMover`, `CodeSync`, `ManagedFileService`, and the private Bun self-execution wrapper (§2.1, §3.4, §8.2.4) are intentionally absent. Tests and embedding hosts may override services where documented, but plugins cannot replace these architecture, state-integrity, path, redaction, retry, data-movement, or working-tree-integrity invariants. No `stateStores:`, `redactors:`, `probes:`, `dataMovers:`, `managedFiles:`, or `bunSelfRunners:` contribution surfaces exist. Plugins receive namespaced `StateBucket` and managed-file access through `LandoPluginContext` (§9.8). Replaceable emitters and provider data planes MUST compose the canonical invariants and MUST NOT weaken them.

The host proxy (§10.10) is also intentionally absent and core-owned: its detached per-app dispatcher is unreachable by in-process overrides, owns the authentication/allowlist/containment boundary for container re-entry into Lando, and has no concrete replacement need. It has no public replaceable service tag or plugin contribution surface.

Core owns generic pull/push/switch orchestration and `CodeSync`; installed source and Dataset plugins supply the data plane, including the bundled `dotenv` plugin (§10.12). Neither `CodeSync` nor the scope-local `lando-session` secret store is a plugin replacement surface. This catalog specifies the design; release sequencing remains in `ROADMAP.md`.

`ExecutionSessionService` is core-owned and non-replaceable. Consumers use its SDK contract through existing command/tooling contributions; no new manifest family is introduced (§22).

### 4.3 Selection precedence

When an abstraction has multiple implementations, precedence is:

1. Explicit per-context choice.
2. Landofile global choice.
3. Global config, including `<userConfRoot>/config.yml`.
4. Plugin `defaultFor` capability/platform matchers.
5. Sole installed implementation.
6. Tagged failure naming the missing abstraction and suggested plugin.

No selection may depend on import or discovery order, and no abstraction may prefer an implementation by brand name. File sync has no per-context or Landofile engine choice (rules 1 and 2 do not apply). Eligibility requires the current host family in `supports.platform`, provider `fileSyncTargets: prepared-volume`, `two-way-safe` mode, and exclusion-pattern support. The provider target requirement applies to every accelerated engine, not an optional engine declaration. A `defaultFor` preference MUST NOT confer eligibility. Automatic selection considers eligible engines only: one matching default wins, otherwise a sole eligible engine wins. No eligible engine produces ordinary binds with `no-compatible-engine`; multiple matching defaults or multiple remaining eligible engines fail deterministically with `FileSyncSelectionError` and remediation.

When host policy is evaluated, an explicit non-`passthrough` id MUST be installed and eligible before ordinary-mode fast paths, including native providers. A valid explicit choice does not force native acceleration. Native automatic policy and global `passthrough` acquire no engine and probe no tools; an app with no app mounts or only opted-out app mounts need not select an engine. The engine-local `FileSyncPolicy` owns candidate metadata, selection inputs, and recorded app/service facts for planner, setup, and doctor. Consumers MUST NOT rebuild independent candidate lists. Standalone planners supply explicit policy/resolver layers at composition, and the planner layer captures its dependencies so its public methods need no ambient services.

Secret stores add one rule ahead of this list: a `${secret:...}` reference that carries a scheme (`op://...`) is owned by the store declaring that scheme, and only bare ids fall through to `defaultSecretStore` (explicit runtime option, then global config, then the bundled `env` store). Schemes are unique across installed plugins; a duplicate fails bootstrap rather than picking a winner. The reserved owners of `op`, `lando`, and `lando-session` remain fixed even when unavailable (§9.5.1).

### 4.4 Manifest contributions

Every contribution is declared under manifest `contributes:` and validated by §9.4. Registered keys include `providers`, `fileSyncEngines`, `toolingEngines`, `templateEngines`, `loggers`, `renderers`, `configTranslators`, `shellRunners`, `httpClients`, `downloaders`, `certificateAuthorities`, `routerServices`, `tunnelServices`, `remoteSources`, `datasets`, `healthcheckRunners`, `checkKinds`, `checkProfiles`, `doctorChecks`, `pluginSources`, `initSources`, `serviceTypes`, `serviceFeatures`, `appFeatures`, `globalServices`, `routeFilters`, `interactionServices`, and `secretStores`.

Descriptors name an `id` and MAY declare `module`, `defaultFor`, `capabilities`, `extensions`, `inputKinds`, or `tags` as their abstraction's schema permits. A `contributes.fileSyncEngines` entry is a `FileSyncEngineDescriptor`: `capabilities` and `supports` are required and planning-sensitive. `supports.platform` is a nonempty list of host families (`linux`, `darwin`, `win32`). `module` is optional when the plugin's contribution map supplies the `{ make(ctx) }` factory. Separate preference metadata `defaultFor` has typed dimensions `platform` and `bindMountPerformance` (`native`, `slow`); nonempty dimensions AND together, alternatives within one dimension OR, and an absent or empty matcher nominates nothing. The id `passthrough` is reserved and MUST NOT be contributed. Capability manifests retain the keys `verbs`, `offlineOnly`, `streaming`, `upload`, `offlinePolicy`, `schemes`, `atomicFileWrites`, `checksumAlgorithms`, `offlineCache`, `progressEvents`, `bindMountPerformance`, `modes`, `remoteAgentDeployment`, `exclusionPatterns`, `conflictReporting`, `progressReporting`, `wholeFile`, `stringInterpolation`, `partials`, and `unsafe`. A plugin contributes one lazily loaded Effect Layer per abstraction. After validation, `module` resolves to an absolute `file://` URL whose real path MUST remain inside the plugin root (§9.7).

### 4.5 Mandatory abstraction guarantees

Every plugin-facing abstraction MUST be:

- **Effect-typed:** methods return `Effect.Effect<A, E, R>` or `Stream<A, E, R>`; synchronous plugin methods are forbidden.
- **Schema-defined:** trust-boundary inputs and outputs use `Schema.Schema<A>`.
- **Tagged-error based:** failures are adjacent `Schema.TaggedError` contracts.
- **Capability-declared:** consumers validate typed capabilities before optional methods.
- **Resource-safe:** acquired resources use `Scope`; long operations support `Effect.interrupt`.
- **Idempotent where possible:** apply, register, install, and setup tolerate replay.
- **Deprecable:** members carry `DeprecationNotice` through schema annotation or `deprecated`; removal is release-gated (§18.5, §18.7).

---
