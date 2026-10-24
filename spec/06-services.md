# Lando v4: Service Specification

> **Part 6 of 19** · [Index](./README.md)
> **Read next:** [07 Landofile and Configuration](./07-landofile-and-config.md)

This part defines the provider-neutral service model, its composition contracts, canonical service types, build lifecycle, and log sources.

---

## 6. Service Specification

### 6.1 Model

A service is a planned runtime component composed from one base and an ordered set of features.

| Base | Contract |
|---|---|
| `l337` | Artifact and build plumbing only. It is the low-level escape hatch and provides no `/etc/lando/*` scaffolding, opinionated environment, packages, or app mount. |
| `lando` | Opinionated development service with boot scaffolding, environment, packages, build steps, app mounts, healthchecks, certificates, SSH agent, and hooks. It is the default when `type:` is omitted. |

Composition is normative. A `ServiceType` resolves to `ServiceTypeResolution`; the core planner composes its `base`, `normalizedConfig`, and priority-ordered `features` into a `ServicePlan`. A type that builds a plan directly is non-conforming and bypasses inheritance, `AppFeature` injection, and feature conformance (§6.11).

`api: 4` is the only service API. Core defaults it after confirming that the Landofile targets `runtime: 4`; no `api: 3` path exists.

A service inherits the app provider. Per-service provider configuration is non-portable and belongs under `services.<name>.providers.<id>`. `ServicePlan.provider` records the resolved app provider.

### 6.2 Common service schema

`ServiceConfigInput` accepts the supported Compose service-key subset (§7.4) alongside Lando keys and decodes to canonical `ServiceConfig`. Its optional `port` is a TCP port number (integer 1-65535). Unsupported or rejected Compose keys fail validation unless an explicit provider extension owns them.

- `image:` and Compose `build:` normalize to `artifact:`. Compose-build fields and Lando build-script fields (`artifact:`, `app:`) are shape-discriminated; mixing them fails with a tagged error and remediation.
- `command:`, `entrypoint:`, `user:`, `working_dir:`/`workingDirectory`, `environment:`, and `env_file:`/`envFile` normalize to execution and environment fields. Environment input never inherits unset host values. A null label value becomes an empty string.
- `volumes:` short and long forms normalize to `mounts`, `storage`, or `tmpfs` according to source and type.
- `ports:` and `expose:` normalize to `endpoints` through the single mandatory normalizer (§6.6); host bindings require provider capability.
- `depends_on:` list and condition-map forms normalize to `dependsOn`. `service_started`, `service_healthy`, and `service_completed_successfully` retain their lifecycle meaning (§6.13).
- Compose `healthcheck:` normalizes to the §6.7 model.
- `restart`, `cap_add`, `cap_drop`, `privileged`, `devices`, `ulimits`, `sysctls`, `tmpfs`, `shm_size`, `dns`, `dns_search`, `dns_opt`, `extra_hosts`, `init`, `stop_signal`, `stop_grace_period`, `security_opt`, `group_add`, `read_only`, `platform`, `pull_policy`, `logging`, `gpus`, and `deploy.resources` are preserved in `ServicePlan.extensions.compose` and capability-checked (§5.5.1).
- Supported `networks:`, `configs:`, `secrets:`, `labels:`, and `profiles:` forms are preserved and capability-checked. Service-level `x-*` fields remain inert (§5.4).
- Rejected keys, including `extends`, `container_name`, `network_mode`, `links`, and Swarm orchestration fields, fail with a tagged error and remediation; they are never silently dropped.

Lando keys include `api`, `type`, `primary`, `artifact`, `appMount`, `mounts`, `storage`, `home`, `endpoints`, `routes`, `healthcheck`, `logs`, `certs`, `hostnames`, `security`, `build`, `packages`, and `providers`. Where a Compose spelling and a more specific Lando spelling conflict, the Lando value wins and `lando app config` SHOULD report the resolution.

`BuildScriptStep` is a command string or `{ run, user? }`; `BuildScript` is one step or an ordered list.

The published boundary retains the named component contracts `ArtifactInput` (not yet published; see #1483), `CommandSpec`, `ContainerUser`, `PortablePath`, `AppMountInput`, `MountInput`, `StorageInput`, `EndpointInput`, `RouteInput`, `HealthcheckInput`, `LogSourceInput`, `CertsInput`, `CaInput`, and `ProviderId`.

### 6.3 Artifact build

`artifact:` accepts an existing artifact reference, an external `sourcefile:` plus context, or inline provider-neutral build intent. Inline intent includes `source`, `tag`, `context`, `args`, `secrets`, `ssh`, `platform`, `groups`, and `steps`.

Build instructions use named, weighted, user-scoped groups. Final order follows group weight and step weight. Service types, features, fragments (§7.7), and Landofile input contribute steps; recipes contribute only through the Landofile they scaffold. Group overrides may select a group, relative offset, before/after placement, and user; their concrete grammar is schema-owned.

`build.artifact:` and `build.app:` preserve every step's resolved user through `BuildPlan`, provider execution, and ordered `buildKey` hashing. Omitted users resolve to the planned service user; an explicit step user overrides its group's user. Interleaved users are valid. Artifact generation switches users only when required and restores the final service user; app steps pass the resolved user to `execStream`.

`sourcefile:` is the provider-neutral external build-definition key. Compose build fields normalize when possible; other provider aliases belong in provider schemas. Build secrets and SSH require `buildSecrets` and `buildSsh`. Artifact tags are not assumed globally meaningful or pushable.

Artifact builds, including setup probes, MUST remove their temporary build containers and release those containers' mounts whether the build succeeds, fails, or is cancelled. Built artifacts and reusable build cache MAY remain.

### 6.4 App mounts and mounts

`appMount:` (`AppMountInput`) accepts `false`, a destination string, or an object with `target` and optional `readOnly`, `excludes`, and `includes`. A string is shorthand for `{ target: <string> }`, interpreted after authored composition. A higher-layer string replaces the inherited object, including its options; object forms deep-merge with other object forms. Consumers see only `false` or the decoded object form. Ordinary service configuration fixes the app mount's source to the app root (scratch isolation may rebase it, §21.7), and core selects provider-bind or accelerated file-sync realization, so `MountInput`'s `type` and `source` are not authoring options and `false` is the only disable spelling. Target validity is a planning check, so the published schema and decoding agree on every string. The `lando.app-mount` feature is its only owner: a service type opts in by declaring its default target, usually `/app`, and optionally a default working directory; types without one, such as data stores, get no app mount. When active, the app source mounts at the authored target or the type's default. Planning sets `workingDirectory` to that target unless the author sets one or the type names another default (§6.12.1), exports `LANDO_APP_ROOT` and `LANDO_PROJECT_MOUNT` as that container path, and records the result in `ServiceInfo`. The plan carries the app mount only as `appMount`, never as a duplicate entry in `mounts`. The same feature realizes authored `mounts:` on every `lando` service, whether or not the type mounts the app, and on `compose`; an authored mount at the app mount target replaces the app mount and keeps the app-path variables and default working directory. `false` means the service does not use the app source, as with a data store: on every type it disables the mount, both variables, `LANDO_WEBROOT`, and the default working directory, and an authored working directory still applies. Raw `compose` services get the mount but no default working directory and no app-path variables (§6.9).

| Mount type | Contract | Capability |
|---|---|---|
| `bind` | Live host path | `bindMounts` |
| `copy` | Host path copied during artifact build | `copyMounts` |
| `inline` | Literal content written at the destination | Always |
| `template` | `TemplateEngine` output materialized as `inline` | Always |
| `disabled` | Explicitly disables an inherited mount | No-op |

Template mounts use app-root-relative `source`, optional `engine`, `vars`, and `mode`. Sources obey include containment (§7.7.6). Engine selection is explicit, then extension-based, then `lando`; values resolve through the standard expression context. Providers receive only rendered `inline` mounts. Rendered output uses the `<userCacheRoot>/templates/<engineId>/...` `template-render` cache (§12.1).

An excluded path belongs to the service. `excludes` (default `node_modules`, `vendor`, `tmp`, plus service-type presets) each get a service-scoped storage shadow; a shadow overlays a directory, so an exclude whose host path exists as a non-directory gets no shadow and stays visible through passthrough binds. `includes` cancels an exclude by exact entry. A bare `!` entry in either list fails validation with remediation naming `includes`; the Lando 3 translator lowers `!x` to `includes: [x]`. VCS metadata is a fixed rule, not a key: `.git` is never shadowed, and accelerated engines never sync it unless `includes` names it. The exclusion patterns an accelerated engine receives are derived from the finalized plan, not from the authored list: every effective exclude, the relative target of every non-bind entry mounted under the app mount (storage shadows, authored and cache stores, `tmpfs` and `volume` mounts), and `.git`, deduplicated. A `storage` entry under the app mount and an `excludes` entry for the same path therefore produce the same container layout and the same patterns. Copy includes become binds. Ordering preserves nested-path semantics.

When a passthrough app mount's `.git` is a gitfile (a Git worktree or submodule checkout), planning bind-mounts the resolved common git directory, and the worktree git directory when it lies outside it, so git works at the app mount. An absolute `gitdir` mounts at the same container path; a relative one mounts where the gitfile resolves from the container app mount target, so git follows the file unchanged. Planning verifies each directory is a Git directory (it holds `HEAD`) before mounting; a gitfile alone never authorizes a host path. The binds are read-only when the app mount is read-only, never file-sync sessions, never override an authored mount or storage at the same destination, and are skipped when a host path is not a POSIX absolute path. Shared metadata is writable by every worktree's containers, as on the host.

Every bind `MountPlan` has `realization: passthrough | accelerated` selected from `bindMountPerformance` (§5.4):

- `native` uses provider binds and no `FileSyncEngine` or `pre-file-sync-*` events.
- `slow` uses a provider-managed `lando-sync-<app-id>-<service>-<mountKeyHash>` volume and a `FileSyncSessionSpec`; the bundled engine is `@lando/file-sync-mutagen` (§4.2).
- `none` fails with `CapabilityError`.

The realization is invisible in canonical config and MUST NOT expose engine or session ids. Accelerated engines with `exclusionPatterns` receive the derived patterns, including non-directory paths; otherwise planning retains storage shadows. Exclude entries stay in mount intent and are never silently dropped.

`mountKey` is stable for canonical source, destination, type, and excludes and correlates the mount, sync volume, `FileSyncSessionSpec`, the engine's durable session state (§10.6.2), and lifecycle events. Changing excludes changes the key.

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

**Ownership proof and selection.** Two further labels carry volume ownership, and they are not interchangeable:

- `dev.lando.volume-owner` records the canonical app root verbatim. It is the ownership **proof**: the planful volume-delete gate, create-race detection, adoption and witness checks, and SQL recovery adoption compare it against a root they already hold.
- `dev.lando.volume-selector` packs provider id, app id, owner key, and volume class (optionally scope) into one `:`-joined value. It is the ownership-complete **selection** value: bring-down's local match and the daemon-side prune filter select on it alone, because a daemon ORs the values listed under one label key, so ownership split across keys would broaden a prune.

The invariant: the selector's owner key is `appIdentityKey("owner", <canonical app root>)` from `@lando/sdk/schema`, the same derivation the planner stamps onto `AppPlan.identity`, so both labels are derived from one root. One owner in `@lando/container-runtime` emits the pair together and every reader resolves ownership through the same function; a label is never written without its partner, and no call site re-spells the key or falls back to a raw root. A plan that carries no `identity` is migrated at read time from `plan.root` through the same derivation (the planner assigns `root` from `identity.appRoot`, so the key is byte-identical), never written in a second selector format. Volumes created by earlier revisions carry selectors that match neither form and are neither adopted nor pruned by selection; recovery of such volumes goes through the proof label and the documented adoption paths, not through a looser selector.

Global-app storage substitutes `global` for project identity and adds `dev.lando.storage-global-app: "TRUE"`; service and app names are `global-<service>-<destination>` and `global-<destination>`. Only global scope survives `meta:global:destroy --purge` (§20.9).

Scratch storage substitutes `<scratch-id>`, producing `<scratch-id>-<service>-<destination>` and `<scratch-id>-<destination>`, labels volumes with `dev.lando.scratch: "TRUE"` and `dev.lando.scratch-id`, and rewrites global scope to app scope unless `--share-global-storage` is present. Scratch destroy removes effective service/app storage unless `--keep-volumes` is used (§21).

### 6.6 Endpoints, hostnames, and routes

`EndpointInput` and `EndpointPlan` are discriminated unions. `InternalEndpoint` carries a network protocol and port or a Unix `socketPath`. `PublishedEndpoint` permits `http`, `https`, `tcp`, or `udp` and requires `publication`; `{}` requests defaults. Default bind is `127.0.0.1`; omitted `hostPort` requests provider assignment. Runtime assignments are provider observations (§5.3, §6.10) and never rewrite desired state. Unix sockets cannot be published.

**Logical listener identity.** Network endpoint entries are facets of a logical listener identified by container port plus transport, where `http` and `https` imply `tcp`. One listener MAY carry several facets: an internal entry beside one or more publications, each with its own bind address or host port. `EndpointRef` (`port`, `transport`, sorted unique `names`, `primary`) is the public reference to a listener; `groupLogicalEndpoints`, `endpointInvariantIssues`, and `selectHttpEndpoint` in `@lando/sdk/schema` are the only grouping, invariant, and selection rules, and every consumer uses them.

- `name` is an alias of the listener. Different facets of one listener MAY carry different aliases, and repeating a name on facets of the same listener is allowed; the same name on two different listeners is an `alias-collision`. Unix endpoints own their names in the same alias space.
- Explicit protocols of one listener MUST agree; `http` beside `tcp` on one port is a `protocol-conflict`. A publication synthesized from `ports:` with no matching declaration is `tcp` or `udp` and is not an explicit protocol declaration.
- Optional `primary: true` (the only accepted value) marks the logical primary network listener regardless of facet count. At most one listener per service MAY be primary (`multiple-primary`). Marking a listener primary is metadata: it changes selection and reporting, never what the daemon launches or whether a host port is published.
- Optional `appProtocol` is opaque application-layer metadata preserved verbatim. It is never a URI scheme, never promotes a `tcp` listener to HTTP, and never affects selection or scanning.

Invariant violations fail planning before provider action as `ValidationIssue`s at `services.<name>.endpoints` inside one `LandofileValidationError`.

**One mandatory normalizer, after every contribution.** Service composition returns the plan together with the ORIGINAL endpoint contributions of its features; app features that append endpoints append to those contributions; finalization replays one pure normalizer over the complete contribution set plus `normalizedConfig`. Synthesized output is never fed back in as a new declaration. The policy is: an explicit `endpoints:` list, including `endpoints: []`, is authoritative and replaces type contributions and anything inferred from `ports:` or `expose:` (§6.2). Otherwise every contributed listener survives (`ports: []` is not an opt-out), each `ports:` entry adds a publication of its target port carrying the matching contribution's protocol and `primary` marking, plus its single alias and single `appProtocol` hint unless the entry authors its own Compose `name` or `app_protocol`; a target no contribution declares is `tcp` or `udp` from the entry, and each `expose:` port adds an internal `tcp` listener when that identity is not already present. Identical facets dedupe; aliases are preserved. No provider or consumer may re-derive listeners from `ports:`.

**Default HTTP selection has no ordering fallback.** `selectHttpEndpoint(endpoints, selector?)` chooses the marked primary when it is `http` or `https`, else the service's single distinct HTTP(S) listener, else returns `none` or `ambiguous` with the candidate listeners; a named or numeric selector restricts candidates to that alias or port. List order never decides. A service whose generated default route, or an authored route without `endpoint`, is ambiguous fails planning with `LandofileValidationError` and remediation to mark one listener `primary: true` or name the endpoint; `app:open` and sharing never pick an ambiguous target by order. A TCP primary beside one HTTP secondary (Mailpit's SMTP primary and HTTP UI) selects the HTTP listener for routes while `ServiceConnection.endpoint.primary` still identifies SMTP.

`hostnames:` adds provider-network aliases; each entry MUST satisfy `DomainName` once evaluated. The planner adds `<service>.<app>.internal` when `sharedCrossAppNetwork` is supported. Whenever a service joins the shared cross-app network, its realized alias set MUST contain the canonical qualified alias `<service>.<slug>.internal` exactly once, unioned with any additional authored aliases, including when the authored alias map is empty; `landoServiceNetworkAliases` in `@lando/sdk/schema` is the only derivation.

Routes live under top-level `proxy:` or preferred service `routes:`. Every `RoutePlan` has a resolved `backend` with service, protocol, and port; proxies MUST NOT guess. Shorthand normalizes to `hostname`, `scheme`, `endpoint`, `pathPrefix`, and `filters`. Shorthand and object routes share hostname and path-prefix constraints: in object form `hostname` contains only the host pattern, with any port in `endpoint` and any path in `pathPrefix`, and an explicit `pathPrefix` MUST begin with `/` and contain no whitespace, query string, or fragment. Each hostname label is at most 63 characters and the whole hostname at most 253. The constraints apply to concrete values, so the planner's resolved-Landofile validation (§7.8), shared by lint and planning, checks every route after its expressions are evaluated and reports every invalid field in one run. `RoutePlan.hostname` and optional `RoutePlan.pathPrefix` use the public `RouteHostname` and `RoutePathPrefix` schemas, and final plan validation enforces those grammars for authored routes, generated defaults, and plugin contributions. Invalid object fields identify `hostname` or `pathPrefix`, invalid shorthand identifies the route entry, and both carry actionable remediation. Invalid authored route fields are `ValidationIssue`s that planning aggregates in one `LandofileValidationError`; `RouteInputError` is reserved for conflicts between assembled routes. Non-empty filter overlays merge by `name`, then unnamed type identity, and retain authored order; an explicitly empty overlay clears inherited filters (§7.2). Prefix stripping MUST NOT be implicit (§10.2). Layered route matching uses the same scheme, case-insensitive hostname, and path-prefix identity as planning (§7.2), regardless of shorthand or object spelling.

Built-in route filters are `requestHeader`, `responseHeader`, `redirect`, `rewritePath`, `stripPrefix`, `addPrefix`, `auth.basic`, and `rateLimit`. Plugins contribute `routeFilters:`.

Default route hostnames are `<service>.<app>.<domain>`, where `<domain>` is the global `proxy.defaultDomain` (default `lndo.site`). It MUST satisfy `DomainName`: dot-separated ASCII letter, digit, and hyphen labels without empty labels or leading or trailing hyphens, at most 63 characters per label and 253 overall; schemes, ports, paths, whitespace, trailing dots, and wildcards are invalid. Global-config decoding and schema-validated writes reject other values, and `lando config set --dry-run` performs the same validation without writing. When a service authors neither `services.<name>.routes` nor `proxy.<name>`, core finalization routes that hostname over HTTPS to the listener `selectHttpEndpoint` chooses (above), recording its alias or port as the route `endpoint`; `none` generates no route and `ambiguous` fails planning. Service types contribute endpoints, not default routes. A service that authors either gets exactly its authored routes, so an explicitly empty list opts it out of routing without affecting published endpoints. LAN publication is opt-in and warns. Internal endpoints never bind the host.

Service types MAY contribute default checks (§10.5.2) for the endpoints they declare, such as a `tcp` check for a database, and `service-error` rules for their own server pages (a web server's 502 when its upstream is down). Authored service-level `checks` tune or disable them. Types never contribute `expected` or `app-error` rules; those come from profiles and the Landofile.

Scratch plans apply `RouteFilter.ScratchHostnameSuffix` unless suppressed by `--hostname` or `--no-hostname-suffix` (§21.9.2).

**Cross-app route priority.** Every app's routes are merged into one router table, so `RoutePlan.priority` is one shared space, not a per-app ranking. The planner derives priority from the route alone: wildcard-hostname routes occupy the band `ROUTE_PRIORITY_WILDCARD_BASE` (2) through `ROUTE_PRIORITY_WILDCARD_BASE + ROUTE_PATH_WEIGHT_CAP`, exact-hostname routes occupy `ROUTE_PRIORITY_EXACT_BASE` through `ROUTE_PRIORITY_MAX`, and within a band the path-prefix length widens the priority up to `ROUTE_PATH_WEIGHT_CAP` so bands never overlap. `@lando/sdk/schema` owns these constants. For any two routes on concurrently applied apps that match the same request, an exact hostname MUST win over a wildcard and a longer path prefix MUST win over a shorter one, independently of how many routes each app declares and without relying on a router's own rule-length tie-break. The derivation MUST NOT include a plan-size or in-plan-index term: a plan ranked in isolation MUST compose correctly with plans it cannot see. The diagnostic fallback keeps `ROUTE_PRIORITY_DIAGNOSTIC` (1), below every app route, and a router that contributes its own routers MUST pin them above `ROUTE_PRIORITY_MAX` or an app claiming that hostname captures them. This does not introduce cross-app hostname ownership: two apps MAY still claim overlapping hostnames; only the more specific claim wins deterministically.

### 6.7 Healthchecks

Disabled objects MUST validate every supplied sibling before canonicalizing to `false`, including `kind: none` and effective Compose disabling. Authored `kind: http` and `kind: tcp` MUST fail planning before provider actions with `LandofileValidationError` at `services.<name>.healthcheck.kind`, preserving the authored source when available and command-probe remediation. Schema acceptance describes future intent, not runner availability.

`HealthcheckInput` accepts `false`, command forms, or an object. `false` disables checks. A non-empty string is a shell command and a non-empty bare string array is literal argv, both shorthand for `{ command }`; Compose `CMD`/`CMD-SHELL`/`NONE` markers are interpreted only in an object's `test` array. `load()` MAY provide any form (§7.3). Forms are interpreted after authored composition. Literal `false` replaces lower probes wholesale, and a higher object then replaces that scalar rather than reviving its discarded probe. Object disabled spellings (`disable: true`, `test: [NONE]`, `kind: none`) are ordinary mappings during composition, not reset barriers; inherited siblings remain unless replaced or reset explicitly. The effective disabled spelling decodes to `false`. Lando keys retain precedence over equivalent Compose fields. An authored `false` also drops the service type's default probe. `HealthcheckRunner` executes `HealthcheckPlan`; the default uses the selected `RuntimeProvider.exec` and `runProbe`.

**Startup readiness versus ongoing health.** `ServicePlan.healthcheck` is the ongoing native check the provider repeats for the life of the container. A service feature MAY additionally set `ServicePlan.readiness` (also a `HealthcheckPlan`) through `ServiceFeatureContext.setReadiness` when startup needs a stronger proof than steady-state health can afford. `effectiveReadiness(service)` in `@lando/sdk/schema` selects `readiness` when present, otherwise `healthcheck`; it is a defaulting rule, not a compatibility path, and it is the only rule. The §6.7 readiness barrier, `service_healthy` dependency gates and their planning validation, and app-build gates MUST use effective readiness; native container healthchecks in create requests and Compose output MUST use `healthcheck` only. No consumer may unblock startup or dependents on the cheap check alone. An authored `healthcheck:` replaces both type-contributed probes, and `healthcheck: false` disables both; there is no authored readiness key and no hidden stronger probe beneath an authored healthcheck. Readiness and the resolved probe target identity are part of the create fingerprint and the app-plan cache input, so a change forces visible recreation. MongoDB's default readiness proves that the final server answers its protocol on the declared listener; its default probes MUST NOT authenticate or be described as proof that configured credentials match users already persisted on a volume.

**Declared probe targets.** A command `HealthcheckPlan` MAY carry `target: EndpointRef` naming one of the service's declared logical listeners by port and transport (§6.6); `names` and `primary` are descriptive. `serviceListenerTarget` in `@lando/sdk/schema` is the single derivation of the host a targeted probe dials: the service name on the private app network when the plan has one, otherwise the canonical `<service>.<slug>.internal` alias on the shared network. An undeclared listener, a plan with no managed network, or a loopback host fails planning with `LandofileValidationError` before any provider action; an authored custom probe may describe a different topology. One container-runtime probe compiler resolves the target and supplies it to the command as `LANDO_PROBE_HOST` and `LANDO_PROBE_PORT`; native create requests, dependency gates, Compose output, fingerprints, and the engine runner MUST use that compiler rather than interpolating hostnames separately, and an untargeted command receives no injected target. Probes MUST NOT discover interface addresses, fall back to loopback, or add a provider networking API. App-scoped `ServiceConnection` listener hosts (§6.10) use the same derivation. Listener, protocol, and executable failures MUST yield short safe evidence: the runner retains bounded redacted stderr together with the safe target, attempt count, elapsed time, and exit code rather than reducing the failure to `exit N`.

Start, restart, rebuild (full or selected), and global-service start MUST complete a concurrent readiness barrier before publishing `post-app-start` or `post-start`. One private engine startup-completion owner (`completeStartup`, taking a closed discriminated request union rather than a callback bag or phase array) runs every post-apply sequence and preserves each policy's order: user start runs app build, routes, then readiness; selected restart runs file-sync start then readiness; selected rebuild runs forced selected app build then readiness; ensure-global runs readiness; global groups run concurrent readiness per applied group, aggregate failures, and publish routes only when every group succeeded; scratch runs the existing soft-fail routes then readiness. Apply and preflight wrappers, initial inspection, accelerated journals, agent acquisitions, volume locks, pre/post events, and scans keep their current owners. Readiness is never skippable, success events publish only after completion succeeds, global rebuild revalidation still precedes its post-event, and selected requests carry the full classification plan including unselected job consumers. Unsupervised exited services and exhausted healthchecks MUST fail with `ServiceNotReadyError`, naming the service, reason, available stopped-container exit code, bounded redacted log tail, and remediation. User/global startup failure or interruption MUST preserve established resources at every phase. Dependency gates remain strict and retain `ServiceStartError`; readiness failures retain `ServiceNotReadyError`. Retry MUST reconcile observed resources with desired intent. Scratch ownership follows §21. Interruption MUST stop waiting, cancel in-flight probes, and still propagate to the CLI. Prepared sync targets, sessions, and an unfinished accelerated-start journal stay for the next start to resume (§10.6.3). URL-scan failures MUST warn, not fail startup.

A target of a `service_completed_successfully` dependency in the full plan is a completion-intent service: it MUST have verified exit code 0 and MUST skip healthcheck waiting, including selected operations. Other unsupervised services MUST remain running throughout readiness; services without enabled healthchecks settle against their current container start, with the remaining host-side wait bounded to two seconds despite engine clock skew. Container replacement or restart invalidates unsupervised readiness. Successful rows are `ready` after a healthcheck passes, `running` without an enabled healthcheck, or `completed` after verified successful completion.

For non-completion services, authored `restart: always` or `unless-stopped` permits a `restarting` warning on exit or observed restart; `on-failure` permits it only with an observed non-zero exit code. Missing `restart`, `restart: no`, and `on-failure` exit 0 remain strict. Exhausted healthchecks MUST fail for every service: restart policies do not restart a running-but-unhealthy process. Provider inspection failure MUST use reason `inspect-failed` and MUST NOT become a supervised warning. Warnings MUST name the service and reason and include available terminal exit code and a short redacted log tail. `restarting` rows MUST use a warning tone. Non-instant readiness waits MUST publish progress naming the waiting services and settle their rows individually.

Healthchecks MUST probe immediately. Failures during `startPeriodSeconds` MUST NOT count against retries; probes during that period use at most a one-second interval and return on first success. After that period, allow at least one attempt, otherwise `retries` attempts at `intervalSeconds`, each bounded by `timeoutSeconds`.

Readiness remediation MUST address the app kind: user apps use `lando logs -s <service>` and `lando start`; global apps use `lando global:logs -s <service>` and `lando global:start`; scratch apps use their scratch-addressed inspection surface and MUST NOT prescribe user-app start. Provider observation failures prescribe `lando doctor`, not service logs. The supervised warning follows the same app-kind rule.

`ServiceNotReadyError` applies only after committed provider apply; apply and dependency-gate failures use `ServiceStartError`. Both share the retention policy above. Supervision MUST NOT relax `service_healthy` or `service_completed_successfully` gates. Scratch acquisition runs the barrier but readiness failure and interruption follow §21 scope cleanup and `--keep-on-failure`, not user-app retention.

Language runtimes (`node`, `python`, `ruby`, and `go`) MUST NOT infer default healthchecks from ports or commands; endpoints remain available and authors MAY declare `healthcheck:` explicitly.

### 6.8 Certificates and security

`certs:` accepts enabled, disabled, a certificate path, or custom certificate/key paths. `CertificateAuthority` generates leaf certificates covering the service name, `<service>.<app>.internal`, configured hostnames, route hostnames, `localhost`, and `127.0.0.1`. Paths are exposed as `LANDO_SERVICE_CERT` and `LANDO_SERVICE_KEY`.

`security.ca:` and aliases `cas`, `certificate-authority`, and `certificate-authorities` add project CAs. The `lando.security` feature mounts and installs them; core defines intent, not distribution mechanics.

Global `network.ca` and `network.proxy` each expose `injectIntoServices`. CA injection defaults on; proxy injection defaults off. Per-service `security.inheritNetworkCa` and `security.inheritNetworkProxy` override those defaults. Only services composing `lando.security` participate; `l337` and raw Compose do not auto-inject.

The effective CA set is global `network.ca.certs`/`LANDO_NETWORK_CA_CERTS` followed by project CAs, deduplicated by content. Open-ended host Dockerfile drop-ins are a non-goal. Installation precedes `build.app:` and tooling. Injected CA identity participates in artifact `buildKey` calculation. Providers MUST honor resolved proxy/CA settings for every Lando-initiated pull and build regardless of service injection.

When CAs are injected, services expose `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `LANDO_CA_BUNDLE`, and `LANDO_CA_DIR`; service types MAY add equivalents. Proxy injection writes `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`; credentials MUST be redacted from logs, telemetry, caches, rendered config, and build transcripts.

### 6.9 Service environment variables

Core publishes the reserved `LANDO`/`LANDO_*` catalog used by `appEnv` validation (§7.5). Plugins use `LANDO_PLUGIN_<NAME>_*`. Credentials use typed families, never aggregate JSON. `LANDO_HOST_IP` is omitted unless provider capability and gateway data permit it.

Always when applicable: `LANDO`, `LANDO_DEBUG`, `LANDO_HOST_OS`, `LANDO_HOST_USER`, `LANDO_HOST_UID`, `LANDO_HOST_GID`, `LANDO_HOST_HOME`, `LANDO_APP_NAME`, `LANDO_APP_KIND`, `LANDO_APP_ROOT`, `LANDO_PROJECT`, `LANDO_PROJECT_MOUNT`, `LANDO_SERVICE_API`, `LANDO_SERVICE_NAME`, `LANDO_SERVICE_TYPE`, and `LANDO_DOMAIN`.

Conditional keys are `LANDO_HOST_IP`, `LANDO_SERVICE_CERT`, `LANDO_SERVICE_KEY`, `LANDO_CA_CERT`, `LANDO_CA_DIR`, `LANDO_CA_BUNDLE`, `LANDO_USER`, `LANDO_UID`, `LANDO_GID`, `LANDO_WEBROOT`, `SSH_AUTH_SOCK`, `GNUPGHOME`, `LANDO_HOST_PROXY_SOCKET`, `LANDO_HOST_PROXY_TOKEN`, `LANDO_HOST_PROXY_DEPTH`, `LANDO_DB_USER`, `LANDO_DB_PASSWORD`, `LANDO_DB_NAME`, `LANDO_DB_PORT`, `LANDO_DB_ROOT_PASSWORD`, `LANDO_GLOBAL_<SERVICE>_HOST`, `LANDO_GLOBAL_<SERVICE>_PORT`, `LANDO_GLOBAL_<SERVICE>_<EP>_PORT`, `LANDO_GLOBAL_<SERVICE>_URL`, `LANDO_SCRATCH_ID`, `LANDO_SCRATCH_SOURCE_KIND`, and `LANDO_SCRATCH_ISOLATE`. The bundled MySQL, MariaDB, PostgreSQL, MongoDB, and SQL Server types MUST expose their planned container listen port as the decimal string `LANDO_DB_PORT`. It is connection metadata, not a `ServiceCreds` field or a published host-port assignment.

`LANDO_GLOBAL_*` is projected only for global services required by activated `AppFeature`s (§20.6.3). Plugins MAY add typed projections through `AppFeature.apply()`.

Remote consumers MUST reuse named per-service, per-key environment overrides at execution/start, not a core relationship feature or aggregate variable API. A plugin MAY project vendor-specific names from approved local endpoints or session forwarding (§10.12.5); it MUST name each consumer service and key explicitly.

- The calling scope MUST own override values, secret references, and consumers. Overrides MUST replace only named keys and MUST NOT enter the reusable plan, Landofile, caches, or future-start state. Standalone pull cannot retain secrets for another process's start.
- Invocation-only overrides MUST end with that execution. Start-time secrets MAY be visible to the provider and in its container configuration; Lando MUST NOT promise that removing an in-memory map erases them. Session consumers MUST be stopped/removed at closure, and tether MUST independently revoke forwarding before teardown (§10.12.5).

`lando` services source `/etc/lando/environment` and `/etc/lando/env.d/*.sh`, exposing `LANDO_LINUX_DISTRO`, `LANDO_LINUX_DISTRO_LIKE`, `LANDO_LINUX_NAME`, and `LANDO_LINUX_PACKAGE_MANAGER`. Raw `l337` services receive only authored Compose-level environment, plus `LANDO_HOST_IP` when host reachability applies.

#### 6.9.1 Host agent-context forwarding (`agentEnv`)

`agentEnv` forwards exact-name host markers per invocation to `app:exec`, `app:ssh`, `app:shell --service`, and `providerExec` tooling without entering service plans or caches.

The default allowlist is `CLAUDECODE`, `CLAUDE_CODE`, `CLAUDE_CODE_IS_COWORK`, `CURSOR_AGENT`, `OPENCODE`, `OPENCODE_CLIENT`, `COPILOT_CLI`, `GEMINI_CLI`, `CODEX_SANDBOX`, `CODEX_CI`, `AUGMENT_AGENT`, `ANTIGRAVITY_AGENT`, `PI_CODING_AGENT`, `CLINE_ACTIVE`, `GOOSE_TERMINAL`, `OPENCLAW_SHELL`, `GROK_AGENT`, `AI_AGENT`, `AGENT`, and `CI`. `GROK_AGENT` is forwarded only when its host value is exactly `1`. Patterns fail with `AgentEnvPatternError`. Only present values are forwarded. Precedence is exec request, then task/service declaration, then agent context. Values pass through `RedactionService` for `pre-provider-exec` and other events and transcripts. This is not general host-environment passthrough.

Global `agentEnv.enabled`, `agentEnv.allow`, and `agentEnv.deny` control the resolved list. Top-level `agentEnv: false` disables it per app; host `LANDO_AGENT_ENV=0` disables one invocation. `lando info --deep` reports the names actually present on the host and so forwarded. Host-proxy re-entry forwards only the built-in allowlist.

### 6.10 Service info

Provider-neutral `ServiceInfo` contains `app`, `service`, `api`, `type`, `provider`, `primary`, `status`, the required array `connections`, optional `logSources`, and optional `creds`. `status` is the shared `ServiceState` vocabulary: `unknown`, `stopped`, `starting`, `running`, `healthy`, `unhealthy`, `ready`, `completed`, `restarting`, `paused`, or `error`. `StartedService` (`name`, `state`, `connections`) in `StartAppResult.servicesStarted`, global ready output, restart, and rebuild carry the same `connections` contract; `ServiceConnection` is the only connection-address contract.

**`ServiceConnection`.** Every connection carries `host` (hostname or unbracketed IP), `endpoint` (the `EndpointRef` of the logical listener it originates from, §6.6), `scope`, `source`, `protocol`, `binding`, and `state`. The union is:

| `scope` | `source` | `protocol` | `binding` | Meaning |
|---|---|---|---|---|
| `app` | `listener` | `http`, `https`, `tcp`, `udp` | `assigned` | The service key on the per-app network plus the listener port, for every planned network listener including the container side of a published port |
| `host` | `publication` | `http`, `https`, `tcp`, `udp` | `assigned` or `pending` | A direct host publication of the listener |
| `host` | `route` | `http`, `https` | `assigned` or `pending` | Router ingress for a `RoutePlan`; adds `pathPrefix`, retained in the URL |

An `assigned` connection carries `port`, `url`, `alternateUrls`, and `state` in `active`, `inactive`, or `unknown`. A `pending` connection carries `state` in `inactive` or `unknown` and MUST NOT carry `port`, `url`, or `alternateUrls`: a configured publication whose host port is unassigned, or a route with no ingress authority, is represented without an invented address. The declared listener `protocol` is independent of `appProtocol`, and an unknown secondary TCP publication is never reported as HTTP. Addresses come from the §6.7 listener-target derivation: the service key on the per-app network, or the canonical `<service>.<slug>.internal` alias only when the service has no per-app network and sits on the shared network alone. Unix sockets are excluded because their sharing is not established.

**URL formatting.** One central formatter produces `url` and `alternateUrls` from host, port, protocol, and route path. Hosts are lowercased and stored unbracketed; a wildcard or loopback bind address is reported as the host a local client dials (`0.0.0.0` and `127.0.0.1` as `localhost`, `::` as `::1`). URLs bracket IPv6 hosts, omit default ports `80` and `443` for `http`/`https`, preserve route `pathPrefix`, and keep `tcp://` and `udp://` for unknown transports. Client URI policies are scoped to the declared database listener of the service type: PostgreSQL emits the encoded user and database and never the password; memcached emits `memcached://`; Valkey emits `valkey://` with a `redis://` alternate. Arbitrary secondary or unplanned bindings are not painted as database connections.

`DatabaseConnection` (§6.12.4) is a separate planned credential/primary-port fact, not a scoped address. PostgreSQL URI enrichment reads its canonical family, user, and database only when the TCP listener's container port matches the fact's port; an assigned host publication may use a different port in its URL. Missing facts produce the generic connection URI, without environment scraping or guessed credentials. Neither password descriptors nor resolved passwords enter canonical or alternate addresses, and observation never reads a secret store to format them.

**Observation versus plan.** Configured listeners, publications, and routes are always retained, including pending dynamic ports, so a stopped service reports its addresses as `inactive` rather than erasing them. An `app` listener is always `assigned`; its state follows the service state and is `inactive` when the container is proven missing. A `host` publication is `active` only when an actual `PublicationObservation` binding matches its listener, bind address, and any explicit `hostPort` (§5.3); the connection then reports the observed host port. Without a matching binding, an explicit `hostPort` stays `assigned` and a provider-assigned port stays `pending`, each with state `inactive` (evidence present, or service inactive) or `unknown`. An observed binding that matches no planned publication is still reported, as a `tcp` or `udp` publication of an unnamed, non-primary listener, never as HTTP. A route is `active` only from matching `RouteEvidence` (§10.2); with no configured or observed ingress authority it is `pending`, and with routing disabled it is never `active`. Service state maps to connection activity through one shared rule: `stopped`, `completed`, `paused`, and `error` are `inactive`; `starting`, `restarting`, and `unknown` are `unknown` unless absence is proven; `running`, `healthy`, `unhealthy`, and `ready` permit `active`. Active never asserts health. One collector/projector powers `info`, `start`, `restart`, `rebuild`, and global status as well as the hyperlink, `app:open`, and scanner consumers; no command concatenates routes or erases state on its own. Only `host` connections that are `assigned`, `active`, `http` or `https`, and not wildcard hostnames are eligible for hyperlinks, `app:open`, and HTTP scans; `app` connections are never host-clickable. `info` reads the applied plan when one exists, so connection metadata describes the last applied plan, not necessarily an unapplied Landofile edit.

`ServiceInfo` MUST also carry the planned per-service metadata `artifact`, `user`, `workingDirectory`, resolved `appMount`, `hostnames`, `certs` (state `none`, `generated`, or `custom`), `health`, and optional opaque `providerInfo`; the connection projection does not discharge that obligation. `providerInfo` is the sole provider-specific field; everything else is provider-neutral.

Structured `EndpointPlan` stays the plan contract and `PublicationObservation` stays the provider contract. Library consumers read `EndpointPlan` through `App.plan`; observed bindings come from runtime inspection, not from `App.plan`, `ServiceInfo`, or `app:config`. `ServiceInfo` carries connection addresses only.

`creds` exists only for opted-in types; its password fields are always redacted in `ServiceInfo` (§6.12.4).

### 6.11 Service type and feature contracts

#### 6.11.0 Planning and conformance

Core performs one deterministic pipeline:

1. Resolve each `ServiceType` to `ServiceTypeResolution`, including parent and artifact version resolution. `resolve()` MAY be asynchronous but MUST NOT build a plan.
2. Seed `ServiceFeatureContext` from explicit base and authored environment. `lando` seeds its default feature stack; `l337` seeds only artifact/build plumbing.
3. Apply `ServiceFeature`s in ascending priority.
4. After every service draft is complete, apply activated `AppFeature`s in ascending app-feature priority.
5. Emit provider-neutral `ServicePlan`s.
6. Finalize once in core with capability validation, bind realization, file-sync generation, storage shadows, routes, networking, excludes, and `AppPlan` decoding.

Features MUST emit provider-neutral intent. Service and app features contribute network listeners through `addEndpoint` as declarations only: they MUST NOT read `ports:` or `expose:`, publish host ports themselves, or rely on contribution order for primary selection. A type marks its primary listener `primary: true`. Core keeps the original contributions and finalization replays the single §6.6 normalizer over all of them, so an app feature's endpoint additions never bypass an explicit `endpoints:` list. The app-plan cache input MUST include base, ordered `FeatureRef`s, and `AppFeature` contributions.

An explicitly authored service `webroot` MUST have at least one final `FeatureRef.config.webroot` that is a non-empty string. This is a semantic declaration that the composed feature handles the effective root, as server configuration or context, not proof of HTTP serving. The declaring plugin MUST implement that meaning and own path validation; undefined, null, numeric, and empty values are not declarations. After successful service-type resolution and inherited feature-config deep-merge, core MUST check the original authored field against a provider-independent projection of the final declarations that accounts for planner-owned substitutions, before subsequent capability gates, cache-key construction, and cache lookup. Unsupported explicit input MUST fail with `LandofileValidationError`, the Landofile path, an issue at `services.<name>.webroot`, and actionable remediation. No language/provider blacklist or cache epoch change is needed.

Every type MUST name `l337` or `lando`, return `ServiceTypeResolution`, and satisfy `runServiceCompositionContract`. `lando` receives `lando.env`; `l337` receives no injected environment or scaffolding. Only `lando.env` may invoke `buildLandoEnv`.

Contributed `logSources` MUST have unique ids, absolute paths, and compatible strategies; `console` is reserved. `redirect` requires an owned build, while a BYO/`l337` service may use only `follow`. Feature ordering and inheritance are replay-stable.

`ServiceType` declares `name`, optional `versions`, explicit `base`, optional `extends`, optional `artifacts`, `schema`, and Effectful `resolve` with `ServiceTypeError`. A type that contributes database clients may also expose pure `toolingForConnection(name, connection)`, returning their task definitions from a `ServiceName` and `DatabaseConnection`. A `ServiceTypeError` that rejects the service's configuration SHOULD carry `issues` with paths relative to that service's config; the planner places them under `services.<name>`, so lint and planning name the offending field. When `issues` is absent or empty, the failure applies to the whole service. `ServiceTypeResolution` carries `base`, `normalizedConfig`, `features`, optional `connection` or `nonSqlCreds` (mutually exclusive), optional `tooling`, optional `connectionClientNames`, optional `logSources`, optional `sync` (`defaultDataset` per dataset kind and `postApply` tasks, §10.12.2), and optional `metadata`.

#### 6.11.1 Service-type inheritance (`extends:`)

A type MAY extend one parent, inheriting normalized config, features, tooling, artifacts, and `sync` before child overlay. Normalized config and tooling overlay under §7.2. Feature and log-source lists merge by `id` with child precedence, and same-id feature config overlays under §7.2; an empty child list contributes nothing rather than clearing inherited entries. Inheritance has no diamonds, is bounded, and rejects cycles with `ServiceTypeCollisionError`.

Canonical credentials also survive inheritance. An omitted child credential source inherits the parent's `connection` or `nonSqlCreds`; an explicit child source replaces the parent's source as a whole, never combining both. Each raw resolution rejects simultaneous sources before a later child can conceal the invalid contribution. The nearest explicitly declared `toolingForConnection` replaces the inherited function as a whole, including an empty factory. Existing task-content merging remains unchanged.

`connectionClientNames` carries explicit generated-client provenance, not credentials or a task snapshot. A raw contribution that omits it may seed names from its own declared factory; an explicit array, including `[]`, suppresses that automatic seeding. Without an own factory, untouched parent claims survive, but any child contribution for a task name revokes that name even if its content is identical. Explicit child claims may reauthorize it through the effective factory. An own factory establishes a new claim baseline from its explicit names or its returned names present in merged tooling. Claims are deduplicated deterministically and require a corresponding task, effective connection, and supporting factory output. Direct resolutions and inheritance hops use the same normalization; composed results always carry an explicit array so planner consumers cannot recreate revoked authority by inspecting an inherited factory.

`sync.defaultDataset` and `sync.postApply` MUST merge per dataset kind. An omitted child kind inherits its parent value; a child default Dataset id replaces that kind's parent id. A child `postApply` list replaces that kind's entire inherited list in declaration order, and an explicit empty list clears it; lists MUST NOT concatenate. The final merged defaults participate in §10.12 binding selection, while an explicit binding Dataset still wins. The final task lists run under §10.12.2 grouping and ordering, never once for each ancestor.

#### 6.11.2 Declarative version pinning (`artifacts:`)

`artifacts:` maps exact versions to artifact tags and MAY reference a sibling file. Version ranges are not supported. The `ServiceType` version metadata is the single matrix for planning, docs, and tests. Unknown, absent, or unavailable versions fail before provider action with supported-version remediation and MUST NOT fall back to guessed tags. Resolved tags enter the app-plan cache key.

#### 6.11.3 Service-type-shipped tooling

`ServiceTypeResolution.tooling` merges below resolved Landofile `tooling:`. Conflicts replace whole tasks by name. Between service contributions, the lexicographically first service name wins. A surviving contribution defaults its target to its contributor; `toolingDefaults` fills only unset fields.

For generated connection clients, private tooling metadata records the winning task's contributing service, not another credential or task snapshot. Invocation regenerates the factory-owned defaults from ownership-matched applied connection facts, preserving current unrelated defaults and their parsed expression sites. A current authored whole-task replacement bypasses this generated-client path. Both top-level tooling and event `task:` calls obey the same rule; neither imports applied lifecycle events or old authored tooling. Missing historical connection facts or an incompatible applied client family fail with `PlanReplanRequiredError`, not desired-credential fallback.

The applied service's `serviceTypeId`, not its normalized `type` or the current desired declaration, selects the composed factory. The loaded declaration's ID must match exactly. Missing or unavailable applied declaration identity fails with `PlanReplanRequiredError`; observation and teardown remain supported. Only normal application records new applied identity, not plan-cache refresh or inference from task winners. This identity survives service-record persistence and partial application but does not change physical container-create fingerprints.

Reserved tooling names `run`, `scratch`, and `scratch:*` produce `landofile.tooling` issues in lint and planning; planning aggregates them in one `LandofileValidationError` (§7.8). Service types MUST NOT use `topLevelAlias` while the unsupported tooling-task key list (`UNSUPPORTED_TOOLING_TASK_KEYS` in `@lando/landofile`) rejects it (§8.5).

#### 6.11.4 App-scoped features (`AppFeature`)

`AppFeatureDefinition` declares `id`, optional `schema`, `priority`, optional `AppFeatureActivation` as `activatedBy`, optional `AppFeatureSelectors` as `selectors`, optional `requires.providerCapabilities`, optional `requires.globalServices`, and Effectful `apply`. Activation can match service type or feature; selectors can match `types`, `framework`, `hasFeature`, `names`, or `fromConfig`. A `fromConfig` selector reads one environment snapshot per plan, and the environment variables it reads are part of the `app-plan` cache key, so changing one invalidates the cached selection.

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
| `lando.gpg-agent` | 1210 |
| `lando.host-proxy` | 1250 |
| `lando.bun-self` | 1260 |
| `lando.git` | 1300 |
| `lando.sudo` | 1400 |
| `lando.proxy` | 1500 |
| `lando.user-image` | 1900 |
| `lando.user` | 2000 |

`lando.ssh-agent` mounts the per-app agent relay directory at `/run/lando/ssh-agent` and sets `SSH_AUTH_SOCK=/run/lando/ssh-agent/agent.sock` in both sidecar and host modes (§10.4). `lando.gpg-agent` is opt-in through `gpgAgent.forward`, mounts the gpg relay directory at `/run/lando/gpg-agent`, and sets `GNUPGHOME` to it (§10.4.1). `lando.host-proxy` provides container-to-host RPC and `LANDO_HOST_PROXY_*`. `lando.bun-self` installs container-side Bun under `/usr/local/lib/lando/bun`, sets `BUN_INSTALL_GLOBAL_DIR`, `LANDO_BUN_VERSION`, and `LANDO_BUN_PATH`, and rejects incompatible host-proxy Bun shims with `BunSelfFeatureConflictError`.

### 6.12 Canonical service-type catalog

#### 6.12.1 Catalog

The catalog is bundled from `@lando/service-lando` and focused `@lando/service-*` packages. Supported releases per type are not listed here: each `ServiceType` publishes its version matrix in its service-type metadata and pin manifests, which are the only source of truth, and aliases resolve during planning.

| Type id | Base | Notable options |
|---|---|---|
| `php` | `lando` | `via`, `composer`, `xdebug`, `db_client`, `webroot`, `allowOverride` |
| `node` | `lando` | `command`, `script`, `globals`, `port` |
| `python` | `lando` | `framework` |
| `ruby` | `lando` | `framework` |
| `go` | `lando` | `framework` |
| `nginx` | `lando` | `webroot`, `port`, PHP-FPM `backend` |
| `apache` | `lando` | `webroot`, `allowOverride`, framework presets |
| `mariadb` | `lando` | `creds`, `config.server` |
| `mysql` | `lando` | `creds`, `config.server` |
| `postgres` | `lando` | `creds`, `config.server` |
| `mongodb` | `lando` | `creds`, `config.server` |
| `redis` | `lando` | `password`, `persist` |
| `memcached` | `lando` | none |
| `valkey` | `lando` | `persist` |
| `solr` | `lando` | `cores`, `config.dir` |
| `elasticsearch` | `lando` | index initialization |
| `opensearch` | `lando` | index initialization |
| `meilisearch` | `lando` | `masterKey` |
| `mailpit` | `lando` | `mailFrom` |
| `mailhog` | `lando` | deprecated; removal requires a major version (§18); replacement `mailpit`; emits `deprecation-used` |
| `rabbitmq` | `lando` | management route |
| `minio` | `lando` | bucket initialization |
| `localstack` | `lando` | none |
| `tomcat` | `lando` | `webroot` |
| `varnish` | `lando` | backend, VCL |
| `dotnet` | `lando` | `command` |
| `mssql` | `lando` | `creds`; provider emulation required on arm64 |
| `phpmyadmin` | `lando` | MySQL-family service selection |
| `static` | `lando` | `nginx` or `caddy` backend; `webroot`, build hook |
| `compose` | `l337` | raw supported Compose passthrough |

Schemas publish at `@lando/sdk/schema/services/<type>` (§13.2). Unknown versions fail before provider action.

File-backed options MUST be app-contained, symlink-safe, correct-kind sources, mounted read-only where applicable, and included deterministically in plan/build keys. `solr.config.dir`, database `config.server`, `node.globals`, `node.port`, Redis `password`/`persist`, Mailpit `mailFrom`, Apache `webroot`, commands, users, versions, and packages retain their authored effect and MUST NOT be replaced by hardcoded defaults. `mailFrom` defaults to all PHP services, `false` to none, and validated arrays to named PHP services.

Every canonical or plugin type MUST declare its base, resolve through features, pass `runServiceCompositionContract`, use `runAppFeatureContract` when applicable, avoid direct env-helper access, and expose tooling, credentials, and presets through resolution.

**Default launchers run as the planned user.** A type's default `command` (installed when the author declares neither `command` nor `entrypoint`) runs as `ServicePlan.user`. A type that accepts a non-root `user:` MUST start and keep serving with every user its catalog metadata advertises, without requiring an authored `command` or root-only setup in its launcher. Prefer daemon command-line configuration; when a file is required, use a path writable by the planned user and configure the daemon to read it. Volume-backed write targets require explicit ownership setup; if the provider cannot realize that ownership, planning MUST fail with a tagged error naming the service and option. Shared generated assets use one helper rather than per-launcher copies. The contract is verified by the running service serving its configured content, not merely by successful planning. Provider-specific Compose overrides MUST NOT substitute for a provider-neutral ownership contract. Any remaining privilege requirements, including restricted low ports on the target runtime, MUST be documented for the affected type.

**Listen port follows `port:`.** For typed services, the planned primary listen port is `ServiceConfig.port`, or the type's published default when omitted. Bundled launchers MUST configure that listener, and Lando-owned clients (healthchecks, tooling tasks, database commands, and wired consumers such as phpMyAdmin) MUST use the same port. Supported daemon-native variables for that primary listener MUST be derived from the planned port and projected into the service environment; malformed or unequal authored values MUST fail planning before provider action with an issue at that variable (`services.<name>.environment.<VAR>`). Lando MUST NOT rewrite an authored `command` or `entrypoint` to add listener flags; its author MUST configure the planned port. For MySQL, MariaDB, PostgreSQL, and MongoDB, a Lando-owned launcher loading `config.server` MUST pin the planned port on its command line, including the default. For Apache, the planned port determines `Listen <port>` and, for `php` via `apache`, `<VirtualHost *:<port>>`; a non-default port MUST replace the image's `Listen 80`, not add a listener alongside it. MySQL, SQL Server, and RabbitMQ MUST reject primary-port collisions with their reserved secondary listeners before provider action, with an issue at `services.<name>.port`. RabbitMQ MUST also reject an invalid distribution port or one colliding with AMQP or a reserved secondary listener, identifying `services.<name>.environment.RABBITMQ_DIST_PORT` when it is authored and `services.<name>.port` when the distribution port is derived. Fixed secondary ports MUST be documented as limits in the type's guide. Each type contributes that listener with `primary: true` so selection and reporting identify it without relying on list order (§6.6); a type whose primary is not HTTP (Mailpit's SMTP) marks it primary and contributes its HTTP UI as an unmarked secondary. The primary listener survives `ports:`: publishing it, publishing other ports, or authoring `ports: []` keeps it in the plan with its marking; only an explicit `endpoints:` list removes it (§6.6). Raw `compose` passthrough and the Tomcat custom-image/build exception below retain author-owned daemon configuration.

**Tomcat configuration ownership.** Catalog Tomcat references pair an immutable multi-platform image digest with the reviewed Apache configuration for that exact release (§17.2). For a catalog-owned image, the service feature MUST bake `server.xml` with the planned HTTP port during the image build, including the omitted-port default of `8080`, without a startup-time rewrite. The endpoint and healthcheck MUST use that same port. The separate ROOT context uses the resolved `webroot`; authored `command` and `entrypoint` remain unchanged. An authored image reference equal to the selected exact catalog reference retains this ownership. A custom image or authored `build.context` is the explicit exception to the listener rule above: its author owns the daemon configuration, and Lando writes neither `server.xml` nor a ROOT context. `port:` still declares its endpoint and healthcheck target, which the author's configuration must match.

**`webroot` is relative to the app mount.** `php`, `nginx`, `apache`, `static`, and `tomcat` resolve `webroot` against the effective app mount target, which defaults to `/app` and follows `appMount.target`; `webroot` defaults to `.`, the app root itself. Authors normally write a relative path such as `web` or `public`. An absolute container path is accepted for a document root outside the usual layout. A relative path that leaves the app mount, or a path with characters other than letters, digits, `.`, `_`, `-`, and `/`, MUST fail during planning. With `appMount: false` there is nothing to resolve against: a relative or omitted `webroot` MUST fail during planning, and an absolute one names content the image provides. Generated document-root configuration uses the resolved absolute path; `LANDO_WEBROOT` exposes it only when `appMount` is not `false`. When the app mount is enabled, `php` and `nginx` default their working directory to that path; `apache`, `static`, and `tomcat` default to the app mount target; an authored working directory wins. On a standalone `apache` service an authored `APACHE_DOCUMENT_ROOT` overrides the generated document root. Configuration views such as `app:config` keep the authored spelling rather than the resolved path. Lando 3 translation MUST preserve the served content root where representable, rewrite `webroot` when the Lando 3 layout semantics differ, and diagnose deployment behavior that needs manual configuration (§7.4.1).

**nginx serves its webroot.** Unless the author declares `command` or `entrypoint`, `nginx` generates its own server configuration. Without `backend`, it serves static files from `webroot`; with `backend`, it passes PHP requests to that service's PHP-FPM listener. Either way it listens on `port` and serves Lando's shared 403/404 pages for server-generated errors.

#### 6.12.2 Framework presets

Language types may expose `framework:` presets as ordinary overridable config. A preset's implicit default webroot is relative to the app mount and is omitted when `appMount` is `false`; this MUST NOT silently discard an explicitly authored root. Ruby supplies root context only (`rails` defaults to `public`, `none` to `.`), with authored-over-preset precedence. Its built-in context requires an active mount, so an explicit relative or absolute root with `appMount: false` MUST fail unless another composed feature declares support. Genuine webservers may still use an absolute root without the app mount and without `LANDO_WEBROOT`. Python and Go have no built-in webroot declaration. Framework selection does not start an application server: Ruby, Python, and Go keep their keep-alive command unless the author supplies `command`, and preserve authored `entrypoint`. Unused language command hints are not part of preset config or extensions. Recipes materialize the framework settings they need as concrete service config and tooling. Published ids are `drupal`, `wordpress`, `laravel`, `symfony`, `magento`, `django`, `fastapi`, `flask`, `rails`, `sinatra`, `echo`, `fiber`, and `none`.

Canonical PHP does not interpret framework ids. It uses `webroot` (§6.12.1) and `allowOverride` (default false); recipes own framework choices. Invalid paths fail during planning.

#### 6.12.3 Catalog membership rules

Catalog membership is frozen by this specification; additions or removals require a spec amendment. Version additions MAY ship in a minor release only through the single metadata matrix with available artifacts and matching docs/tests. Canonical collisions fail with `ServiceTypeCollisionError`. Plugins MAY add types and composable features. Library consumers receive the catalog only through bundled discovery (§16.4).

#### 6.12.4 The `creds:` schema

`ServiceCreds` contains literal `user` and `database` plus `password` and optional `rootPassword` as `EnvironmentValue` (§7.3.1). `mariadb`, `mysql`, `postgres`, `mongodb`, `mssql`, and opted-in plugin types share this contract.

A database type resolves its connection exactly once and returns it through `ServiceTypeResolution` as `DatabaseConnection { family, creds, port }`; the planner persists it on `ServicePlan.connection` and exposes it read-only to service and app features. Defaults fill only missing facts. Effective `creds` and any authored native alias (`POSTGRES_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `MONGO_INITDB_ROOT_PASSWORD`, `SA_PASSWORD`, and siblings) MUST agree, and aliases MUST agree with each other, compared as descriptors, never as decrypted values; a conflict fails planning naming both paths without values. After feature composition the planner checks that type-owned projections still agree with the connection.

Initialization environment, `LANDO_DB_*` metadata, generated client environment (`PGPASSWORD` and equivalents), SQL operations, `ServiceInfo.creds`, and the `services.<name>.creds.*` and `services.<name>.port` expression scopes derive from the connection facts. Consumers MUST NOT rescrape the plan environment or apply SQL-specific credential defaults. Projections are typed and deliberate: a bound password stays a `SecretRef`/`BoundText` through every native key, metadata variable, client environment, and URL template, and bundled URL templates use the connection `port` with explicit `url.encodeComponent()` on the password. MongoDB dump/restore pass credentials through a bounded anonymous-fd config, and MSSQL clients read the password from projected environment; no bundled tooling places a secret in argv.

**MongoDB probes.** The `mongodb` type targets its declared primary TCP listener for both probes through `connectionFor(ctx)`. Ongoing health is a Bash TCP dial only, on the existing cadence, and MUST NOT launch `mongosh` or create shell state. Startup readiness performs that dial first, so no client launches while only the image's loopback initialization daemon exists, then a bounded credential-free protocol ping (`mongosh --quiet --norc`, direct connection, bounded server-selection, connect, and socket timeouts) with `HOME` set to a disposable owner-only temporary directory removed on exit. It MUST NOT mutate the container's `HOME`, write under the data volume, add a wire-protocol client, or deploy a helper binary. The generated `mongosh` task distinguishes an authentication rejection from the server with Mongo-owned recovery wording that names restoring the matching credentials or changing the user through an authorized administrator and states that data is retained; any other non-zero script is not classified as an authentication failure, and deleting data is never the prescribed default repair.

A non-SQL type may publish `nonSqlCreds: ServiceCreds` instead of `connection`. Redis derives it from the same resolved `password` used for its initialization and client environments. Fresh service scopes and scopes reconstructed from serialized plans expose these credentials unchanged; they do not infer them from environment or generic normalized configuration. SQL-family services continue publishing only `connection`, with no competing credential copy.

`ServiceInfo.creds` is the string-only `ServiceCredsDisplay`, redacted without any store read. Structured output redacts password fields by default; a type MAY mark additional fields secret. Free-text output follows §3.7, which prints published default credentials, and a literal password or root password equal to its own credential's user or database name, as-is; a value resolved from a reference or explicitly registered stays masked regardless. Clients of an existing database use the applied connection fact and resolve references afresh per operation; Lando does not reconcile a changed store value against a running database or rotate credentials.

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

`BuildOrchestrator.build` defaults `BuildOptions.refresh` to false and acquires referenced artifacts with policy `missing`: reuse a provider-local copy and contact the source only when absent. App, scratch, and global start and restart, including global auto-start, use the default. `app:rebuild` and `meta:global:rebuild` pass `{ refresh: true }` so providers that declare `artifactPull` refresh referenced artifacts with `always`. When a refresh fails, the orchestrator tries the provider-local copy with `never` and on success records command warning `LANDO_ARTIFACT_REFRESH_FAILED`, failing with the original refresh error only when no local copy exists. Interrupts and defects propagate without fallback. Provider policies remain strict. Acquisition policy does not change build-result reuse under §6.13.5.

#### 6.13.4 Failure policy

Artifact failure is fail-fast by default: it interrupts siblings, skips queued work as `phase-aborted`, and fails start. App failure continues independent siblings and raises one `BuildPhaseFailedError` containing `BuildStepFailure`s after `post-build-phase`. App and service overrides MAY change fail-fast behavior; per-step overrides are not exposed. For explicit global lifecycle operations, these failure policies apply within each dependency-connected service group (§20.6.5).

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

`LogSource` contains branded `LogSourceId`, optional label, absolute path, `stdout`/`stderr` classification, `redirect`/`follow` strategy, `required`, and timestamp capability. `console` is reserved for the implicit source. Each source names one file; globs are not supported.

Landofile `LogSourceInput` requires `path` and optionally accepts `id`, `label`, `stream`, and `timestamps`; it always resolves to `follow`. Service types may declare `redirect`.

#### 6.14.2 `LogChunk` source and line

`LogChunk` contains service, optional source, stream, line, and optional timestamp. Missing source means `console`; renderers label interleaved sources.

Each `LogChunk.line` is one complete line; line terminators, including a carriage return at either end, are not part of it. For the console source, providers MUST reassemble engine log messages per stream before emitting: a line written as several partial messages becomes one chunk carrying its first message's timestamp, engine timestamp prefixes on continuation messages are discarded, lines get the same complete UTF-8 framing and line bound as follow sources, and a trailing partial line is emitted only when the stream completes successfully, never on idle, failure, or interruption.

#### 6.14.3 Reification

`redirect` routes owned daemon logs to stdout/stderr during build and requires an owned image path, not `serviceLogSources`. `follow` is implemented by `RuntimeProvider.logs`, never a core shell-out, and requires `serviceLogSources`. Providers that read container files through exec install the static in-container helper (§17.3) once per followed source, serve every read for that source from one helper session, and, when the follow ends or is interrupted, close that session and make one bounded attempt to remove the helper. Removal is best-effort when the container or exec transport is already gone. The helper does not depend on the image's libc.

Without that capability, required follow sources fail with `CapabilityError`; optional sources are explicitly reported unavailable and skipped. Sources are never silently dropped.

#### 6.14.4 Follow semantics

Providers declaring `serviceLogSources` MUST support finite snapshots and scoped follow mode, bounded pending diagnostics for missing files, rotation and truncation, complete UTF-8 line framing, bounded lines, per-source `tail`, timestamp-gated `since`, preserved per-source order, arrival-order merging, and interruption cleanup. No global chronological guarantee or global-total tail exists.

#### 6.14.5 Redaction

Providers return raw `LogChunk`s. Renderer, lifecycle, telemetry, and machine-output boundaries apply `RedactionService` exactly once. Library log streams and app-owned files remain raw.

A line cut by the line bound ends in the SDK truncation marker. Redaction masks any trailing prefix of a known secret value before that marker, so the bound never exposes part of a secret.

#### 6.14.6 Catalog defaults

Catalog types prefer `redirect` for owned Apache, nginx, and PHP-FPM logs; MySQL/MariaDB optional slow/general logs use `follow`; framework file logs are declared by the recipe or type that knows their paths.

### 6.15 Lifecycle apply

`start`, bare `restart`, selected `restart`, and `rebuild` are different operations. Create-config drift is applied by ordinary start (§5.3.2). Rebuild is not that path.

| Command | Contract |
|---|---|
| `start` | Plans and builds with the default cache policy (`refresh: false`, §6.13.3), then applies create-config drift. Keeps unchanged containers and volumes. Has no confirmation flag. After a failed or interrupted attempt it converges: starts matching containers, recreates only drifted ones, resumes an unfinished accelerated-start journal, and reuses healthy workers and file-sync sessions. Init and lifecycle hooks run on every invocation; convergence is about resources, not exactly-once hooks. |
| bare `restart` | Stop, then start. Removes and recreates containers under existing stop semantics. Not an in-place process restart. Uses the default cache policy. With an unfinished accelerated attempt, first resumes it under the same lock (§10.6.3). |
| `restart -s` / `--service` | In-place. No dependency closure. Refuses when the selected container is missing or would be recreated for published-port, bind-source, network, or create-config drift, or a missing `dev.lando.create-config` label. Create-config drift and a missing label fail with `ServiceRestartWouldRecreateError` reason `config`. Remediation is `lando rebuild -s <service>`. |
| `rebuild` | Forced pull (`refresh: true`), cache and app-build refresh, explicit recreate, and confirmation. A floating-tag refresh failure falls back to the local copy and records `LANDO_ARTIFACT_REFRESH_FAILED` (§6.13.3, §12.6). With an unfinished accelerated attempt, first resumes it under the same lock (§10.6.3). `rebuild -s` gives the rebuilt services the running app's host-proxy session and reuses healthy agent relays (§10.10.1, §10.4). |
| explicit `global:start` | Applies new environment, bind, and image configuration. `reconcile: false`. An explicit call is not warm-skipped. `global:rebuild` remains the forced refresh. |

An unchanged `build.app` command whose bind-mounted inputs alone changed retains its cached build result and skips the step (§6.13.5). `rebuild` forces that step to rerun. Changing command text, step user, or artifact inputs changes the build key, so ordinary start reruns the affected step.

Failure and interruption keep established resources at every phase (§6.7); no phase compensates by removing containers, networks, volumes, routes, workers, or sessions, and only acquisition-local cleanup runs (§10.4, §10.6.1, §10.10.2). Full restart and rebuild keep their explicit stop phase but MUST NOT remove routes when the following start fails; selected restart stays in place. Restart and rebuild, full or selected, that find an unfinished accelerated-start journal run the start path first under the app mutation lock, which performs the pending-aware preflight, the transaction check, the init events, and the resumed attempt; the restart or rebuild then continues without running init events again, and a failed resume fails the command (§10.6.3).

Only acquisition-local cleanup runs after failure: an acquisition that was never published and cannot safely be reused (for example a worker without a validated handshake or ownership record, or an incomplete temporary artifact) is finalized. Completed build artifacts stay; temporary files and build children finalize. Containers, including created-but-not-started containers, networks, volumes with creation receipts, valid file-sync sessions, and recorded host-proxy, SSH, and GPG workers stay in place for every error tag. Creation alone MUST NOT count as readiness. Published route configuration stays, including the previous routes when a replacement fails. Shared networks MUST NOT be deleted as compensation. Established SSH/GPG forwarding remains enabled until stop/destroy.

**Failure reporting.** The primary error tag, remediation, and role-annotated additional failures are unchanged, and the machine envelope gains no fields. Human output of `lando start`, `lando restart`, and `lando rebuild` adds exactly one warning after the primary error:

> Start did not complete. Resources were left in place. Running: …; created/stopped: …; unverified: …. Agent forwarding/file sync remain active where established. Inspect `lando info` and `lando logs`; fix the reported error, then run `lando start`. Run `lando stop` to shut down or `lando destroy` to remove resources; volumes require `--volumes`.

The inventory uses a one-second best-effort observation budget; anything unobserved is reported as unverified/unknown, never as stopped. A failure before any app resource mutation says `No app resources changed.` instead of the inventory. Machine output (`json`, `yaml`) omits the warning; agents use `lando info`. Pre-events and actual service-start events still publish on a failed attempt; `post-app-start` / `post-start` publishes only after the readiness barrier succeeds.

---
