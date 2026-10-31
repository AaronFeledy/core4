# Lando v4: The Global App

> **Part 18 of 20** · [Index](./README.md)
> **Read next:** [19 Scratch Apps](./19-scratch-apps.md)

The **global app** is the reserved host-level Lando app for services shared across user apps. Plugins contribute those services through `globalServices:`, and `AppFeature` activations declare user-app dependencies on them (§6.11.4).

---

## 20. The Global App

### 20.1 What the global app is

The global app uses the standard `AppPlan`, `RuntimeProvider`, build orchestration, routing, certificates, and app lifecycle contracts (§3.4, §3.5, §5.3, §5.5, §6.13). Its distinguishing rules are:

- Its reserved id, name, and slug are `global`; `AppRef.kind` is `global`.
- Its root is `<userDataRoot>/global/`, owned by Lando.
- Plugins contribute services through `globalServices:`; user overrides remain layered through the Landofile.
- Required services auto-start through `AppFeature.requires.globalServices`.
- Desired placement follows the host provider (§5). Realized placement is the installed provider holding an applied plan whose `identity.appRoot` exactly equals the global root. The query MUST read contribution-level applied plans without constructing or contacting runtimes; ownership inventories alone MUST NOT claim placement. Multiple realized providers MUST fail as ambiguous with remediation.
- The global app uses the shared placement rule (§5.3.1) against its canonical root. Before creating or applying global services, and before router port acquisition, operations MUST reject differing placement with `AppPlacementError`. Observation and teardown MUST use realized placement, or the host provider when no applied plan exists. `global:destroy --provider=<id> --yes` MUST target one provider explicitly when placement is ambiguous. Only the explicit setup switch (§10.8) MAY retire an old realization and create one on the selected provider; lifecycle commands MUST NOT relocate it.
- Providers with `sharedCrossAppNetwork` expose services at `<service>.global.internal` and through the `LANDO_GLOBAL_*` environment family (§5.4, §6.9, §10.1).
- `apps:poweroff` stops it unless `--keep-global` is set. Destroying one user app MUST NOT affect it.
- `scope: global` storage survives user-app and global-app destruction under §6.5 and §20.9.

The global app is not a daemon, a place to promote user-defined services, or a replacement for `RouterService` or `CertificateAuthority`. A persistent agent is a non-goal (§14.2). Plugins MAY contribute new global services but MUST NOT promote a user service into the global app.

### 20.2 Identity

| Field | Contract |
|---|---|
| `AppRef.kind` | `global` |
| `name`, `slug`, id | Reserved literal `global` |
| Root | `<userDataRoot>/global/` |
| Provider | Desired: host provider. Realized: exact-root applied-plan owner. Per-app `provider:` MUST NOT change global placement. |

User-authored Landofiles resolving to `global`, including normalized directory names, fail with `AppIdReservedError` and remediation to choose an explicit different name. Inside global services, `LANDO_APP_NAME` and `LANDO_PROJECT` are `global`; `LANDO_GLOBAL_*` is reserved for cross-app discovery.

### 20.3 The global Landofile

The global Landofile loads from `<userDataRoot>/global/` through the same root pipeline as user apps: all six §7.2 layers accept YAML or TypeScript, conflicting forms fail with `LandofileFormConflictError`, and each file resolves its includes before layer precedence using `<globalRoot>/.lando.lock.yml` under §7.7. `<userDataRoot>/global/.lando.dist.yml` remains the generated plugin layer; users MUST NOT edit it. `GlobalAppService.regenerateDist` is its single writer and atomically replaces managed content; a foreign file or manual edit fails with `GlobalDistConflictError`. A sibling `.lando.dist.ts` is a normal form conflict. The canonical `.lando.{yml,ts}` is user-editable, while local and user layers retain their standard override roles.

After composition and before expression materialization, the runtime MUST impose `name: global` and the host provider (§20.2), replacing their authored origins and discarding pending expression sites at or below those fields. Literal values, `!reset`, and load- or planner-owned expressions MUST NOT change this identity. View and validate load a canonical `.lando.ts`; `global:config set|unset|edit` MUST refuse it with `NotImplementedError` and direct the user to edit the source, as for app config writes (§8.2.1).

The root is created on demand. With no contributions, the generated layer names the app `global` and has no services. Installation seeds a comment-only canonical `.lando.yml` when neither canonical form exists; it MUST preserve existing canonical files and MUST NOT create YAML beside a canonical `.lando.ts`.

#### 20.3.1 Owned global service policy

`<userConfRoot>/global.config.yml` stores desired policy, separately from service configuration and runtime reconciliation receipts. Its strict YAML shape is `{ revision, plugins }`, where `revision` is a nonnegative safe integer and `plugins[package]` contains optional `enabled` plus `contributions[id]` entries with required `defaultEnabled` and optional `enabled`. Unknown keys, invalid values, and corrupt documents MUST fail with `GlobalAppError` operation `policy`; readers MUST NOT discard or reset policy.

- Effective enablement uses an individual contribution's `enabled` override, then its owning plugin's `enabled` policy, then the contribution's recorded `defaultEnabled`. `enabledByDefault` defaults to `true` and seeds only a previously unseen owned contribution. Plugin upgrades MUST NOT change recorded defaults.
- Policy is owned by the exact plugin package and contribution id. Removed plugins and contributions retain their policy. Retained policy MUST NOT claim another plugin's contribution or suppress an independently authored service with a reused id. An id retained under multiple owners is ambiguous; callers select its package instead.
- `meta:global:enable <selectors...>` and `meta:global:disable <selectors...>` accept exact contribution ids or plugin package names. The selector list is nonempty unless `--all` is supplied; selectors and `--all` are mutually exclusive. Unknown, empty, or ambiguous selectors fail before policy changes.
- An id selection writes only that owned contribution's override. A package selection writes plugin policy and clears all its individual overrides, including retained entries. Future contributions inherit that package policy. `--all` applies package policy to every known or retained plugin; it does not preemptively configure unknown future plugin packages.
- Enable records intent and regenerates eligible configuration without starting containers. Disable records intent, removes selected owned containers, withdraws selected routes, and regenerates configuration, retaining all named volumes, shared networks, applied state, and authored files. Anonymous volumes follow their container (§6.5). Neither command changes policy implicitly for unselected dependents.
- Before disabling a required contribution, known enabled reverse dependencies MUST be included explicitly through contribution selectors or an owning package selection. An incomplete selection fails before the policy write. Required dependencies MUST NOT be silently enabled, and disable MUST NOT silently cascade. An unrelated module failure MUST NOT prevent saving an otherwise valid disabled intent. Unavailable runtime inspection follows the consumer-protection preflight below; it cannot be silently treated as absence of consumers.
- `meta:global:reconcile` preserves explicit choices, records defaults for newly discovered owned contributions, retries pending cleanup, and regenerates eligible configuration. It MUST NOT start services or replace disabled policy with defaults. Automatic configuration reconciliation and `ensureRunning` obey the same policy.

The policy write uses advisory-locked compare-and-swap against the revision validated by the command. A changed policy advances the revision exactly once; an unchanged policy retains its revision. A concurrent revision change MUST fail with remediation to retry against the new policy, never silently merge a candidate validated against stale dependencies or capabilities.

Disable and reconcile MUST identify running user and scratch consumers before policy compare-and-swap. Impact entries contain `{ id, name, kind, root, provider, services, globalServices, routes }`, where `kind` is `user` or `scratch`. Applied metadata is enumerated for every registered provider, including retained cross-provider requirements; live inspection covers relevant or uncertain evidence on their owning providers. A demonstrably unrelated provider with clean empty inventory MUST NOT be probed merely because it is registered. Unreadable, incomplete, or unavailable inspection is uncertainty, never proof that no consumer is running.

Known running consumers or unresolved consumer inspection MUST refuse by default with `GlobalConsumerProtectionError`, `policySaved: false`, affected consumers, uncertainties, and remediation before any policy write. `--allow-disruption` on disable or reconcile is an explicit acknowledgement for that invocation only and bypasses only this consumer refusal. It MUST NOT bypass global contribution dependency checks, ownership checks, readiness/admission guards, or named-volume retention; it MUST NOT stop dependent apps. The acknowledgement is never persisted, and reconcile MUST repeat the current consumer check. Acknowledged unavailable cleanup evidence can still leave the saved disabled intent with pending ownership-safe reconciliation.

Active global or consumer activation separately reserves the global service ids it is applying or relying on. Disable and reconcile MUST refuse an intersecting selection before policy compare-and-swap with `GlobalConsumerProtectionError` and `policySaved: false`, even with `--allow-disruption`. The reservation covers provider-internal service lifecycle hooks and the rest of the admitted activation, before a new consumer is visible in provider inventory. A private `Context.Reference` supplies one scoped shared `Ref` registry for the held global coordinator, containing activation entries, an activation epoch, and the active policy-mutation owner. Entries identify the canonical policy file, activating app, reserved ids, and actual global root for diagnostics. Nested canonical commands, SDK calls, event dispatch, and sibling fibers sharing the coordinator MUST observe that state. Reservation identity follows the shared policy file: different actual global roots sharing that policy MUST remain protected, while distinct policy identities remain independent. State exists only for the scoped coordinator and MUST NOT create durable files or a process-global registry. Cross-process calls MUST own their own mutation lease and cannot borrow the activation owner's lease (§12.7.1); a recognized descendant therefore refuses at lock acquisition before reaching policy admission. Unrelated fibers/processes remain serialized by the global coordinator.

A short coordinator gate serializes activation-entry publication and removal, policy-owner changes, and the final reservation check plus policy compare-and-swap. A real policy mutation MUST hold its phase claim throughout preflight, compare-and-swap, cleanup, generation, and receipt persistence. A second nested or sibling policy mutation MUST refuse immediately with `GlobalAppError` operation `policy-coordination`; new activation MUST refuse while that claim is held with operation `consumer-admission`, retained as the cause when consumer startup wraps it in `GlobalAutoStartError`. Existing activation entries continue protecting their selected ids. This prevents a new activation or a disable-then-enable sequence from adopting resources while an earlier cleanup is still in progress. Read-only previews MAY observe the state without claiming mutation ownership. Scoped finalization MUST release each activation entry and policy claim on success, failure, or interruption. Refusal directs the caller to finish the active operation before retrying separately.

#### 20.3.2 Eligibility, authored layers, and reconciliation

One resolver MUST decide eligibility for catalog listing, effective config view and validation, candidate writes, generated configuration, and runtime admission. Each current contribution reports `id`, `plugin`, policy `enabled`, `source` (`default`, `plugin`, or `contribution`), `state` (`enabled`, `disabled`, `blocked`, or `unverified`), `capabilitySource` (`declared`, `runtime`, or `unavailable`), `reasons`, required service ids, and dependency-evidence availability. Disabled is a policy verdict; blocked and unverified MUST retain enabled intent.

Read-only list and config resolution use declared capabilities for the selected host provider and platform without constructing, starting, or connecting to a runtime. Missing declarations mean unknown evidence, not known unsupported capability: a contribution requiring them becomes `unverified`. Runtime admission runs the same algorithm with actual acquired capabilities. Enabled conflicts, module failures, required dependency cycles, and unavailable required contribution dependencies block their affected graph. Capability blocks and uncertainty MUST NOT implicitly enable or disable policy.

Resolution is staged. Policy, capability, module, and conflict verdicts determine direct eligibility before composition. Required dependency closure is decided from the effective authored service graph after generated defaults and all authored layers compose; a default dependency MUST NOT prune a contribution before a legitimate authored override can replace it. List and status project this effective graph when materialized configuration validates. If authored composition fails, they remain readable with explicit diagnostics that eligibility rows fall back to plugin defaults and saved policy; that fallback MUST NOT assert the authored graph is valid or ready.

Only currently owned contribution ids that resolve disabled, blocked, or unverified are excluded from generated and effective config. Exclusion applies after layer composition and before strict runtime validation and deferred expression evaluation, including when a whole-service-map expression produces the id. Authored files and includes remain unchanged. Re-enabling or restoring eligibility brings their overrides back. An obsolete owner policy MUST NOT suppress a new authored service at its former id.

Saved policy is desired intent, not evidence that cleanup completed. Reconciliation tracks independent phases `evidence`, `containers`, `routes`, and `generation`. Failure of one phase MUST NOT unnecessarily suppress independent cleanup or generation. Completed container removals and generation remain completed; partial failure MUST NOT roll back policy or successful runtime work. A retry MUST reconcile selected routes even when containers have already gone.

Destructive cleanup requires matching applied ownership evidence and targets only selected services. Missing or unreadable evidence MUST leave cleanup pending. A retained route definition without its applied plan cannot be reconstructed selectively and MUST remain pending rather than be falsely reported withdrawn. Unselected owned containers, named volumes, and active routes MUST be preserved. No per-contribution app identities or persistent controller are introduced.

A bounded durable reconciliation receipt is stored separately under the actual global root. It carries policy revision, operation, selected contribution ids, completed container removals, and pending phase entries `{ phase, services, message }`, never service configuration or credentials. `GlobalPolicyReconciliationError` reports `operation`, `revision`, `policySaved`, `contributions`, `plugins`, `servicesRemoved`, `pending`, underlying `causes`, and remediation to inspect status, fix the cause, and run `global:reconcile`. A generation-only success MUST NOT erase pending evidence, container, or route work. Read-only status MUST expose desired policy, observed runtime state, and durable pending work even when desired Landofile validation fails.

Pending route work clears only after the corresponding owned route definition was successfully updated or removed through `RouterService`. A new policy revision, regenerated config, or newly absent metadata MUST NOT erase that obligation or stand in for a successful route write.

Pending cleanup MAY retain bounded target provenance `{ id, plugin, root, provider, appliedServiceHash }` so removal can be retried after a plugin disappears. Retry MUST recheck matching applied root, provider, and service fingerprint, retained disabled owner policy, and the absence of a newly authored service at that id. Missing or mismatched provenance MUST leave cleanup pending. An explicit successful whole-app stop or destroy can prove whole-app resource and route cleanup without changing policy; route-only withdrawal can clear only route work, never uncertain container ownership.

All global mutations acquire process-owned leases in this order: canonical policy identity, canonical actual global root, then route mutation locks when needed. Policy identity is the canonical authoritative `StateStore` bucket path returned by `globalPolicyBucket().path`, normally `<userConfRoot>/global.config.yml`; its lease lives under that policy file's parent, independently of the user-data root. The actual-root lease follows `GlobalAppService.paths.root` and likewise identifies the physical runtime root independently of user-data placement. Hosts sharing either policy or physical runtime MUST serialize even when their other roots differ. Policy commands, start, stop, restart, rebuild, destroy, `ensureRunning`, config writes, and router setup hold the coordinator across their complete mutation. Lock ownership MUST NOT expire while its live owner is working, and policy compare-and-swap remains required.

Nested commands and SDK calls reenter through the owning process's Effect context only for the same canonical policy-and-actual-root pair. Switching either target within that held context MUST refuse with `StateStoreError`, reason `lock`, operation `nestedGlobalPolicyMutation`. Acquiring the policy coordinator from inside an already-held bare actual-global-root lock MUST refuse with operation `globalPolicyLockUpgrade`, rather than invert lock order. Global coordination wraps those errors as `GlobalAppError` operation `coordination` while retaining their causes and remediation. Child CLI processes follow the independent lease-ownership contract of §12.7.1. A stale concurrent startup MUST NOT reapply a disabled contribution.

Startup admission captures canonical policy content and revision before pre-start or pre-rebuild hooks. It rechecks after hooks, before destructive work, and after each build before that group's provider apply or retained-plan metadata write. After readiness, it MUST recheck again after fresh sibling inventory and immediately before route publication or withdrawal, so a retained plan cannot republish routes changed by a nested policy operation. A nested hook that saves changed policy and then fails generation still invalidates the outer admission. `GlobalAppError` operation `startup-admission` MUST abort stale application rather than re-enable services from the prepared plan.

The actual global provider-apply body takes a temporary reservation for its selected ids after those pre-hook/build checks, using the same reservation contract as user/scratch consumer activation. Policy changes from earlier pre-start or build hooks remain possible and cause the outer stale admission to abort. A disable from inside provider service-apply hooks instead refuses before saving policy while that reservation is active. This coordination belongs to the engine admission boundary and MUST NOT couple the container runtime to global policy storage.

#### 20.3.3 Discovery rules

`<userDataRoot>/global/` MUST be excluded from cwd discovery (§7.1). `app:*` commands resolve only user apps; `meta:global:*` resolves the global app explicitly through `GlobalAppService`. `apps:list` excludes it unless `--include-global` or `--all` is set. Global lifecycle payloads carry `AppRef { kind: "global", id: "global", root }`.

### 20.4 The `globalServices:` plugin contribution surface

`globalServices:` is the manifest surface for materializing plugin-owned services into the generated global Landofile.

| Field | Contract |
|---|---|
| `id` | Required service id, globally unique across loaded plugins. Collision raises `GlobalServiceCollisionError`. |
| `module` | Required contained plugin module that returns a `ServiceConfig` through `GlobalServiceContext`. It MUST NOT consume the active provider. |
| `enabledByDefault` | Optional, default `true`; seeds the owned contribution's recorded default only once. |
| `requires.providerCapabilities` | Optional required capabilities. Known missing requirements block materialization; unavailable capability evidence yields unverified eligibility. Both verdicts retain enabled policy and report the affected capabilities. Cross-app DNS services require `sharedCrossAppNetwork`. |
| `conflicts` | Optional incompatible global service ids; enabled conflicts block both contributions and raise `GlobalAppError` with operation `resolution` when admission is required, identifying the contributions and how to disable one. |
| `summary` | Optional catalog description. |
| `commands` | Optional canonical command ids for discovery. Each id MUST also exist in that plugin's `provides.commands`; ids remain in their declared namespace and MUST NOT move under `meta:global:*`. |
| `deprecated` | Optional `DeprecationNotice` recorded under §18. |

Contribution evaluation follows the purity and module-containment rules of §7.3.1 and §9.7. It MUST NOT contact providers, bind sockets, or spawn processes. Returned services are schema-validated. Each contribution MUST reference a registered `ServiceType`; unknown types fail plugin registration. Contributions MUST NOT create an identity that could shadow global-app addressing. A plugin MAY pair a contribution with `appFeatures:` that inject user-app environment through `AppFeature.apply()`.

### 20.5 `GlobalAppService` core service

`GlobalAppService` owns the `global` identity and root, generated-layer reconciliation, planning, lifecycle operations, service-scoped `ensureRunning`, contribution enablement, and runtime information. It reuses the retained provider connection and the standard Landofile, planner, build, routing, and certificate services.

Required behavior:

- The service belongs to the `global` bootstrap level and is lazy when included by higher levels.
- `start` and `ensureRunning` are idempotent and reconcile drift. `ensureRunning` limits work to requested service ids.
- Shared resolution performs contribution, conflict, capability, dependency, and service-schema validation before generated-layer reconciliation. `regenerateDist` is the single writer for `.lando.dist.yml` and owns managed-content validation and atomic replacement.
- Bind sources written as `~` or `~/...` MUST resolve against the user's home, not the global root, and MUST NOT be created by generated-layer reconciliation.
- `providerId` resolves the provider holding the applied global plan for the canonical global root, else the host provider (§5). It reads applied state only and MUST NOT construct, initialize, or contact a runtime.
- Failures are tagged as listed in §20.13.

### 20.6 Lifecycle

#### 20.6.1 The `global` bootstrap level

`global` sits between `provider` and `app` in the §3.2 ladder. It eagerly adds `GlobalAppService` and lazily adds the global app's planner, `BuildOrchestrator`, `HealthcheckRunner`, `CheckRunner`, and `HostProxyService` when the plan requires them. The `app` level includes lazy access to `GlobalAppService` for auto-start.

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

Start payloads carry the global `AppRef`, plan, trigger, requested service ids, cache status, and timestamp. `pre-global-start` and `post-global-start` MUST fire for every successful `ensureRunning`, including verified warm reuse. A warm hit sets `cached: true` and skips generated-file reconciliation, planner, build orchestration, and provider apply, but MUST perform fresh provider reads to verify owned running identity and readiness. It MUST NOT emit a global build block. Explicit `meta:global:start` is never marked cached. On failure, `post-global-start` does not fire.

Warm reuse is limited to a successful configuration, plan, and completed build retained in the same runtime. Admission MUST revalidate policy revision and content, contribution catalog, effective config and environment, provider capabilities, and loaded-source hashes; freshness also includes the generated layer and authored/include inputs used by that plan. Changed or untracked inputs, uncertain provenance, dynamic TypeScript, remote sources without complete freshness proof, secret-dependent values, and dynamic untracked build inputs MUST take the cold path. A healthy-looking container alone MUST NOT authorize a cache hit. Reuse requires no daemon or persistent controller and MUST NOT claim zero-provider access.

Destroy payloads carry the global `AppRef`, `evidence` (`applied`, `orphans`, or `owned`), `purge`, and timestamp; `post-global-destroy` adds `outcome` (`destroyed` or `unchanged`). Only `meta:global:destroy` publishes them: global stop shares the teardown path but publishes no destroy events. `pre-global-destroy` fires before any destructive step; `post-global-destroy` fires after resource teardown and route withdrawal succeed, and a failure skips it. A destroy with no teardown evidence publishes neither. Global `--purge` removes volumes only.

Generated-layer events carry the trigger, contribution identities, enablement, capability verdicts, and timestamp. Standard Build-scope events and transcript contracts apply when global services build (§6.13, §12.4).

#### 20.6.3 Auto-start integration with user apps

`AppFeature.requires.globalServices` is the only hard dependency declaration for global services. During user-app `pre-start`, after early subscribers and before user-app build, the planner aggregates required ids and calls `GlobalAppService.ensureRunning`.

- A fresh retained set whose owned running identity and readiness are verified with current provider reads emits the start pair with `cached: true`, skipping regeneration, planning, building, and apply.
- A cold or unhealthy set starts the required services with `cached: false` before user-app build. Shared services started this way stay up when the user-app start later fails or is interrupted; a failed user app never undoes global services.
- A required id absent from the resolved global plan emits `pre-global-start`, fails with `GlobalServiceMissingError`, aborts user-app start, and MUST NOT emit `post-global-start`.

User and scratch activation MUST close the race between a successful global ensure and their own build/apply. After build, the final activation boundary installs its required-id reservation before the final `ensureRunning`, then verifies fresh admission before its actual provider-apply and route-publication body. The reservation remains active through that body. A consumer cannot apply or publish against a dependency disabled since its earlier ensure or adopt a resource while policy cleanup is handing it off. The disable preflight, policy-mutation claim, and this final admission check form one safety contract; consumer scanning alone is insufficient.

Direct Landofile `dependsOn` syntax for global services is not part of this contract (§14.2).

The §10.4 SSH sidecar is not declared through `requires.globalServices`. The SSH overlay ensures the sidecar best-effort through `SshService.setup`, only when its agent does not answer, and its failure never aborts user-app start. The bundled sidecar's `setup` calls `ensureRunning`, so that start emits its own `pre-global-start`/`post-global-start` pair (`triggeredBy: "ensure-running"`).

#### 20.6.4 Standard event sequence

The global start event pair for required services is nested inside user-app `pre-start`; any required global Build-scope events occur inside that pair. The SSH sidecar's best-effort start pair (§20.6.3) fires at start-time overlay resolution, only when the sidecar needed starting: in start and restart that is after the required-service pair and before the user-app build; in a service-scoped rebuild it follows the selected services' artifact build and precedes their provider apply. `apps:poweroff` stops user apps, then scratch apps, then the global app. `--keep-global` suppresses the global stop pair.

#### 20.6.5 Restart, rebuild, and router revalidation

`meta:global:restart` checks placement (§20.1), then runs `stop` then `start`; a placement failure MUST leave the global app and its route definition untouched; `meta:global:rebuild` is regenerate, destroy, build, then apply. The stop phase withdraws the route definition exactly as `meta:global:stop` does, so a restart whose start phase fails leaves it withdrawn until a fully successful start publishes it. None of `meta:global:start`, restart, or rebuild reaches `RouterService.setup` or `prepare`, which are reached only from app start, `lando setup`, and doctor's proxy fix. Changed installation `router:` ports therefore take effect on the next of those, not on a global restart. Restart and rebuild MUST call `RouterService.revalidateStartup` (§10.2) only when their successfully applied subset includes the selected router, including partial startup whose router was applied. They MUST NOT re-evaluate contribution modules merely to reconstruct that attempted selection after failure. Disabled, excluded, or failed-to-apply routers MUST NOT trigger startup probing. Without an existing global-service failure, a classified watcher failure MUST fail the command with `RouterWatcherError`; otherwise the global-service failure remains primary and the persisted watcher diagnostic MUST remain doctor-visible. The diagnostic clears only when an actually running router yields a healthy startup observation; absence or disabled policy is not proof of recovery. The restart result schema is the start result schema, and the error channel adds `ProxyError` and `RouterWatcherError`.

Router ingress status MUST NOT treat a persisted routing-ready marker as proof that the service is still running. The Traefik implementation checks fresh exact-root/provider ownership observations; missing or unavailable evidence cannot advertise running ingress. It invalidates only derived readiness evidence when running presence cannot be established, preserving durable route definitions and historical watcher diagnostics. Revalidation of a missing, stopped, or unverified router MUST skip advertised-port probes and log re-observation, and MUST NOT recreate the ready marker.

Explicit global start, restart, and rebuild MUST attempt selected services and their dependencies in dependency-connected groups. A typed build or apply failure in one group MUST NOT prevent independent groups from being attempted or cause successful groups to be rolled back. Successful services stay running. A failed group keeps the containers, networks, volume creation receipts, workers, and sessions it established (§6.7); the next explicit global start converges on those service resources. Partial failure MUST remain a command failure and MUST NOT publish `post-global-start` or `post-global-rebuild`. Explicit global commands do not emit the §6.15 incomplete-start warning, which belongs to app `start`, `restart`, and `rebuild`. The route definition is one app-wide resource, not a per-group resource: if any group fails, the one previously published definition is left unchanged.

After committed apply, every successfully applied group MUST pass the §6.7 readiness barrier before success events. Readiness verdicts are group outcomes: a failed readiness group joins the partial-failure aggregate and keeps its established service resources; independent successful groups remain applied and running. If any group fails, the previously published route definition is left unchanged. Restart and rebuild MUST revalidate the router even if readiness fails after apply, without replacing the primary failure. Warm cached `ensureRunning` skips the post-apply barrier because it performs no apply, but its own fresh provider identity/readiness check MUST succeed (§20.6.2); cold starts run the full barrier.

The global app owns one route definition. `RouterService` does not expose a read of that definition (`observeRoutes` returns read-only evidence for requested routes, §10.2, not the definition), and provider applied state precedes publication, so a partial result MUST NOT be merged or reconstructed. If any selected group fails, explicit global start, restart, and rebuild MUST return before `RouterService.applyRoutes`, including before empty-set removal and before disabled-routing removal. The one previously published definition stays unchanged. A command whose groups all succeed publishes through `RouterService.applyRoutes` alone, as before: the definition contains exactly the routes of services the command started plus those of unselected services the global app's provider observes running, paused, or restarting under the global app root. A fully successful selected start publishes current routes for the services it applied while retaining prior routes for eligible, observed active unselected siblings. On that success path, routes of stopped, missing, or failed services are withdrawn; an empty set removes the definition; with routing disabled, or when the global plan declares no routes, the definition is withdrawn instead (§10.2) without router setup. Explicit stop and destroy own route removal. Started and rebuilt rows report their published route URLs. When routing is enabled and the global plan declares a service whose id is the active `RouterService.id`, a `meta:global:start` selection that contains a routed service also starts that service with its dependencies and reports it in `servicesStarted`, so the command never starts a service it does not report.

Selective startup MUST keep its desired admission/build plan separate from recorded realization. Before apply, it verifies prior sibling resources under the same canonical root and provider. Applied metadata for observed unselected siblings retains their prior service, store, network, and route references; current desired settings MUST NOT claim an unapplied sibling update. Still-present disabled siblings retain cleanup ownership metadata but contribute no routes and cannot enter the execution selection. Incompatible shared store/network definitions or route identities fail before selected apply. Successful selected builds replace only their own recorded service metadata. Historical retention prevents cache seeding until a later ensure can establish a complete desired-plan record.

### 20.7 CLI surface (`meta:global:*`)

Bootstrap levels for these commands are declared once in the §8.1 command registry; this table carries only the per-command contracts.

| Canonical id | Alias | Contract |
|---|---|---|
| `meta:global:config` | `global:config` | Read or write the canonical global Landofile using current contribution eligibility; policy is separate. `set`, `unset`, and `edit` follow the §8.2.1 shared mutation workflow, including its format-preserving, fail-closed write and no-op rules. The generated layer is read-only. |
| `meta:global:destroy` | `global:destroy` | Destroy services and resources; requires confirmation unless `--yes`. `--provider=<id>` restricts applied evidence and cleanup to that provider. `--purge` follows §20.9. |
| `meta:global:disable` | `global:disable` | Save disabled intent for explicit selectors or `--all`, remove ownership-verified selected containers and routes, and regenerate. Named volumes and unselected services survive. Partial work follows §20.3.2. |
| `meta:global:enable` | `global:enable` | Enable explicit selectors or `--all` and regenerate eligible configuration without starting. Package selection applies to current and future owned contributions (§20.3.1). |
| `meta:global:info` | `global:info` | Report service information; supports `--service` and `--format`. |
| `meta:global:list` | `global:list` | Report revision, eligibility and policy source for current contributions, declared command ids, and retained owner policies without provider runtime construction. JSON is the canonical machine shape. |
| `meta:global:logs` | `global:logs` | Stream logs with standard service, follow, tail, and since filters. |
| `meta:global:rebuild` | `global:rebuild` | Regenerate, destroy, build, apply, then publish routes, followed by router revalidation (§20.6.5); referenced artifacts refresh under §6.13.3 and build results follow §6.13.5. |
| `meta:global:reconcile` | `global:reconcile` | Preserve policy, record missing defaults, retry pending cleanup, and regenerate eligible configuration. Never starts services. |
| `meta:global:restart` | `global:restart` | Stop, then start, then router startup revalidation (§20.6.5). |
| `meta:global:start` | `global:start` | Start all eligible enabled services or repeated `--service` selections with their dependencies, then publish routes (§20.6.5). Never changes explicit policy. |
| `meta:global:status` | `global:status` | Report desired policy, observed runtime status, and pending reconciliation independently of desired Landofile validity. |
| `meta:global:stop` | `global:stop` | Stop all running services or repeated `--service` selections. |

`meta:global:stop` with no selection is the §5.3.1 teardown. `--service`/`-s` is repeatable and stops and removes exactly the observed containers of the named services, with no dependency expansion. It MUST retain applied state, all named volumes, the shared network, and unselected containers and their active routes. With no applied plan and no owned runtime resources it reports `unchanged`, even with selections. When an applied plan exists, unknown or empty service names MUST fail before any mutation. An otherwise valid selected orphan request (orphaned resources, no applied plan) fails closed with `AppResolveError` (§5.3.1). A retry reconciles the selected services' routes even when their containers were already removed, while `servicesStopped` lists only containers actually removed, so an `unchanged` container receipt MAY accompany route reconciliation. Later app starts MAY start a stopped global service again (§20.6.3).

`meta:global:start` and auto-start refuse an absent generated layer when no contribution can materialize it. Policy commands have no confirmation or purge flag; `enable` and `disable` require selectors or `--all`, while `reconcile` has neither. Start and stop are runtime operations, not persistent policy switches. `meta:global:config` MUST reject generated-layer writes with `GlobalDistReadOnlyError`. `apps:poweroff` stops the global app by default; `--keep-global` leaves it running.

Enable, disable, and reconcile accept `--dry-run`. A preview returns `dryRun: true`, `policySaved: false`, and reviewable impact: requested desired state, whether policy changes, contribution and plugin selections, dependency blockers, affected consumers, the invocation's `allowDisruption` acknowledgement, affected service/hostname route pairs, retained-volume policy, evidence uncertainties, and validation errors. It MUST NOT write policy, generated files, include pins, cache material, reconciliation receipts, transaction recovery, or provider resources. Read-only provider observations MAY refine impact; unavailable evidence stays explicit. Preview can succeed while reporting blockers or validation errors and MUST NOT imply successful admission or reserve the inspected revision. The real operation revalidates before mutation.

A dry-run nested in the activation's Effect context MUST report intersecting in-process reservations. A separate process observes available policy and runtime impact without acquiring a mutation lease or inspecting another process's private reservations. Its preview MUST NOT imply admission to mutate during that activation; a real mutation acquires its own lease and repeats admission against current state.

Policy and service configuration are independent: `meta:global:config` view, validation, and writes MUST use the same eligibility resolver as startup. Editing an override MUST NOT enable its contribution. Data deletion belongs to `meta:global:destroy --yes --purge` under §20.9, never to contribution disablement.

#### 20.7.1 Top-level alias reservation

The `global:` prefix is reserved under §8.1.2. Plugin aliases using it fail with `CommandAliasConflictError`. User `commandAliases.custom:` MAY remap a plugin alias claim; canonical `meta:global:*` ids remain callable.

### 20.8 Networking and discovery

#### 20.8.1 DNS

`<service>.global.internal` is the only global-service DNS form. Bare names and `<service>.global` are unsupported. A provider known to lack `sharedCrossAppNetwork` blocks dependent contributions: the shared resolver reports the missing capability, and `meta:global:list` exposes a blocked state. Missing capability evidence instead yields unverified eligibility. Enabling either contribution records intent but MUST NOT materialize it until requirements are verified and satisfied. A user app requiring an omitted global service follows the missing-service admission contract in §20.6.3.

#### 20.8.2 Environment variables

For each global service required by an active `AppFeature`, the planner projects `LANDO_GLOBAL_<SERVICE>_HOST` and applicable primary port, named endpoint port, URL, and plugin-defined values. Unrequired services MUST NOT leak variables into a user app. Plugins add extras through the standard `AppFeature.apply()` environment mutator (§6.11.4).

#### 20.8.3 Cross-service expression scope addendum

At `app` bootstrap, `globalServices.<name>.{type,primary,creds,hostnames,routes,endpoints}` is a read-only expression scope. The service MUST exist in the global plan and in the consuming app's `AppFeature.requires.globalServices`; other access fails with `ConfigExpressionScopeNotPermittedError` (§7.3.1).

### 20.9 Storage

| Written scope | Global-app behavior |
|---|---|
| `service` | Data owned by one global service; preserved by normal destroy and removed by `--purge`. |
| `app` | Data shared across global services; preserved by normal destroy and removed by `--purge`. |
| `global` | Shared under §6.5; survives `meta:global:destroy --purge` and is removed only by `meta:uninstall` (§17.7). |

Global-app resources carry the standard ownership labels plus a global-app marker so `apps:poweroff --keep-global` can exclude them.

Ordinary global destroy MUST retain service- and app-scoped data (§5.3.1); that guarantee covers named stores only, and a removed global container's anonymous volumes go with it (§6.5). Scratch apps retain their explicit lifetime and volume-removal policy (§21).

### 20.10 Proxy and CA realization through the global app

#### 20.10.1 Default `RouterService` layer

The default `RouterService` layer (`@lando/proxy-traefik`) realizes routes through the `traefik` service in the global app. `@lando/proxy-traefik` contributes both `globalServices: traefik` and `routerServices: traefik`; an unpaired contribution fails with `ProxyContributionPairError`. `RouterService.setup` ensures the service is running, and route application uses the service's standard managed mounts. The §10.2 interface is unchanged.

Routed user and scratch apps MUST use the host provider. Nonempty routes with an enabled router on another provider MUST fail planning with `RouteProviderMismatchError` (§10.2), never route through host-published ports.

The router's own `traefik` and `traefik-diagnostics` global services author `routes: []` (§6.6), so global ready output and `lando global:info` list Traefik's published host connections (§6.10) and never a generated `<service>.global.<domain>` hostname the router does not serve. The router-owned dashboard keeps its own route above `ROUTE_PRIORITY_MAX` (§10.2).

Alternative `RouterService` implementations MAY avoid `GlobalAppService`. Selection keeps §4.3 precedence: explicit Landofile selection, global default, plugin `defaultFor`, then sole implementation.

#### 20.10.2 `CertificateAuthority` realization

`@lando/ca-mkcert` is a host-level `CertificateAuthority` and is not resident in the global app. Other plugins MAY provide a global-app-resident CA through the existing §4.2 swap contract.

#### 20.10.3 Migration policy

`LegacyProxyContainerDetected` MUST remain the single owner of legacy proxy detection; the preferred-port holder table and `lando3-leftovers` MUST cross-reference it. Plugins MUST NOT add separate proxy-port checks.

- `lando doctor` MUST report the read-only diagnostic and MUST NOT mutate, remove, or independently block resources.
- `meta:setup` and the first global proxy start MUST consult the same owner and fail with `LegacyProxyContainerConflictError` while a conflict remains.
- Detection MUST be provider-aware and bounded under §10.9. Remediation MUST require backup or explicit user confirmation before Lando 3 resources are removed.

### 20.11 Plugins that contribute to the global app

#### 20.11.1 `@lando/service-mailpit` (canonical reference)

The bundled `@lando/service-mailpit` plugin is the reference pairing of a `ServiceType`, enabled `globalServices: mailpit` contribution, `AppFeature.requires.globalServices`, and plugin-owned tooling commands. Its feature projects Mailpit connection values into selected user services without requiring user Landofile changes. Its web route is `mailpit.{{ proxy.defaultDomain }}`, resolved during global planning; a domain change moves it when global routes are next published (§20.6.5).

#### 20.11.2 Migration of `@lando/proxy-traefik`

`@lando/proxy-traefik` pairs its existing router contribution with the `traefik` global service. Runtime inspection and logs use the `meta:global:*` surface.

### 20.13 Errors

All errors are tagged and include remediation where applicable:

- `AppIdReservedError`
- `GlobalServiceCollisionError`
- `GlobalServiceCapabilityError`
- `GlobalServiceConfigError`
- `GlobalServiceUnknownTypeError`
- `GlobalServiceMissingError`
- `GlobalDistReadOnlyError`
- `GlobalServiceCommandReferenceError`
- `ProxyContributionPairError`
- `LegacyProxyContainerDetected`, informational and non-blocking
- `LegacyProxyContainerConflictError`, blocking global proxy start while the conflict exists
- `GlobalAppError`, the umbrella for global state-transition failures. Unknown or ambiguous selections, invalid policy, and stale compare-and-swap use operation `policy`; eligibility graph failures use operation `resolution`, while unsafe disable selections use operation `disable`; lease coordination failures use operation `coordination`; an in-process policy-mutation claim conflict uses `policy-coordination`, and activation refused during that claim uses `consumer-admission`; policy changed after pre-hooks, build, or readiness uses operation `startup-admission`. Partial start or rebuild failure MUST carry operation `start` or `rebuild`, identify failed and running services, preserve the first underlying failure as `cause`, and provide global-scoped recovery remediation. If no group succeeds, the first original failure MUST be returned unchanged.
- `GlobalConsumerProtectionError`, the pre-policy-write refusal for known running user/scratch consumers or unavailable consumer inspection. It carries `operation`, `policySaved: false`, consumer identities and requirements, uncertainties, and invocation-scoped acknowledgement remediation (§20.3.1).
- `GlobalPolicyReconciliationError`, the durable-intent and partial-progress error for `enable`, `disable`, and `reconcile`, with the machine receipt and recovery contract in §20.3.2. It MUST retain the saved revision and completed prefix rather than imply rollback or completed cleanup.
- `AppPlacementError`, with `app`, `desiredProviderId`, `realizedProviderId`, message, and remediation. Start and setup MUST propagate it as the top-level failure for required global services and routing, never wrapped by `GlobalAppError`, `GlobalAutoStartError`, or `ProxySetupError`. Explicit global lifecycle commands MUST also preserve it at top level. Best-effort SSH sidecar acquisition (§10.4, §20.6.3) is exempt: its placement failure warns and MUST NOT abort the caller.
- `ServiceNotReadyError`, the shared post-commit readiness verdict. It participates in group outcomes and partial-failure aggregation; if no group succeeds the first original failure remains unchanged. Remediation uses `lando global:logs -s <service>` and `lando global:start`, except `inspect-failed`, which prescribes `lando doctor`. Established resources and published routes remain available for diagnosis and convergence on retry (§20.6.5).
- `ProxyError` and `RouterWatcherError`, added to the `meta:global:restart` and `meta:global:rebuild` error channels by `RouterService.revalidateStartup` (§10.2, §20.6.5)

This surface also uses the shared `CommandAliasConflictError` and `ConfigExpressionScopeNotPermittedError` tags defined by their owning contracts (§7.3.1, §8.1.2).

### 20.14 Non-goals

- Multi-host shared global apps are not supported.
- The global root is not independently relocatable; changing `<userDataRoot>` relocates it (§7.5).
- Independent per-app global-provider overrides and multiple providers within the global app are unsupported. Global placement follows §20.1.
- Explicit Landofile `dependsOn: ["global:<service>"]` is not a contract; only `AppFeature.requires.globalServices` applies.
- Users cannot promote user-app services into the global app.
- Plugins MUST NOT register canonical ids under `meta:global:*`; they MAY operate on the global app through commands in their own namespaces.
- `globalServices:` contributions are not sandboxed; isolation is cooperative (§10.9.1).

---
