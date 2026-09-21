# Lando v4 — Service Specification

> **Part 6 of 18** · [Index](./README.md)
> **Read next:** [07 Landofile and Configuration](./07-landofile-and-config.md)

This part defines the provider-neutral v4 service model, its composition contracts, canonical service types, build lifecycle, and log sources.

---

## 6. v4 Service Specification

### 6.1 Model

A service is a planned runtime component composed from one base and an ordered set of features.

| Base | Contract |
|---|---|
| `l337` | Artifact and build plumbing only. It is the low-level escape hatch and provides no `/etc/lando/*` scaffolding, opinionated environment, packages, or app mount. |
| `lando` | Opinionated development service with boot scaffolding, environment, packages, build steps, app mounts, healthchecks, certificates, SSH agent, and hooks. It is the default when `type:` is omitted. |

Composition is normative. A `ServiceType` resolves to `ServiceTypeResolution`; the core planner composes its `base`, `normalizedConfig`, and priority-ordered `features` into a `ServicePlan`. A type that builds a plan directly is non-conforming and bypasses inheritance, `AppFeature` injection, and feature conformance (§6.11).

`api: 4` is the only service API. Core defaults it after confirming that the Landofile targets v4; no `api: 3` path exists.

A service inherits the app provider. Per-service provider configuration is non-portable and belongs under `services.<name>.providers.<id>`. `ServicePlan.provider` records the resolved app provider.

### 6.2 Common service schema

`ServiceConfigInput` accepts the supported Compose service-key subset (§7.4) alongside Lando keys and decodes to canonical `ServiceConfig`. Unsupported or rejected Compose keys fail validation unless an explicit provider extension owns them.

- `image:` and Compose `build:` normalize to `artifact:`. Compose-build fields and Lando build-script fields (`artifact:`, `app:`) are shape-discriminated; mixing them fails with a tagged error and remediation.
- `command:`, `entrypoint:`, `user:`, `working_dir:`/`workingDirectory`, `environment:`, and `env_file:`/`envFile` normalize to execution and environment fields. Environment input never inherits unset host values. A null label value becomes an empty string.
- `volumes:` short and long forms normalize to `mounts`, `storage`, or `tmpfs` according to source and type.
- `ports:` and `expose:` normalize to `endpoints`; host bindings require provider capability.
- `depends_on:` list and condition-map forms normalize to `dependsOn`. `service_started`, `service_healthy`, and `service_completed_successfully` retain their lifecycle meaning (§6.13).
- Compose `healthcheck:` normalizes to the §6.7 model.
- `restart`, `cap_add`, `cap_drop`, `privileged`, `devices`, `ulimits`, `sysctls`, `tmpfs`, `shm_size`, `dns`, `dns_search`, `dns_opt`, `extra_hosts`, `init`, `stop_signal`, `stop_grace_period`, `security_opt`, `group_add`, `read_only`, `platform`, `pull_policy`, `logging`, `gpus`, and `deploy.resources` are preserved in `ServicePlan.extensions.compose` and capability-checked (§5.5.1).
- Supported `networks:`, `configs:`, `secrets:`, `labels:`, and `profiles:` forms are preserved and capability-checked. Service-level `x-*` fields remain inert (§5.4).
- Rejected keys, including `extends`, `container_name`, `network_mode`, `links`, and Swarm orchestration fields, fail with a tagged error and remediation; they are never silently dropped.

Lando keys include `api`, `type`, `primary`, `artifact`, `appMount`, `mounts`, `storage`, `home`, `endpoints`, `routes`, `healthcheck`, `logs`, `certs`, `hostnames`, `security`, `build`, `packages`, and `providers`. Where a Compose spelling and a more specific Lando spelling conflict, the Lando value wins and `lando app config` SHOULD report the resolution.

`BuildScriptStep` is a command string or `{ run, user? }`; `BuildScript` is one step or an ordered list.

The published boundary retains the named component contracts `ArtifactInput`, `CommandInput`, `UserInput`, `PortablePath`, `AppMountInput`, `MountInput`, `StorageInput`, `EndpointInput`, `RouteInput`, `HealthcheckInput`, `LogSourceInput`, `CertsInput`, `CaInput`, and `ProviderId`.

### 6.3 Artifact build

`artifact:` accepts an existing artifact reference, an external `sourcefile:` plus context, or inline provider-neutral build intent. Inline intent includes `source`, `tag`, `context`, `args`, `secrets`, `ssh`, `platform`, `groups`, and `steps`.

Build instructions use named, weighted, user-scoped groups. Final order follows group weight and step weight. Service types, features, fragments (§7.7), and Landofile input contribute steps; recipes contribute only through the Landofile they scaffold. Group overrides may select a group, relative offset, before/after placement, and user; their concrete grammar is schema-owned.

`build.artifact:` and `build.app:` preserve every step's resolved user through `BuildPlan`, provider execution, and ordered `buildKey` hashing. Omitted users resolve to the planned service user; an explicit step user overrides its group's user. Interleaved users are valid. Artifact generation switches users only when required and restores the final service user; app steps pass the resolved user to `execStream`.

`sourcefile:` is the provider-neutral external build-definition key. Compose build fields normalize when possible; other provider aliases belong in provider schemas. Build secrets and SSH require `buildSecrets` and `buildSsh`. Artifact tags are not assumed globally meaningful or pushable.

### 6.4 App mounts and mounts

`appMount:` accepts `false`/`disabled`, a destination string, or a full `MountInput`. When active, planning sets `workingDirectory`, exports `LANDO_APP_ROOT` and `LANDO_PROJECT_MOUNT`, and records the result in `ServiceInfo`.

| Mount type | Contract | Capability |
|---|---|---|
| `bind` | Live host path | `bindMounts` |
| `copy` | Host path copied during artifact build | `copyMounts` |
| `inline` | Literal content written at the destination | Always |
| `template` | `TemplateEngine` output materialized as `inline` | Always |
| `disabled` | Explicitly disables an inherited mount | No-op |

Template mounts use app-root-relative `source`, optional `engine`, `vars`, and `mode`. Sources obey include containment (§7.7.6). Engine selection is explicit, then extension-based, then `lando`; values resolve through the standard expression context. Providers receive only rendered `inline` mounts. Rendered output uses the `<userCacheRoot>/templates/<engineId>/...` `template-render` cache (§12.1).

For bind excludes, planning creates storage shadows; `!` entries re-include paths. Copy includes become binds. Ordering preserves nested-path semantics.

Every bind `MountPlan` has `realization: passthrough | accelerated` selected from `bindMountPerformance` (§5.4):

- `native` uses provider binds and no `FileSyncEngine` or `pre-file-sync-*` events.
- `slow` uses a provider-managed `lando-sync-<app-id>-<service>-<mountKeyHash>` volume and a `FileSyncSessionSpec`; the bundled engine is `@lando/file-sync-mutagen` (§4.2).
- `none` fails with `CapabilityError`.

The realization is invisible in canonical config and MUST NOT expose engine or session ids. Accelerated engines with `exclusionPatterns` receive excludes; otherwise planning retains storage shadows. Excludes are never silently dropped.

`mountKey` is stable for canonical source, destination, type, and excludes and correlates the mount, sync volume, `FileSyncSessionSpec`, `file-sync-sessions` cache, and lifecycle events. Changing excludes changes the key.

### 6.5 Storage

Storage declarations use `destination`, optional `source`, `scope`, `type`, `owner`, `permissions`, `kind`, and `key`.

`home: false | { path? }` controls planned-user home persistence and is enabled by default. Known catalog user/home metadata creates one idempotent service-scoped store. Unknown custom images fail with `HomePathCapabilityError` before provider action unless home storage is disabled or an explicit path is supplied. Equivalent authored storage is deduplicated. Home contents MUST NOT affect build keys. Legacy `/lando`, `/helpers`, and user-config-directory mounts MUST NOT return.

| Scope | Lifetime |
|---|---|
| `service` | One service in one app; default |
| `app` | Shared within one app |
| `global` | Shared across apps when supported; survives `lando destroy` |

`scope: project` is not accepted. A `ConfigTranslator` MAY rewrite it to `app` (§7.4.1).

`kind: data` is the default. `kind: cache` defines a named cross-app dependency cache, auto-named `lando-cache-<key>` with `key` defaulted from the destination, labeled `dev.lando.storage-kind: "cache"`, and removed only by `lando destroy --purge-caches` or `meta:cache:*`. Cache kind is global by nature; combining it with `scope: service` is a planning error. It is distinct from data movement (§10.11).

Without `source`, names are `lando-<kebab(destination)>` for `global`, `<project>-<kebab(destination)>` for `app`, and `<project>-<service>-<kebab(destination)>` for `service`.

Providers with volume labels MUST use `dev.lando.storage-volume: "TRUE"`, `dev.lando.storage-scope`, `dev.lando.storage-project`, and `dev.lando.storage-service`. The `dev.lando.*` namespace is reserved. Destroy removes matching project/service volumes but not global volumes.

Global-app storage substitutes `global` for project identity and adds `dev.lando.storage-global-app: "TRUE"`; service and app names are `global-<service>-<destination>` and `global-<destination>`. Only global scope survives `meta:global:destroy --purge` (§20.9).

Scratch storage substitutes `<scratch-id>`, producing `<scratch-id>-<service>-<destination>` and `<scratch-id>-<destination>`, labels volumes with `dev.lando.scratch: "TRUE"` and `dev.lando.scratch-id`, and rewrites global scope to app scope unless `--share-global-storage` is present. Scratch destroy removes effective service/app storage unless `--keep-volumes` is used (§21).

### 6.6 Endpoints, hostnames, and routes

`EndpointInput` and `EndpointPlan` are discriminated unions. `InternalEndpoint` carries a network protocol and port or a Unix `socketPath`. `PublishedEndpoint` permits `http`, `https`, `tcp`, or `udp` and requires `publication`; `{}` requests defaults. Default bind is `127.0.0.1`; omitted `hostPort` requests provider assignment. Runtime assignments live in endpoint materialization and never rewrite desired state. Unix sockets cannot be published.

`hostnames:` adds provider-network aliases. The planner adds `<service>.<app>.internal` when `sharedCrossAppNetwork` is supported.

Routes live under top-level `proxy:` or preferred service `routes:`. Every `RoutePlan` has a resolved `backend` with service, protocol, and port; proxies MUST NOT guess. Shorthand normalizes to `hostname`, `scheme`, `endpoint`, `pathPrefix`, and `filters`; invalid forms fail with source-aware remediation. Filters merge by `name`, then unnamed type identity, and retain authored order. Prefix stripping MUST NOT be implicit (§10.2).

Built-in route filters are `requestHeader`, `responseHeader`, `redirect`, `rewritePath`, `stripPrefix`, `addPrefix`, `auth.basic`, and `rateLimit`. Plugins contribute `routeFilters:`.

Default route hostnames are `<service>.<app>.<domain>`, with `lndo.site` as the configurable domain. LAN publication is opt-in and warns. Internal endpoints never bind the host.

Scratch plans apply `RouteFilter.ScratchHostnameSuffix` unless suppressed by `--hostname` or `--no-hostname-suffix` (§21.9.2).

### 6.7 Healthchecks

`HealthcheckInput` accepts `false`, command forms, or an object. `false` disables checks; `load()` MAY provide any form (§7.3). `HealthcheckRunner` executes `HealthcheckPlan`; the default uses `RuntimeProvider.exec`. `lando start` distinguishes running from ready, and readiness subscribers use `post-start` priority `ready`.

### 6.8 Certificates and security

`certs:` accepts enabled, disabled, a certificate path, or custom certificate/key paths. `CertificateAuthority` generates leaf certificates covering the service name, `<service>.<app>.internal`, configured hostnames, route hostnames, `localhost`, and `127.0.0.1`. Paths are exposed as `LANDO_SERVICE_CERT` and `LANDO_SERVICE_KEY`.

`security.ca:` and aliases `cas`, `certificate-authority`, and `certificate-authorities` add project CAs. The `lando.security` feature mounts and installs them; core defines intent, not distribution mechanics.

Global `network.ca` and `network.proxy` each expose `injectIntoServices`. CA injection defaults on; proxy injection defaults off. Per-service `security.inheritNetworkCa` and `security.inheritNetworkProxy` override those defaults. Only services composing `lando.security` participate; `l337` and raw Compose do not auto-inject.

The effective CA set is global `network.ca.certs`/`LANDO_NETWORK_CA_CERTS` followed by project CAs, deduplicated by content. Open-ended host Dockerfile drop-ins are a non-goal. Installation precedes `build.app:` and tooling. Injected CA identity participates in artifact `buildKey` calculation. Providers MUST honor resolved proxy/CA settings for every Lando-initiated pull and build regardless of service injection.

When CAs are injected, services expose `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `LANDO_CA_BUNDLE`, and `LANDO_CA_DIR`; service types MAY add equivalents. Proxy injection writes `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`; credentials MUST be redacted from logs, telemetry, caches, rendered config, and build transcripts.

### 6.9 Service environment variables

Core publishes the reserved `LANDO`/`LANDO_*` catalog used by `appEnv` validation (§7.5). Plugins use `LANDO_PLUGIN_<NAME>_*`. Credentials use typed families, never aggregate JSON. `LANDO_HOST_IP` is omitted unless provider capability and gateway data permit it.

Always when applicable: `LANDO`, `LANDO_DEBUG`, `LANDO_HOST_OS`, `LANDO_HOST_USER`, `LANDO_HOST_UID`, `LANDO_HOST_GID`, `LANDO_HOST_HOME`, `LANDO_APP_NAME`, `LANDO_APP_KIND`, `LANDO_APP_ROOT`, `LANDO_PROJECT`, `LANDO_PROJECT_MOUNT`, `LANDO_SERVICE_API`, `LANDO_SERVICE_NAME`, `LANDO_SERVICE_TYPE`, and `LANDO_DOMAIN`.

Conditional keys are `LANDO_HOST_IP`, `LANDO_SERVICE_CERT`, `LANDO_SERVICE_KEY`, `LANDO_CA_CERT`, `LANDO_CA_DIR`, `LANDO_CA_BUNDLE`, `LANDO_USER`, `LANDO_UID`, `LANDO_GID`, `SSH_AUTH_SOCK`, `LANDO_HOST_PROXY_SOCKET`, `LANDO_HOST_PROXY_TOKEN`, `LANDO_HOST_PROXY_DEPTH`, `LANDO_DB_USER`, `LANDO_DB_PASSWORD`, `LANDO_DB_NAME`, `LANDO_DB_ROOT_PASSWORD`, `LANDO_GLOBAL_<SERVICE>_HOST`, `LANDO_GLOBAL_<SERVICE>_PORT`, `LANDO_GLOBAL_<SERVICE>_<EP>_PORT`, `LANDO_GLOBAL_<SERVICE>_URL`, `LANDO_SCRATCH_ID`, `LANDO_SCRATCH_SOURCE_KIND`, and `LANDO_SCRATCH_ISOLATE`.

`LANDO_GLOBAL_*` is projected only for global services required by activated `AppFeature`s (§20.6.3). Plugins MAY add typed projections through `AppFeature.apply()`.

`lando` services source `/etc/lando/environment` and `/etc/lando/env.d/*.sh`, exposing `LANDO_LINUX_DISTRO`, `LANDO_LINUX_DISTRO_LIKE`, `LANDO_LINUX_NAME`, and `LANDO_LINUX_PACKAGE_MANAGER`. Raw `l337` services receive only authored Compose-level environment.

#### 6.9.1 Host agent-context forwarding (`agentEnv`)

`agentEnv` forwards exact-name host markers per invocation to `app:exec`, `app:ssh`, `app:shell --service`, and `providerExec` tooling without entering service plans or caches.

The default allowlist is `CLAUDECODE`, `CLAUDE_CODE`, `CURSOR_AGENT`, `OPENCODE`, `COPILOT_CLI`, `GEMINI_CLI`, `AGENT`, and `CI`. Patterns fail with `AgentEnvPatternError`. Only present values are forwarded. Precedence is exec request, then task/service declaration, then agent context. Values pass through `RedactionService` for `pre-provider-exec` and other events and transcripts. This is not general host-environment passthrough.

Global `agentEnv.enabled`, `agentEnv.allow`, and `agentEnv.deny` control the resolved list. Top-level `agentEnv: false` disables it per app; host `LANDO_AGENT_ENV=0` disables one invocation. `lando info --deep` reports the resolved names. Host-proxy re-entry preserves the same allowlist.

### 6.10 Service info

Provider-neutral `ServiceInfo` contains `app`, `service`, `api`, `type`, `provider`, `primary`, `status`, `artifact`, `user`, `workingDirectory`, `appMount`, `endpoints`, `urls`, `hostnames`, `certs`, `health`, `externalConnections`, `internalConnections`, optional `creds`, and optional opaque `providerInfo`. Status is `unknown`, `stopped`, `starting`, `running`, `healthy`, `unhealthy`, or `error`; cert state is `none`, `generated`, or `custom`.

`creds` exists only for opted-in types and is redacted unless `--show-secrets` is passed. `providerInfo` is the sole provider-specific field.

### 6.11 Service type and feature contracts

#### 6.11.0 Planning and conformance

Core performs one deterministic pipeline:

1. Resolve each `ServiceType` to `ServiceTypeResolution`, including parent and artifact version resolution. `resolve()` MAY be asynchronous but MUST NOT build a plan.
2. Seed `ServiceFeatureContext` from explicit base and authored environment. `lando` seeds its default feature stack; `l337` seeds only artifact/build plumbing.
3. Apply `ServiceFeature`s in ascending priority.
4. After every service draft is complete, apply activated `AppFeature`s in ascending app-feature priority.
5. Emit provider-neutral `ServicePlan`s.
6. Finalize once in core with capability validation, bind realization, file-sync generation, storage shadows, routes, networking, excludes, and `AppPlan` decoding.

Features MUST emit provider-neutral intent. The app-plan cache input MUST include base, ordered `FeatureRef`s, and `AppFeature` contributions.

Every type MUST name `l337` or `lando`, return `ServiceTypeResolution`, and satisfy `runServiceCompositionContract`. `lando` receives `lando.env`; `l337` receives no injected environment or scaffolding. Only `lando.env` may invoke `buildLandoEnv`.

Contributed `logSources` MUST have unique ids, absolute paths, and compatible strategies; `console` is reserved. `redirect` requires an owned build, while a BYO/`l337` service may use only `follow`. Feature ordering and inheritance are replay-stable.

`ServiceType` declares `name`, optional `versions`, explicit `base`, optional `extends`, optional `artifacts`, `schema`, and Effectful `resolve` with `ServiceTypeError`. `ServiceTypeResolution` carries `base`, `normalizedConfig`, `features`, optional `tooling`, optional `logSources`, and optional `metadata`.

#### 6.11.1 Service-type inheritance (`extends:`)

A type MAY extend one parent, inheriting normalized config, features, tooling, and artifacts before child overlay under §7.2. Inheritance has no diamonds, is bounded, and rejects cycles with `ServiceTypeCollisionError`.

#### 6.11.2 Declarative version pinning (`artifacts:`)

`artifacts:` maps exact versions to artifact tags and MAY reference a sibling file. Ranges are not supported in v4.0. The `ServiceType` version metadata is the single matrix for planning, docs, and tests. Unknown, absent, or unavailable versions fail before provider action with supported-version remediation and MUST NOT fall back to guessed tags. Resolved tags enter the app-plan cache key.

#### 6.11.3 Service-type-shipped tooling

`ServiceTypeResolution.tooling` merges below resolved Landofile `tooling:`. Conflicts replace whole tasks by name. Between service contributions, the lexicographically first service name wins. A surviving contribution defaults its target to its contributor; `toolingDefaults` fills only unset fields.

Reserved names `run`, `scratch`, and `scratch:*` fail with `CommandAliasConflictError`. Service types MUST NOT use `topLevelAlias` while `BETA_TOOLING_TASK_KEYS` rejects it.

#### 6.11.4 App-scoped features (`AppFeature`)

`AppFeatureDefinition` declares `id`, optional `schema`, `priority`, optional `AppFeatureActivation` as `activatedBy`, optional `AppFeatureSelectors` as `selectors`, optional `requires.providerCapabilities`, optional `requires.globalServices`, and Effectful `apply`. Activation can match service type or feature; selectors can match `types`, `framework`, `hasFeature`, `names`, or `fromConfig`.

Activation and selection inspect completed service drafts, never raw config or finalized plans. `AppFeatureContext` provides replay-safe plan mutators across selected services. App features run only after all service features and order only against each other. Cycles fail with `AppFeatureCycleError`; `AppFeatureError` tags are `SelectorMatchedNothing`, `MutationConflict`, and `CycleDetected`.

Plugins register `serviceFeatures:`, `appFeatures:`, and `serviceTypes:`; all three MUST exist in `PluginManifest` and be consumed by loading and planning.

Activated `requires.globalServices` are ensured during `pre-start` before user-app build. Missing services fail with `GlobalServiceMissingError` and installation remediation (§20.6.3).

`ServiceFeatureDefinition` declares `id`, optional `schema`, `priority`, optional required `ProviderCapabilities`, and Effectful `apply` with `ServiceFeatureError`. A `ServiceFeature` mutates only its `ServicePlanContext`/`ServiceFeatureContext`; features run low priority first, MUST be idempotent, declare conflicts or return typed planning errors, and emit provider-neutral changes.

| Built-in feature | Priority |
|---|---:|
| `lando.boot` | 100 |
| `lando.system` | 200 |
| `lando.user-id` | 300 |
| `lando.tooling` | 400 |
| `lando.storage` | 500 |
| `lando.config` | 600 |
| `lando.env` | 700 |
| `lando.app-mount` | 800 |
| `lando.healthcheck` | 900 |
| `lando.certs` | 1000 |
| `lando.security` | 1100 |
| `lando.ssh-agent` | 1200 |
| `lando.host-proxy` | 1250 |
| `lando.bun-self` | 1260 |
| `lando.git` | 1300 |
| `lando.sudo` | 1400 |
| `lando.proxy` | 1500 |
| `lando.user-image` | 1900 |
| `lando.user` | 2000 |

`lando.host-proxy` provides container-to-host RPC and `LANDO_HOST_PROXY_*`. `lando.bun-self` installs container-side Bun under `/usr/local/lib/lando/bun`, sets `BUN_INSTALL_GLOBAL_DIR`, `LANDO_BUN_VERSION`, and `LANDO_BUN_PATH`, and rejects incompatible host-proxy Bun shims with `BunSelfFeatureConflictError`.

### 6.12 Canonical service-type catalog

#### 6.12.1 Catalog

The catalog is bundled from `@lando/service-lando` and focused `@lando/service-*` packages. Versions below are the one shipped `ServiceType` matrix; aliases resolve during planning.

| Type id | Base | Shipped versions | Notable options |
|---|---|---|---|
| `php` | `lando` | 8.1, 8.2, 8.3, 8.4, 8.5 | `via`, `composer`, `xdebug`, `db_client`, `webroot`, `allowOverride` |
| `node` | `lando` | 18, 20, 22, 24, `lts` | `command`, `script`, `globals`, `port` |
| `python` | `lando` | 3.10, 3.11, 3.12, 3.13 | `framework` |
| `ruby` | `lando` | 3.1, 3.2, 3.3 | `framework` |
| `go` | `lando` | 1.21, 1.22, 1.23 | `framework` |
| `nginx` | `lando` | 1.24, 1.26, `latest` | `webroot`, framework presets |
| `apache` | `lando` | 2.4 | `webroot`, `allowOverride`, framework presets |
| `mariadb` | `lando` | 10.6, 10.11, 11.4 | `creds`, `config.server` |
| `mysql` | `lando` | 8.0, 8.4 | `creds`, `config.server` |
| `postgres` | `lando` | 14, 15, 16, 17 | `creds`, `config.server` |
| `mongodb` | `lando` | 6, 7, 8 | `creds`, `config.server` |
| `redis` | `lando` | 6, 7 | `password`, `persist` |
| `memcached` | `lando` | 1.6 | none |
| `valkey` | `lando` | 7, 8 | `persist` |
| `solr` | `lando` | 8, 9 | `cores`, `config.dir` |
| `elasticsearch` | `lando` | 7, 8 | index initialization |
| `opensearch` | `lando` | 2 | index initialization |
| `meilisearch` | `lando` | 1 | `masterKey` |
| `mailpit` | `lando` | `latest` | `mailFrom` |
| `mailhog` | `lando` | `latest` | deprecated since v4.2.0; remove in v5.0.0; replacement `mailpit`; emits `deprecation-used` |
| `rabbitmq` | `lando` | 3, 4 | management route |
| `minio` | `lando` | `latest` | bucket initialization |
| `localstack` | `lando` | `latest` | none |
| `tomcat` | `lando` | 9, 10, 11 | `webroot` |
| `varnish` | `lando` | 6, 7 | backend, VCL |
| `dotnet` | `lando` | 8.0, 9.0 | `command` |
| `mssql` | `lando` | 2019, 2022 | `creds`; provider emulation required on arm64 |
| `phpmyadmin` | `lando` | 5, `latest` | MySQL-family service selection |
| `static` | `lando` | `nginx`, `caddy` | `webroot`, build hook |
| `compose` | `l337` | n/a | raw supported Compose passthrough |

Schemas publish at `@lando/sdk/schema/services/<type>` (§13.2). Unknown versions fail before provider action.

File-backed options MUST be app-contained, symlink-safe, correct-kind sources, mounted read-only where applicable, and included deterministically in plan/build keys. `solr.config.dir`, database `config.server`, `node.globals`, `node.port`, Redis `password`/`persist`, Mailpit `mailFrom`, Apache `webroot`, commands, users, versions, and packages retain their authored effect and MUST NOT be replaced by hardcoded defaults. `mailFrom` defaults to all PHP services, `false` to none, and validated arrays to named PHP services.

Every canonical or plugin type MUST declare its base, resolve through features, pass `runServiceCompositionContract`, use `runAppFeatureContract` when applicable, avoid direct env-helper access, and expose tooling, credentials, and presets through resolution.

#### 6.12.2 Framework presets

Language types may expose `framework:` presets as ordinary overridable config. Published ids are `drupal`, `wordpress`, `laravel`, `symfony`, `magento`, `django`, `fastapi`, `flask`, `rails`, `sinatra`, `echo`, `fiber`, and `none`.

Canonical PHP does not interpret framework ids. It uses absolute `webroot` and `allowOverride` (default false); recipes own framework choices. Invalid paths fail during planning.

#### 6.12.3 Catalog membership rules

Catalog membership is frozen at v4.0; additions or removals require a spec amendment. Version additions MAY ship in v4.x only through the single metadata matrix with available artifacts and matching docs/tests. Canonical collisions fail with `ServiceTypeCollisionError`. Plugins MAY add types and composable features. Library consumers receive the catalog only through bundled discovery (§16.4).

#### 6.12.4 The `creds:` schema

`ServiceCreds` contains `user`, `password`, `database`, and optional `rootPassword`. `mariadb`, `mysql`, `postgres`, `mongodb`, and opted-in plugin types share this contract.

Types provide deterministic defaults resolved at planning; authored `creds:` fields win. Values appear in `service.creds.*`, `services.<name>.creds.*`, `LANDO_DB_*`, and `ServiceInfo.creds`. Password fields are redacted by default; a type MAY mark additional fields secret.

#### 6.12.5 PHP service depth

`via` is `apache` by default, `fpm`, or `cli`. Modes select compatible artifacts and reject incompatible keys at planning. FPM exposes its service endpoint for a sibling web server; CLI has no implicit HTTP server.

`composer` accepts a version, `false`, or `{ version, packages }`; all forms remain supported. Versions and packages are validated, checksum-pinned, deterministically ordered, and included in `buildKey`.

`xdebug` accepts `false`, `true`, or modes. Enabled Xdebug configures host-gateway debugging and contributes `lando xdebug on|off|status`; environment variables alone MUST NOT be documented as enabling it.

`db_client` accepts `auto`, `false`, or an explicit family/version. Auto detection uses resolved database services without provider probing and participates in `buildKey`.

### 6.13 Build orchestration

`BuildOrchestrator` executes one provider-neutral `BuildPlan`, streams lifecycle events, and preserves independent service concurrency.

#### 6.13.1 Phases

| Phase | Source and dispatch | Dependency | Default policy |
|---|---|---|---|
| `artifact` | Artifact intent to `buildArtifact` or `pullArtifact` | Independent across services | fail-fast |
| `app` | Runtime scripts to `execStream` | Own artifact, running service, and authored `depends_on` | continue-all |

The build scope publishes `pre-build`, `post-build`, `pre-build-phase`, `post-build-phase`, `build-step-start`, `build-step-progress`, `build-step-skip`, `build-step-complete`, and `build-step-fail` through `EventService`. Global, app, and service `build:` configuration resolves concurrency and failure policy; limits are bounded but tuning constants are implementation-owned.

#### 6.13.2 `BuildPlan`

`BuildPlan` contains an `AppRef`, typed `BuildStep`s, and per-phase caps. `BuildStep` contains `stepId`, phase, service, `buildKey`, `BuildCommand`, dependencies, failure policy, redaction tokens, and optional estimate.

Artifact intent creates one artifact step per service. App scripts create ordered steps. Each app step depends on its service artifact and running state plus authored cross-service conditions. Artifact builds never inherit service `depends_on`. Independent siblings may run concurrently. Cycles fail with `BuildPlanCycleError`.

Ready predecessors are `complete` or `skip`. Interrupts propagate to in-flight provider work and publish `build-step-fail`; `service-running` is the synthetic running-state predecessor.

#### 6.13.3 Provider dispatch

Full artifacts use `RuntimeProvider.buildArtifact`; pull-only artifacts use `RuntimeProvider.pullArtifact`; app scripts use `RuntimeProvider.execStream`. Every command retains its planned user, working directory, and environment. Providers MUST NOT re-resolve users at execution time.

#### 6.13.4 Failure policy

Artifact failure is fail-fast by default: it interrupts siblings, skips queued work as `phase-aborted`, and fails start. App failure continues independent siblings and raises one `BuildPhaseFailedError` containing `BuildStepFailure`s after `post-build-phase`. App and service overrides MAY change fail-fast behavior; per-step overrides are not exposed.

#### 6.13.5 `buildKey` and results

Every step uses a content-derived `buildKey`. A matching successful `build-results` cache entry emits `build-step-skip` with `up-to-date`; failures never suppress retries.

Both phases MUST hash ordered commands and resolved users, tools, versions, packages, config-source identities, and applicable provider/artifact/mount inputs deterministically with secrets redacted. Reordering or user changes MUST change the key; home contents, clocks, undeclared environment, bind contents, and resolved secret values MUST NOT. Forced rebuild commands bypass the result.

`BuildResult` records `buildKey`, service, phase, outcome, exit code, duration, optional artifact reference, transcript path, and completion time. Results are bounded and rotated.

#### 6.13.6 Transcripts

Each dispatched step writes `<userDataRoot>/builds/<app-id>/<phase>/<service>/<buildKey>.log`. `transcriptPath` appears on `BuildStepEvent` and `BuildStepResultEvent`; renderers and `lando logs <service> --build` use the same artifact. Transcripts stay local, are never telemetry, retain raw output while CLI/events apply redaction, and are removed by `lando destroy`.

#### 6.13.7 Cancellation

`Effect.interrupt` closes every step scope, terminates provider children, closes transcripts, and publishes interrupted failures within the §2.1 cancellation contract. Fail-fast uses the same path with reason `phase-aborted` and the originating failure.

#### 6.13.8 Errors

Build failures are tagged `BuildPlanCycleError`, `BuildStepFailedError`, `BuildPhaseFailedError`, and `BuildOrchestratorUnavailableError`. They carry the relevant app, phase, step/failures, transcript, and remediation context. Only `BuildOrchestrator` publishes the `Build` event scope.

### 6.14 Service log sources

`RuntimeProvider.logs` always exposes the implicit container stdout/stderr source. `LogSource` adds provider-neutral in-container file intent without selecting collection architecture.

#### 6.14.1 `LogSource`

`LogSource` contains branded `LogSourceId`, optional label, absolute path, `stdout`/`stderr` classification, `redirect`/`follow` strategy, `required`, and timestamp capability. `console` is reserved for the implicit source. Each source names one file; globs are outside v4.0.

Landofile `LogSourceInput` requires `path` and optionally accepts `id`, `label`, `stream`, and `timestamps`; it always resolves to `follow`. Service types may declare `redirect`.

#### 6.14.2 `LogChunk.source`

`LogChunk` contains service, optional source, stream, line, and optional timestamp. Missing source means `console`; renderers label interleaved sources.

#### 6.14.3 Reification

`redirect` routes owned daemon logs to stdout/stderr during build and requires an owned image path, not `serviceLogSources`. `follow` is implemented by `RuntimeProvider.logs`, never a core shell-out, and requires `serviceLogSources`.

Without that capability, required follow sources fail with `CapabilityError`; optional sources are explicitly reported unavailable and skipped. Sources are never silently dropped.

#### 6.14.4 Follow semantics

Providers declaring `serviceLogSources` MUST support finite snapshots and scoped follow mode, bounded pending diagnostics for missing files, rotation and truncation, complete UTF-8 line framing, bounded lines, per-source `tail`, timestamp-gated `since`, preserved per-source order, arrival-order merging, and interruption cleanup. No global chronological guarantee or global-total tail exists in v4.0.

#### 6.14.5 Redaction

Providers return raw `LogChunk`s. Renderer, lifecycle, telemetry, and machine-output boundaries apply `RedactionService` exactly once. Library log streams and app-owned files remain raw.

#### 6.14.6 Catalog defaults

Catalog types prefer `redirect` for owned Apache, nginx, and PHP-FPM logs; MySQL/MariaDB optional slow/general logs use `follow`; framework file logs are declared by the recipe or type that knows their paths.

---
