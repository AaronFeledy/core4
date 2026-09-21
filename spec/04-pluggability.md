# Lando v4 — Pluggability Catalog

> **Part 4 of 18** · [Index](./README.md)
> **Read next:** [05 Runtime Providers](./05-runtime-providers.md)

This part is the master contract index for replaceable v4 abstractions, selection, registration, and conformance.

---

## 4. Pluggability Catalog

### 4.1 Pluggability principles

1. A service tag and its Schema-defined interface are the only way core consumes a capability.
2. Implementations are Effect Layers composed into `LandoRuntimeLive` at the imperative shell.
3. Plugin manifests register implementations; core wires their Layers.
4. Selection is config- or capability-driven, never import order or filesystem position.
5. A plugin replaces an abstraction in full. Cross-cutting behavior composes Layers explicitly; partial overrides do not exist.

### 4.2 The catalog

| Abstraction | Service tag | Default | Swap mechanism |
|---|---|---|---|
| Containerization | `RuntimeProvider` | `@lando/provider-lando` | `providers:`; select by app `provider:` or global `defaultProvider`. One provider is selected per app. |
| File sync | `FileSyncEngine` | Eager `passthrough`; bundled `@lando/file-sync-mutagen` for slow mounts | `fileSyncEngines:`; provider `bindMountPerformance` → `defaultFor` → `defaultFileSyncEngine` → sole implementation. Landofiles MUST NOT require an engine id; `accelerate: false` and `passthrough` are expert escape hatches. Engines MUST NOT call runtimes directly and must preserve lifecycle/scope semantics (§3.5, §5.4). |
| Tooling execution | `ToolingEngine` | Core `providerExec` and `host` | `toolingEngines:`; per-step/task/default/Landofile/global selection (§8.6). Core ids MUST NOT be replaced in v4.0; implementations MUST pass the tooling-engine contract suite (§13.1). |
| Template rendering | `TemplateEngine` | Core `lando`; bundled `handlebars` and `mustache` whole-file engines | `templateEngines:`; explicit `engine`, extension, Landofile `defaultTemplateEngine`, then global config (§7.3.2). Only `lando` interpolates Landofile string values. |
| Console logging | `Logger` | Effect logger, quiet unless configured; TTY-pretty or JSON | `loggers:`; select by `--log-level`, `LANDO_LOG_LEVEL`, or `logLevel`; `--debug` raises the floor. |
| Output rendering | `Renderer` | Built-in default | `renderers:`; `--renderer`, `LANDO_RENDERER`, then TTY/CI detection. |
| Schema validation | `SchemaValidator` | Effect Schema | Reserved and not user-swappable in v4.0. |
| Config translation | `ConfigTranslator` | `lando4` decode/encode, `recipe` decode, bundled `lando3` decode-only | `configTranslators:`; explicit `app:config:translate`, `app:config:explain`, `app:config:migrate`, or `apps:init` only. Never bootstrap or normal loading. Implementations MUST pass the config-translator contract suite (§13.1). |
| CLI framework | `CommandFramework` | Native shared command registry/dispatcher (§8.4.1) | Replaceable, though not recommended; `@effect/cli` adapters are permitted. |
| Filesystem | `FileSystem` | `Bun.file`/`Bun.write` | Replace for sandbox or remote filesystem use. |
| Process execution | `ProcessRunner` | `Bun.spawn` | Replace for telemetry, sandbox, or dry-run. It remains argv-precise and MUST NOT imitate `ShellRunner` (§3.4). |
| Shell execution | `ShellRunner` | `Bun.$` | `shellRunners:`; replace for audited, dry-run, or sandboxed shell behavior. It MUST NOT imitate `ProcessRunner` (§3.4). |
| Bun self-execution | `BunSelfRunner` | Compiled binary with `BUN_BE_BUN=1`; system Bun fallback in library mode | `bunSelfRunners:`; replacements MUST preserve verbs `install`, `add`, `remove`, `x`, `create`, `runScript`, `buildLib`, `publishPkg`, redaction, and recursion guards (§3.4). |
| Outbound HTTP | `HttpClient` | `HttpClientLive` | `httpClients:`; replacements MUST preserve proxy/CA trust, scheme policy, redaction, cancellation, and route all Lando-owned egress (§10.3.2). |
| Verified downloads | `Downloader` | `DownloaderLive` over `HttpClient`, `CacheService`, and `FileSystem` | `downloaders:`; bytes MUST flow through resolved `HttpClient`; checksum, containment, redaction, and atomic-write guarantees MUST remain (§10.3.3). |
| Privilege escalation | `PrivilegeService` | Platform `sudo`, `pkexec`, or UAC | Replace for `polkit`, `doas`, or custom credential flows. |
| CA / certificates | `CertificateAuthority` | `@lando/ca-mkcert` | `certificateAuthorities:`. |
| Router / routing | `RouterService` | `@lando/proxy-traefik` with id `traefik` | `routerServices:`. |
| Public tunnels / sharing | `TunnelService` | No always-on default; bundled quick-share implementation when installed | `tunnelServices:`; explicit `--provider`, Landofile/global default, then sole implementation. MUST use `HttpClient`, `Downloader`, `ProcessRunner`, and `StateStore` as specified, MUST NOT move app data, and MUST pass its contract suite (§10.2.2, §13.1). |
| Remote data sync | `RemoteSource` | None in v4.0; generic remotes deferred to 4.1 | `remoteSources:`; select by remote request, `remotes.<name>.source`, then sole implementation. MUST use `HttpClient`, delegate local landing to `Dataset`/`DataMover`, protect push targets, and pass its contract suite (§10.12, §13.1). |
| Dataset | `Dataset` | None in v4.0; files and database datasets deferred to 4.1 | `datasets:`; bind resolved datasets to services. MUST use `DataMover`, pass DB credentials through env, remain replay-safe, and pass its contract suite (§10.12, §13.1). |
| Healthcheck runner | `HealthcheckRunner` | `RuntimeProvider.exec` | `healthcheckRunners:` for native or external probes. |
| URL scanner | `UrlScanner` | Built-in over `HttpClient` | `urlScanners:`. |
| Doctor diagnostics | `DoctorService` | Core app/provider checks | `doctorChecks:`; checks receive `DoctorCheckContext` and MUST pass the doctor-check contract suite (§10.9, §13.1). |
| Host proxy | `HostProxyService` | `HostProxyServiceLive` | `hostProxyServices:`; replace for headless, audited, or remote transports (§10.10). |
| Plugin source | `PluginSource` | Registry, git, local, tarball | `pluginSources:`; implementations MUST pass the plugin-source contract suite (§13.1). |
| Init source | `InitSource` | Plugin-only | `initSources:`. |
| Service type | `ServiceType` | Bundled canonical catalog (§6.11) | `serviceTypes:` adds or replaces types under collision rules. |
| Service feature | `ServiceFeature` | Plugin-only | `serviceFeatures:`. |
| App feature | `AppFeature` | Plugin-only | `appFeatures:`; selector-driven, app-scoped, and idempotent (§6.11.4). |
| Global service | No service tag | Plugin-only | `globalServices:` contributes `ServiceConfig`; `enabledByDefault` is overridden in `<userConfRoot>/global.config.yml` and by `meta:global:install`/`meta:global:uninstall` (§20). |
| Route filter | `RouteFilter` | `requestHeader`, `responseHeader`, `redirect`, `rewritePath`, `stripPrefix`, `addPrefix` | `routeFilters:`; implementations MUST pass the route-filter contract suite (§13.1). |
| Telemetry | `Telemetry` | Core collector, enabled by default | Sinks compose only through Telemetry and MUST honor disablement. |
| Update channel | `UpdateService` | Registry-channel updater | Replace for air-gapped or vendor-managed distributions. |
| Secret store | `SecretStore` | Environment-variable store | Replace with Vault, 1Password CLI, AWS SM, or peers; implementations MUST pass the secret-store contract suite (§13.1). |
| Interaction / prompts | `InteractionService` | `InteractionServiceLive`; CLI `auto`, library `non-interactive` | `interactionServices:`; replace for CI, recording/test, or GUI hosts. Secret redaction, answer precedence, non-interactive failure, and the interaction contract suite are mandatory (§8.10, §13.1). |

`EmbeddedAssetService`, `StateStore`, `PathsService`, `RedactionService`, the `@lando/sdk/probe` primitive, `DataMover`, and `ManagedFileService` are intentionally absent. Tests and embedding hosts may override services where documented, but plugins cannot replace these architecture, state-integrity, path, redaction, retry, data-movement, or working-tree-integrity invariants. No `stateStores:`, `redactors:`, `probes:`, `dataMovers:`, or `managedFiles:` contribution surfaces exist. Plugins receive namespaced `StateBucket` and managed-file access through `LandoPluginContext` (§9.8). Replaceable emitters and provider data planes MUST compose the canonical invariants and MUST NOT weaken them.

The `RemoteSource`/`Dataset` split is contract-only for v4.0; implementation and `lando pull`/`push` are deferred to 4.1.

### 4.3 Selection precedence

When an abstraction has multiple implementations, precedence is:

1. Explicit per-context choice.
2. Landofile global choice.
3. Global config, including `<userConfRoot>/config.yml`.
4. Plugin `defaultFor` capability/platform matchers.
5. Sole installed implementation.
6. Tagged failure naming the missing abstraction and suggested plugin.

No selection may depend on import or discovery order.

### 4.4 Manifest contributions

Every contribution is declared under manifest `provides:` and validated by §9.4. Registered keys include `providers`, `fileSyncEngines`, `toolingEngines`, `templateEngines`, `loggers`, `renderers`, `configTranslators`, `shellRunners`, `bunSelfRunners`, `httpClients`, `downloaders`, `certificateAuthorities`, `routerServices`, `tunnelServices`, `remoteSources`, `datasets`, `healthcheckRunners`, `urlScanners`, `doctorChecks`, `hostProxyServices`, `pluginSources`, `initSources`, `serviceTypes`, `serviceFeatures`, `appFeatures`, `globalServices`, `routeFilters`, and `interactionServices`.

Each entry names `id` and `module` and MAY declare `defaultFor`, `capabilities`, `extensions`, `inputKinds`, or `tags`. Capability manifests retain the keys `verbs`, `offlineOnly`, `streaming`, `upload`, `offlinePolicy`, `schemes`, `atomicFileWrites`, `checksumAlgorithms`, `offlineCache`, `progressEvents`, `bindMountPerformance`, `modes`, `remoteAgentDeployment`, `exclusionPatterns`, `conflictReporting`, `progressReporting`, `wholeFile`, `stringInterpolation`, `partials`, and `unsafe`. A plugin contributes one lazily loaded Effect Layer per abstraction. After validation, `module` resolves to an absolute `file://` URL whose real path MUST remain inside the plugin root (§9.7).

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
