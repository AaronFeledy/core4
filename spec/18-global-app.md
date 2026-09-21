# Lando v4 — The Global App

> **Part 18 of 18** · [Index](./README.md)
> **Read next:** *(end of spec)*

The **global app** is the reserved host-level Lando app for services shared across user apps. Plugins contribute those services through `globalServices:`, and `AppFeature` activations declare user-app dependencies on them (§6.11.4).

---

## 20. The Global App

### 20.1 What the global app is

The global app uses the standard `AppPlan`, `RuntimeProvider`, build orchestration, routing, certificates, and app lifecycle contracts (§3.4, §3.5, §5.3, §5.5, §6.13). Its distinguishing rules are:

- Its reserved id, name, and slug are `global`; `AppRef.kind` is `global`.
- Its root is `<userDataRoot>/global/`, owned by Lando.
- Plugins contribute services through `globalServices:`; user overrides remain layered through the Landofile.
- Required services auto-start through `AppFeature.requires.globalServices`.
- Providers with `sharedCrossAppNetwork` expose services at `<service>.global.internal` and through the `LANDO_GLOBAL_*` environment family (§5.4, §6.9, §10.1).
- `apps:poweroff` stops it unless `--keep-global` is set. Destroying one user app MUST NOT affect it.
- `scope: global` storage survives user-app and global-app destruction under §6.5 and §20.9.

The global app is not a daemon, a place to promote user-defined services, or a replacement for `RouterService` or `CertificateAuthority`. The persistent agent remains deferred (§14.2). Plugins MAY contribute new global services but MUST NOT promote a user service into the global app.

### 20.2 Identity

| Field | Contract |
|---|---|
| `AppRef.kind` | `global` |
| `name`, `slug`, id | Reserved literal `global` |
| Root | `<userDataRoot>/global/` |
| Provider | Active default provider from global config; per-app and cross-provider overrides are deferred (§5.9). |

User-authored Landofiles resolving to `global`, including normalized directory names, fail with `AppIdReservedError` and remediation to choose an explicit different name. Inside global services, `LANDO_APP_NAME` and `LANDO_PROJECT` are `global`; `LANDO_GLOBAL_*` is reserved for cross-app discovery.

### 20.3 The global Landofile

The global Landofile is `<userDataRoot>/global/.lando.yml` and follows the six-layer merge order in §7.2. `<userDataRoot>/global/.lando.dist.yml` is the generated plugin layer; users MUST NOT edit it. `GlobalAppService.regenerateDist` is its single writer and overwrites edits. The canonical `.lando.yml` is user-editable, while `.lando.local.yml` and `.lando.user.yml` retain their standard override roles.

The root is created on demand. With no contributions, the generated layer names the app `global` and has no services; the canonical file is created only when a user override is written.

#### 20.3.1 The plugin enablement map

`<userConfRoot>/global.config.yml` stores only the enabled state of each contribution.

- `enabledByDefault` defaults to `true`; an explicit user value wins.
- `meta:global:install` enables all contributions owned by the selected plugin, and `meta:global:uninstall` disables them.
- Disabled services are omitted from the generated plan. Their `scope: global` volumes survive and are reused if re-enabled.
- Service configuration belongs in `<userDataRoot>/global/.lando.yml`, not the enablement map.

#### 20.3.2 Discovery rules

`<userDataRoot>/global/` MUST be excluded from cwd discovery and `cwd-app-map` (§7.1, §12.1). `app:*` commands resolve only user apps; `meta:global:*` resolves the global app explicitly through `GlobalAppService`. `apps:list` excludes it unless `--include-global` or `--all` is set. Global lifecycle payloads carry `AppRef { kind: "global", id: "global", root }`.

### 20.4 The `globalServices:` plugin contribution surface

`globalServices:` is the manifest surface for materializing plugin-owned services into the generated global Landofile.

| Field | Contract |
|---|---|
| `id` | Required service id, globally unique across loaded plugins. Collision raises `GlobalServiceCollisionError`. |
| `module` | Required contained plugin module that returns a `ServiceConfig` through `GlobalServiceContext`. It MUST NOT consume the active provider. |
| `enabledByDefault` | Optional, default `true`; seeds enablement only on first install. |
| `requires.providerCapabilities` | Optional required capabilities. Unsatisfied requirements block materialization with `GlobalServiceCapabilityError`. Cross-app DNS services require `sharedCrossAppNetwork`. |
| `conflicts` | Optional incompatible global service ids; enabled conflicts raise `GlobalServiceConflictError`. |
| `summary` | Optional catalog description. |
| `commands` | Optional canonical command ids for discovery. Each id MUST also exist in that plugin's `provides.commands`; ids remain in their declared namespace and MUST NOT move under `meta:global:*`. |
| `deprecated` | Optional `DeprecationNotice` recorded under §18. |

Contribution evaluation follows the purity and module-containment rules of §7.3.1 and §9.7. It MUST NOT contact providers, bind sockets, or spawn processes. Returned services are schema-validated. Each contribution MUST reference a registered `ServiceType`; unknown types fail plugin registration. Contributions MUST NOT create an identity that could shadow global-app addressing. A plugin MAY pair a contribution with `appFeatures:` that inject user-app environment through `AppFeature.apply()`.

### 20.5 `GlobalAppService` core service

`GlobalAppService` owns the `global` identity and root, generated-layer reconciliation, planning, lifecycle operations, service-scoped `ensureRunning`, contribution enablement, and runtime information. It reuses the retained provider connection and the standard Landofile, planner, build, routing, and certificate services.

Required behavior:

- The service belongs to the `global` bootstrap level and is lazy when included by higher levels.
- `start` and `ensureRunning` are idempotent and reconcile drift. `ensureRunning` limits work to requested service ids.
- `regenerateDist` is the single writer for `.lando.dist.yml` and performs contribution validation, conflicts, capability checks, service-schema validation, and atomic replacement.
- Failures are tagged as listed in §20.13.

### 20.6 Lifecycle

#### 20.6.1 The `global` bootstrap level

`global` sits between `provider` and `app` in the §3.2 ladder. It eagerly adds `GlobalAppService` and lazily adds the global app's planner, `BuildOrchestrator`, `HealthcheckRunner`, `UrlScanner`, and `HostProxyService` when the plan requires them. The `app` level includes lazy access to `GlobalAppService` for auto-start.

`bootstrap: global` is a valid `LandoCommandSpec` value. Plugins MAY use it for commands in their own namespaces; `meta:global:*` remains reserved for core.

Library hosts MAY request this level through `makeLandoRuntime({ bootstrapLevel: "global" })` (§16.3).

#### 20.6.2 Lifecycle event scope

The `Global` scope extends §3.5 with every event below:

| Operation | Events |
|---|---|
| Start | `pre-global-start`, `post-global-start` |
| Stop | `pre-global-stop`, `post-global-stop` |
| Rebuild | `pre-global-rebuild`, `post-global-rebuild` |
| Destroy | `pre-global-destroy`, `post-global-destroy` |
| Generated layer | `pre-global-dist-regenerate`, `post-global-dist-regenerate` |

Start payloads carry the global `AppRef`, plan, trigger, requested service ids, cache status, and timestamp. `pre-global-start` and `post-global-start` MUST fire for every successful `ensureRunning`, including warm no-op checks. Warm checks set `cached: true` and MUST NOT regenerate, contact the provider, or emit a global build block. Explicit `meta:global:start` is never marked cached. On failure, `post-global-start` does not fire.

Generated-layer events carry the trigger, contribution identities, enablement, capability verdicts, and timestamp. Standard Build-scope events and transcript contracts apply when global services build (§6.13, §12.4).

#### 20.6.3 Auto-start integration with user apps

`AppFeature.requires.globalServices` is the only v4.0 dependency declaration for global services. During user-app `pre-start`, after early subscribers and before user-app build, the planner aggregates required ids and calls `GlobalAppService.ensureRunning`.

- A healthy set emits the start pair with `cached: true` and proceeds without provider work.
- A cold or unhealthy set starts the required services with `cached: false` before user-app build.
- A required id absent from the resolved global plan emits `pre-global-start`, fails with `GlobalServiceMissingError`, aborts user-app start, and MUST NOT emit `post-global-start`.

Direct Landofile `dependsOn` syntax remains deferred (§14.2).

#### 20.6.4 Standard event sequence

The global start event pair is nested inside user-app `pre-start`; any required global Build-scope events occur inside that pair. `apps:poweroff` stops user apps, then scratch apps, then the global app. `--keep-global` suppresses the global stop pair.

### 20.7 CLI surface (`meta:global:*`)

| Canonical id | Alias | Bootstrap | Contract |
|---|---|---|---|
| `meta:global:config` | `global:config` | `minimal` | Read or write the canonical global Landofile and enablement map. The generated layer is read-only. |
| `meta:global:destroy` | `global:destroy` | `global` | Destroy services and resources; requires confirmation unless `--yes`. `--purge` follows §20.9. |
| `meta:global:info` | `global:info` | `global` | Report service information; supports `--service` and `--format`. |
| `meta:global:install` | `global:install` | `global` | Enable a plugin's contributions and regenerate without starting. |
| `meta:global:list` | `global:list` | `minimal` | Report catalog state, source plugin, and declared command ids. JSON is the canonical machine shape. |
| `meta:global:logs` | `global:logs` | `global` | Stream logs with standard service, follow, tail, and since filters. |
| `meta:global:rebuild` | `global:rebuild` | `global` | Stop, rebuild, and restart with §6.13 up-to-date semantics. |
| `meta:global:restart` | `global:restart` | `global` | Stop then start. |
| `meta:global:start` | `global:start` | `global` | Start all enabled services or repeated `--service` selections. |
| `meta:global:status` | `global:status` | `global` | Report live runtime status. |
| `meta:global:stop` | `global:stop` | `global` | Stop all running services or selected services. |
| `meta:global:uninstall` | `global:uninstall` | `global` | Disable a plugin's contributions, regenerate, and stop affected services. |

`meta:global:start` and auto-start refuse an absent generated layer when no contribution can materialize it. Install and uninstall accept a plugin package name or contribution id; ambiguity is rejected. `meta:global:config` MUST reject generated-layer writes with `GlobalDistReadOnlyError`. `apps:poweroff` stops the global app by default; `--keep-global` leaves it running.

#### 20.7.1 Top-level alias reservation

The `global:` prefix is reserved under §8.1.2. Plugin aliases using it fail with `CommandAliasConflictError`. User `commandAliases.custom:` MAY remap an alias; canonical `meta:global:*` ids remain callable.

### 20.8 Networking and discovery

#### 20.8.1 DNS

`<service>.global.internal` is the only global-service DNS form. Bare names and `<service>.global` are unsupported. A provider without `sharedCrossAppNetwork` blocks dependent contributions: planning records `GlobalServiceCapabilityError`, doctor reports the mismatch, and `meta:global:list` exposes a blocked state. Enabling a blocked contribution records intent but MUST NOT materialize it.

#### 20.8.2 Environment variables

For each global service required by an active `AppFeature`, the planner projects `LANDO_GLOBAL_<SERVICE>_HOST` and applicable primary port, named endpoint port, URL, and plugin-defined values. Unrequired services MUST NOT leak variables into a user app. Plugins add extras through the standard `AppFeature.apply()` environment mutator (§6.11.4).

#### 20.8.3 Cross-service expression scope addendum

At `app` bootstrap, `globalServices.<name>.{type,primary,creds,hostnames,routes,endpoints}` is a read-only expression scope. The service MUST exist in the global plan and in the consuming app's `AppFeature.requires.globalServices`; other access fails with `ConfigExpressionScopeNotPermittedError` (§7.3.1).

### 20.9 Storage

| Written scope | Global-app behavior |
|---|---|
| `service` | Owned by one global service; removed by destroy and by purge. |
| `app` | Shared across global services; preserved by normal destroy and removed by `--purge`. |
| `global` | Shared under §6.5; survives `meta:global:destroy --purge` and is removed only by `meta:uninstall` (§17.7). |

Global-app resources carry the standard ownership labels plus a global-app marker so `apps:poweroff --keep-global` can exclude them.

### 20.10 Proxy and CA realization through the global app

#### 20.10.1 Default `RouterService` Live Layer

The default `RouterService` Live Layer is refactored to realize routes through the `traefik` service in the global app. `@lando/proxy-traefik` contributes both `globalServices: traefik` and `routerServices: traefik`; an unpaired contribution fails with `ProxyContributionPairError`. `RouterService.setup` ensures the service is running, and route application uses the service's standard managed mounts. The §10.2 interface is unchanged.

Alternative `RouterService` implementations MAY avoid `GlobalAppService`. Selection keeps §4.3 precedence: explicit Landofile selection, global default, plugin `defaultFor`, then sole implementation.

#### 20.10.2 `CertificateAuthority` realization

`@lando/ca-mkcert` remains a host-level `CertificateAuthority` in v4.0 and is not migrated into the global app. Future plugins MAY provide a global-app-resident CA through the existing §4.2 swap contract.

#### 20.10.3 Migration policy

`LegacyProxyContainerDetected` MUST remain the single owner of legacy proxy detection; the preferred-port holder table and `lando3-leftovers` MUST cross-reference it. Plugins MUST NOT add separate proxy-port checks.

- `lando doctor` MUST report the read-only diagnostic and MUST NOT mutate, remove, or independently block resources.
- `meta:setup` and the first global proxy start MUST consult the same owner and fail with `LegacyProxyContainerConflictError` while a conflict remains.
- Detection MUST be provider-aware and bounded under §10.9. Remediation MUST require backup or explicit user confirmation before Lando 3 resources are removed.

### 20.11 Plugins that contribute to the global app

#### 20.11.1 `@lando/service-mailpit` (canonical reference)

The bundled `@lando/service-mailpit` plugin is the reference pairing of a `ServiceType`, enabled `globalServices: mailpit` contribution, `AppFeature.requires.globalServices`, and plugin-owned tooling commands. Its feature projects Mailpit connection values into selected user services without requiring user Landofile changes.

#### 20.11.2 Migration of `@lando/proxy-traefik`

`@lando/proxy-traefik` pairs its existing router contribution with the `traefik` global service. Runtime inspection and logs use the `meta:global:*` surface.

### 20.13 Errors

All errors are tagged and include remediation where applicable:

- `AppIdReservedError`
- `GlobalServiceCollisionError`
- `GlobalServiceCapabilityError`
- `GlobalServiceConflictError`
- `GlobalServiceConfigError`
- `GlobalServiceUnknownTypeError`
- `GlobalServiceMissingError`
- `GlobalDistReadOnlyError`
- `GlobalServiceCommandReferenceError`
- `ProxyContributionPairError`
- `LegacyProxyContainerDetected`, informational and non-blocking
- `LegacyProxyContainerConflictError`, blocking global proxy start while the conflict exists
- `GlobalAppError`, the umbrella for global state-transition failures

This surface also uses the shared `CommandAliasConflictError` and `ConfigExpressionScopeNotPermittedError` tags defined by their owning contracts (§7.3.1, §8.1.2).

### 20.14 Non-goals for v4.0

- Multi-host shared global apps are not supported.
- The global root is not independently relocatable; changing `<userDataRoot>` relocates it (§7.5).
- Per-app or cross-provider global-app selection is deferred with §5.9.
- Explicit Landofile `dependsOn: ["global:<service>"]` is deferred; only `AppFeature.requires.globalServices` applies.
- Users cannot promote user-app services into the global app.
- Plugins MUST NOT register canonical ids under `meta:global:*`; they MAY operate on the global app through commands in their own namespaces.
- `globalServices:` contributions are not sandboxed in v4.0.

---
