# Lando v4: Runtime Provider API

> **Part 5 of 19** · [Index](./README.md)
> **Read next:** [06 Services](./06-services.md)

A `RuntimeProvider` turns a provider-neutral `AppPlan` into running service instances. The Lando-managed runtime is the default; system Docker and system Podman are bundled opt-in providers.

---

## 5. Runtime Provider API

### 5.1 Concept and terminology

| Term | Meaning |
|---|---|
| **Runtime provider** | Plugin implementing `RuntimeProvider`; this replaces the v3 “engine” concept. |
| **App plan** | Schema-validated, provider-neutral desired state for one app. |
| **Service instance** | Running or startable realization of one `ServicePlan`. |
| **Artifact** | Provider-specific runnable asset, such as an image, VM template, disk, or deployment manifest. |
| **Endpoint** | Service listener identified by protocol and port or socket. |
| **Route** | Host-facing HTTP/TLS mapping to a planned backend endpoint. |

### 5.2 Design principles

1. **Core never shells out to provider binaries.** Every provider operation goes through `RuntimeProvider`.
2. **Core never makes provider-native files the source of truth.** Providers MAY emit native files from a plan.
3. **Provider selection is explicit and cached.** App or global configuration overrides the bundled `lando` default; host-only commands and host tooling require no provider unless they operate on runtime resources. The CLI/default host-provider policy resolves setup's scoped override, then `LANDO_PROVIDER`, then config `defaultProviderId`, then `lando`. Embedding hosts follow §16.5: host configuration MAY outrank or exclude environment input. An app's Landofile provider MUST NOT change the host provider. Planner and registry MUST share the applicable override-aware resolution. Plan cache identity MUST include the host provider.
4. **Capabilities are validated before planning completes and before provider action.** Missing required behavior fails with a typed capability error.
5. **Provider-specific configuration is namespaced** under `providers.<id>`.
6. **Escape hatches are non-portable.** Supported Compose input remains shared input; provider extensions do not become portable semantics.
7. **Providers MAY use containers, VMs, remote execution, or hybrids.** The contract therefore uses `artifact` and `instance` terminology.
8. **The default provider owns its private runtime lifecycle.** It MUST use Lando-controlled binaries, configuration, storage, sockets, and machines and MUST NOT consume system Docker or Podman state.

### 5.3 The `RuntimeProvider` service

`RuntimeProvider` is an Effect service. Scoped methods MUST acquire external resources in `Scope`; interruption MUST reach the underlying operation and finalizers MUST reap owned resources.

| Member | Contract |
|---|---|
| `id`, `displayName`, `version`, `platform` | Stable provider identity and host metadata. |
| `capabilities` | Truthful `ProviderCapabilities` declaration used before planning or action. |
| `isAvailable` | Reports whether the provider can operate on the host. |
| `setup` | Acquires or configures provider prerequisites. |
| `getStatus` | Reports readiness and actionable provider state. |
| `getVersions` | Reports provider and runtime component versions. |
| `buildArtifact` | Builds a runnable artifact from an `ArtifactBuildSpec`. |
| `pullArtifact` | Acquires a referenced artifact with optional policy `always` (default; acquire from source), `missing` (reuse a provider-local copy, acquire only when absent), or `never` (reuse a provider-local copy, fail without contacting the source when absent; §6.13.3). Provider policies are strict and do not fall back. A digest-qualified reference MUST report exactly that digest. |
| `removeArtifact` | Removes an artifact owned or selected by the request. |
| `apply` | Reconciles an `AppPlan` and returns materialized runtime results. Ordinary apply recreates only containers whose immutable create configuration drifted or whose `dev.lando.create-config` label is missing, and keeps unchanged containers and volumes (§5.3.2). A service start failure, interruption, dependency cycle, blocked gate, or volume-phase failure MUST leave the containers and networks apply created in place (created-but-not-started containers included) so a retry converges on them; apply still captures service-start log tails for the error. Shared networks are never removed. |
| `start`, `stop`, `restart` | Changes lifecycle state for selected services. |
| `destroy` | Removes the selected app realization according to `DestroyOptions` and returns a `DestroyOutcome`: `destroyed`, or `no-op` with reason `no-applied-plan` when the target carried no plan and the provider found no applied record. A planless destroy that removes nothing MUST report the no-op rather than succeed silently. |
| `cleanupOwnedResources` (optional) | Removes verified owned containers, private networks, and volumes selected by `DestroyOptions` for one root. Returns `OwnedResourcesCleanupResult` (`servicesRemoved`, `networksRemoved`, `volumesRemoved`). All bundled providers implement it. Shared networks are never owned or deleted. |
| `removeObservedService` | Stops and removes the container behind one observed `ServiceRuntimeInfo`, by observed identity, without resolving an applied plan; returns `removed` or `absent`. |
| `exec` | Executes a short command and returns a collected `ExecResult`. |
| `readAppEnvironment` | Required, read-only `(AppSelector, Readonly<Record<string, ReadonlyArray<string>>>)` to `ReadonlyArray<Redacted<string>>`; reads only requested names from existing containers identified by service. Missing containers, names, and empty values contribute nothing; MUST NOT start runtimes or mutate resources. Transport, permission, and malformed-response failures are sanitized typed `ProviderError`s without response bodies. |
| `execStream` | Streams stdout/stderr and a terminal exit result for a command. |
| `run` | Runs a scoped ephemeral workload, including declared mounts and input. |
| `runStream` | Streaming sibling of `run`, used by generic data movement. |
| `logs` | Streams raw, source-tagged service logs; redaction occurs at output boundaries. |
| `inspect` | Returns `ServiceRuntimeInfo` for a selected service. Its required `publications` field is a `PublicationObservation`: `unknown` when evidence could not be established or is malformed, `missing` when the container is proven absent, or `present` with the actual `bindings` (container `port`, `transport`, real `bindAddress`, assigned `hostPort`), where an empty list proves there are none. Inspect MUST NOT merge planned endpoints into the observation or fall back to plan values, and missing or malformed evidence is never reported as known-empty. |
| `list` | Lists provider instances matching a `ListFilter`. |
| `snapshotVolume`, `restoreVolume`, `removeVolumeSnapshot` | Required for every provider, including removal. Creates, restores, and removes snapshots only when the provider declares native snapshot support; non-native providers MUST fail with the typed capability error. The shared container data plane accepts only native-format references, rejects another provider's reference before mutation, and removes artifacts idempotently. Its helper containers (snapshot commit, volume witness) run only from pinned digest refs, acquired through the provider's `pullArtifact` path with the `missing` policy and verified against the pin before the container is created; failure to acquire or verify fails the operation with a tagged error. Plugin providers may implement other reference formats. |
| `listVolumeSnapshots` (optional) | Lists provider snapshot artifacts with immutable reference, creation time, and labels, independently of the host catalog. Non-native providers return an empty list. Listing MUST NOT start a stopped runtime. |
| `listVolumes`, `removeVolume` | Enumerates and removes selected volumes. |
| `copyToService`, `copyFromService` | Transfers bytes to or from a service. |
| `exportArtifact`, `importArtifact` | Streams artifacts across the provider boundary. |
| `openAgentSocketBridge` | Scoped; makes a host-side agent relay reachable to one app's services as a directory containing the named socket (§10.4). |
| `prepareFileSyncTargets`, `inspectAppliedFileSync`, `disposeFileSyncTargets` (optional) | Accelerated-mount targets for a slow-IO provider (§10.6.3). `prepareFileSyncTargets` creates or re-verifies one labeled sync volume and helper per planned session, is idempotent on retry, fails closed on foreign or unlabeled resources, and returns no rollback: targets outlive a failed start and the next start resumes them. `inspectAppliedFileSync` reports `accelerated`, `ordinary`, `missing`, or `unknown` for the applied app. `disposeFileSyncTargets` removes the targets during destroy. A provider without these members realizes accelerated plans as ordinary binds. |

`exec` MUST be a collector over `execStream`, not a second execution path. `execStream`, foreground `run`, data transfers, and other live operations are scope-bound. `logs` MUST always support the implicit console source when `serviceLogs` is declared; following declared file sources additionally requires `serviceLogSources` and follows §6.14.

`ApplyOptions.onVolumeCreated` is an optional effectful callback receiving the same verified `VolumeCreationFact` reported in `ApplyResult.createdVolumes`. Providers MUST await it for each volume immediately after verified creation and before starting any service container. A callback failure MUST fail apply before service startup. Existing or adopted volumes MUST NOT trigger the callback; ownership labels alone are not creation evidence. Receipts already persisted survive a later apply failure, and the volumes they describe are retained with them.

#### 5.3.1 Teardown resolution and orphaned resources

All app kinds use one placement rule. Desired placement is the selected provider; realized placement is the installed provider holding an applied plan for the exact canonical root and app identity. Scratch plans carry `SCRATCH_EXTENSION_KEY` and MUST match the scratch app id; user and global targets MUST exclude scratch plans. Placement, applied-plan evidence, teardown evidence, orphan grouping where an applied plan disambiguates identity, and ownership cleanup MUST share this predicate. Colocated app kinds MUST NOT claim or remove each other's resources. Before start, rebuild, or restart mutates resources, a different realized provider MUST fail with `AppPlacementError` carrying `AppRef`, desired and realized provider ids, and working remediation commands. Observation and teardown MUST follow applied placement, not a changed default. Ownership inventories alone MUST NOT claim placement. Multiple applied claims MUST fail as ambiguous. `destroy --provider=<id> --yes` MUST restrict evidence and cleanup to that provider, allowing duplicate realizations to be retired explicitly without reading another provider's inventory. Plain destroy MUST retain volumes.

`stop` and `destroy` callers resolve the app **root** from Landofile discovery, which succeeds on an invalid Landofile, and consult applied state and runtime evidence against that root before planning desired config:

1. No applied plan, no owned runtime resources, no nonempty cleanup inventory, and no unfinished accelerated-start journal at the root: the operation reports `outcome: "unchanged"`, takes no provider action, and exits successfully whatever the Landofile says. A nonempty inventory requires provider verification even when every recorded resource returns absent. The one exception is `destroy --purge`, which still removes the root's snapshots (§10.11.2), takes only the provider actions that removal needs, and reports `destroyed` when it removed any.
2. An applied plan exists: tear down from the applied plan. Landofile `events:` and `hostEvents` steps for that teardown come from the Landofile at the applied root at command time (§8.5.7); a Landofile that is missing, fails to load, or names another app or provider skips those steps with a notice. That tolerance is for hook sourcing only; the ownership and unfinished-accelerated-start checks below still fail closed.
3. No applied plan but owned runtime resources exist: tear them down as orphans of that root. Both operations remove orphan containers through `removeObservedService` by observed identity, never through provider state looked up by app id. When destroy's volume policy selects orphan volumes for removal, it uses `removeVolume` by observed identity. The desired plan is loaded only if teardown needs it; a desired-config failure at that point is reported as the tagged planner/landofile error.

Destroy plans before it executes. Identity, inventory, capability, journal, and file-sync checks are read-only and run before the `pre-destroy` bracket (§3.5); every mutation, and any validation that depends on quiescing retained writers, runs inside it.

`stop` reports `stopped` or `unchanged`; `destroy` reports `destroyed` or `unchanged`. Every renderer and machine format MUST preserve that distinction. The operation result vocabulary is distinct from the provider's `DestroyOutcome` (`destroyed`, or `no-op` with reason `no-applied-plan`, §5.3): rule 1 returns `unchanged` without any provider call, an applied-plan teardown (rule 2) reports `destroyed`, and an orphan teardown (rule 3) derives its result from what it removed, `unchanged` when nothing was removed. A direct provider `no-op` MUST NOT be rendered as `destroyed`; it corresponds to `unchanged` unless the same operation removed other resources. Both operations stop and remove the selected containers, but `stop` retains the applied plan and volumes, while `destroy` clears applied state and follows its volume policy. An orphan teardown MUST report what it removed; a result that lists a service MUST mean that service was stopped and removed. Orphan volume removal under `destroy --volumes` MUST classify cache and data volumes exactly as planful bring-down does. A plain `destroy` leaves data stores, so rule 3 lets a later `destroy --volumes` remove them.

Selected global stop (§20.7) is the one teardown exception to rule 3: an otherwise valid selected orphan request (orphaned runtime resources or cleanup-only ownership hints, no applied plan) fails with `AppResolveError` before any mutation, because route ownership cannot be reconstructed without applied route definitions. Whole-global stop follows rule 3.

The orphan-teardown relaxation is scoped to teardown callers. `start` MUST reconcile resources retained from a failed attempt when their recorded ownership and observed identity validate against the desired plan (§6.7). Unknown or foreign resources MUST remain untouched and fail closed through the applicable app-resolution or provider-ownership error; convergence MUST NOT widen the shared evidence resolver's default or adopt resources without ownership proof.

The §10.11 `DataMover` uses native data-plane methods only when declared. Otherwise it MAY use the mount-aware ephemeral-run fallback; if `ephemeralMounts` is false and no native capability exists, planning or transfer fails with `CapabilityError`.

Before any provider `apply` mutates app containers, private networks, or volumes, the provider records the union of the previous successful attempt, prior failed attempts, and the attempt in progress. The record holds identities and digests only, plus the expected app, provider, root, and owner, and the actual physical name, including Lando Windows names. Shared networks are never owned. Applied plans are recorded on success only. `ResourceOwnership` (`appRoot`, `ownerKey`, `providerId`, `appIds`) is a summary hint. It is not physical existence, readiness, or seed evidence.

`RuntimeProviderContribution.resourceOwnership(ctx, root)` is a filesystem-only query and MUST NOT construct, initialize, or contact a runtime. It reads the provider-private `ctx.stateStore` `resource-ownership` namespace, keyed by canonical owner (§12.4.2). `RuntimeProviderRegistry.resourceOwnership(providerId, root)` is the optional per-provider form of the same query, with the same filesystem-only restriction.

`RuntimeProviderRegistry` MUST provide all three evidence members. Callers pass canonical roots; app-kind and identity matching follows the shared placement predicate above.

| Required member | Result and behavior | Failure channel |
|---|---|---|
| `appliedPlansFor(root)` | All installed contributions' applied plans whose `identity.appRoot` exactly equals `root`. Filesystem-only; MUST NOT construct, initialize, or contact a runtime. Shared app placement uses it. | `ProviderUnavailableError \| NoProviderInstalledError` |
| `resolveAppliedPlan(root)` | The unique nearest ancestor-matching non-scratch `AppPlan`, or `undefined` when no applied or owned evidence exists. Orphan resources or cleanup-only ownership MUST fail closed. A matching applied plan MUST NOT require runtime or ownership-inventory inspection. | `AppResolveError \| ProviderError \| NoProviderInstalledError` |
| `resolveTeardownEvidence(root)` | Exact-root `AppliedTeardownEvidence`: `applied`, `orphans`, `owned`, or `absent`. MUST validate ownership before mutation and MUST NOT inherit an ancestor app as the teardown target. | `AppResolveError \| ProviderError \| NoProviderInstalledError` |

Ambiguous applied claims and mismatched attribution MUST fail with `AppResolveError`; provider inspection failures MUST propagate through `ProviderError`. Missing registry members MUST NOT be replaced by empty or absent evidence.

Exact teardown queries every installed contribution's root inventory before any mutation, including an old applied app and a separate failed app. It validates ownership. An offline or corrupt nonempty hint fails with an actionable error and MUST NOT be treated as absent. Teardown evidence MAY be an applied plan, orphan observation plus ownership, or an ownership inventory alone (cleanup-only, no applied plan). Global teardown is the exception to the every-contribution inventory query: it consults only the realized global provider's inventory, or the host provider's when no applied global plan exists, through `RuntimeProviderRegistry.resourceOwnership`, and cleans up through that provider. It MUST NOT read or act on another provider's inventory.

Inventories are teardown evidence only. Non-teardown resolution (selected restart, applied-state resolution) serves a matching applied plan without reading any provider's inventory; it consults inventories only when no applied plan matches, and a nonempty hint then produces the existing orphan refusal (`AppResolveError`). Only teardown probes the availability and cleanup capability of inventory providers. The internal whole-app stop that restart and rebuild run does not perform ownership cleanup.

Whole-app `stop` and `destroy` combine verified cleanup outcomes. A network-only removal is not `unchanged`. An all-absent result stays `unchanged`. Verified absent or removed containers and private networks are retired from the inventory. Volumes remain until the existing volume flags select them. Verification uses ownership labels, not trusted names, with one legacy exception for networks.

| Observed resource | Teardown action |
|---|---|
| Container with its app, root, and service ownership labels and an observed native id | Remove by observed native id. |
| Container missing any of those labels or an observed native id | Refuse. No legacy exception. |
| Network at the exact planned private network name with no labels at all | Legacy (created by an earlier build). Remove by observed native id during planful bring-down and ownership-inventory cleanup; a failed bring-up retains it like every other network. |
| Network with the expected ownership label set | Remove by observed native id. |
| Network with any nonempty label set that is not the expected ownership set (partial, another app, root, owner, or provider) | MUST refuse. |
| Shared network | Never removed. |

This inventory MUST NOT widen partial `provider.destroy`, selected rebuild, or global `-s`. Selected global orphan refusal (§20.7) is unchanged. Orphan lifecycle events are unchanged. A failed or interrupted start at any phase retains the applied app, networks, routes, and volumes (§6.7); the ownership record is how the next start, stop, or destroy finds them. Neither path deletes volumes unless the existing flags select them.

Prepared file-sync targets are not in this inventory. An unfinished accelerated-start journal (§10.6.3) is the ownership evidence for them: it names the attempt's provider, app, root, engine, target volumes, and sessions, and `prepareFileSyncTargets` re-verifies each target's ownership labels live before a resume touches it. The §12.4.2 manifest is consulted beside it only to reject a foreign provider or app; its absence is not a refusal. `stop` with an unfinished attempt runs the full plan stop from any phase (provider teardown that stops writers, then engine drain or session termination, then the owned cleanup above) and leaves the attempt unfinished for the next start. `destroy` disposes the attempt's sessions and targets from any phase, then clears the journal; a target with no session is disposed only when no app writer could have used it, so a post-apply-intent target with no matching session refuses until the session's synchronization history is restored in the engine and `lando start` finishes the attempt. Both fail closed when the journal's identity does not match the current app, provider, or engine; "from any phase" is subject to those ownership and data-preservation checks, not a guarantee in every resource state.

#### 5.3.2 Create-config identity

Ordinary `start` and explicit `global:start` plan and build with the default cache policy (§6.13.3), then apply changed immutable container create configuration, keeping unchanged containers and volumes. Bare `restart` stops and removes containers, then starts the app with the default cache policy (§6.15). `start` has no confirmation flag.

| Drift | Apply behavior |
|---|---|
| Image reference, digest, or build key, under the ordinary build flow | Recreate the affected container. |
| `command`, `entrypoint`, environment, `user`, working directory, mounts, storage, labels, preserved Compose knobs, or container `healthcheck` | Recreate the affected container. |
| Missing opaque `dev.lando.create-config` label | One-time recreate. |
| Unchanged `${secret:...}` reference whose store value changed | Not a config-identity change. MUST NOT recreate for that reason alone. |
| Per-session credentials, allocations, and timestamps | Excluded from identity. |
| Host-proxy session (`dev.lando.host-proxy-session`) | Excluded from identity. A changed session recreates eligible services through the host-proxy session rule (§10.10.1), never as config drift, so selected restart is unaffected. |

The label value is `v1:` plus one SHA-256 digest of the desired create configuration. It stores no raw values and no per-value hashes. A `${secret:...}` input contributes the reference text, not the resolved SecretStore value. Literal env-file and YAML config, including a literal password, is desired configuration and is inside that single outer digest. The digest does not prevent dictionary inference and MUST NOT be described as proof that no secret was hashed.

Explicit `rebuild` remains the forced artifact refresh and explicit recreate (§6.15). It is not required to apply create-config drift.

A provider that realizes network names physically (the managed Windows machine) stamps the fingerprint computed from the physical plan. Its `inspect` presents the logical fingerprint only when the observed label exactly equals the physical expectation, so selected-restart preflight compares like with like. When physical and logical expectations differ, a physical mismatch withholds the fingerprint so it counts as config drift.

### 5.4 Capabilities

Capabilities are schema-validated claims. Providers MUST report them truthfully, and the §13.1 provider contract suite verifies declared behavior.

The §5.3.1 registry evidence members (`appliedPlansFor`, `resolveAppliedPlan`, and `resolveTeardownEvidence`) are required contracts, not optional provider capabilities.

| Capability | Meaning |
|---|---|
| `artifactBuild` | Builds artifacts. |
| `artifactPull` | Pulls artifacts. |
| `buildSecrets` | Supplies secrets to artifact builds. |
| `buildSsh` | Forwards SSH access to artifact builds. |
| `multiServiceApply` | Applies a multi-service plan as one operation. |
| `serviceExec` | Executes commands in services. |
| `serviceLogs` | Streams service console logs. |
| `serviceLogSources` | Follows declared in-service log files. |
| `serviceHealth` | Health realization is `native`, `lando`, or `none`. |
| `hostReachability` | Container-to-host reachability is `native`, `emulated`, or `none`. |
| `sharedCrossAppNetwork` | Supports cross-app DNS/networking required by global services (§20.4). |
| `persistentStorage` | Supports persistent stores. |
| `bindMounts` | Supports host bind mounts. |
| `bindMountPerformance` | Bind IO is `native`, `slow`, or `none`. |
| `copyMounts` | Supports copy-style mounts. |
| `hostPortPublish` | Publishing is `native`, `proxy`, `manual`, or `none`. |
| `routeProvider` | Realizes host routes. |
| `tlsCertificates` | TLS realization is `native`, `lando`, or `none`. |
| `rootless` | Operates without root privileges. |
| `privilegedServices` | Supports privileged service intent. |
| `composeSpec` | Compose realization is `none`, `portable`, or `native`. |
| `composeKnobs` | Exact supported preserved container-runtime knobs. |
| `composeServiceFields` | Exact supported preserved service field families. |
| `composeProjectFields` | Exact supported preserved project fields. |
| `composePreservedPaths` | Exact supported preserved descendant paths. |
| `volumeSnapshot` | Volume snapshots are `native` or `none`. DataMover owns the host-archive fallback. |
| `serviceFileCopy` | Service copy is `native`, `exec`, or `none`. |
| `artifactExport`, `artifactImport` | Supports streaming artifacts out and in. |
| `ephemeralMounts` | Ephemeral `run` honors declared mounts. |
| `providerExtensions` | Extension namespaces the provider accepts. |
| `agentSocket` | Agent-socket delivery for §10.4 SSH and gpg relays: `{ delivery: "bind-directory" \| "guest-bridge" \| "volume-relay" }`. Omitted means no delivery; §10.4 sidecar mode then warns and starts without the socket overlay, while host mode and gpg forwarding fail planning with `CapabilityError`. |

Missing required capabilities fail before provider action with `CapabilityError` naming the provider, feature, service when applicable, and remediation. Published endpoints require `hostPortPublish`; internal endpoints do not. Providers report assigned host ports only as `PublicationObservation` bindings from real inspection and MUST NOT mutate desired publication state or substitute plan values for observed ones.

`composeSpec: native` is necessary but not sufficient for preserved Compose semantics. `composeKnobs`, `composeServiceFields`, `composeProjectFields`, and `composePreservedPaths` are fail-closed exact declarations; omission means no support, non-empty declarations below `native` are invalid, and support MUST NOT be inferred from a parent field or tier. Declaring a field claims complete realization of its accepted forms. Service and project `x-*` fields remain inert preserved metadata unless a specific namespace later gains an explicit capability or provider extension.

Bundled container providers MUST derive `composeKnobs.supported` from the shared realization table. Each realization declares the engine dialects for which its request fields implement the accepted forms with identical semantics. Docker uses the verified Docker Engine mappings; Lando-managed and system Podman use the libpod dialect's compatible create API. Independent request fixtures MUST cover every declared knob for each dialect, including query parameters and the Config versus HostConfig boundary. Docker's supported API range MUST preserve these mappings, including the container-create `platform` query parameter introduced in API 1.41.

#### 5.4.1 Agent-socket delivery (`agentSocket`, `openAgentSocketBridge`)

`openAgentSocketBridge(input)` takes `AgentSocketBridgeInput` (`appId`, `sessionId`, `kind: "ssh" | "gpg"`, an `upstream` that is a host Unix socket path or an authenticated host-loopback TCP endpoint, and `socketName`) and returns `AgentSocketBridgeResult`: either `bind-directory` naming a host directory the provider can bind, or `volume` naming a provider volume; in both cases the directory contains `socketName` once the bridge is live. The result is Scope-owned. Closing the scope tears down any guest listener, relay process, or volume and MUST reap them on interrupt. A failed or interrupted start MUST NOT close a bridge it has acquired and recorded; stop and destroy close it (§10.4). The provider MUST declare `agentSocket` only when its bridge works on the current host, so capability failure happens before planning rather than at apply.

| Host and provider | `delivery` | Realization |
|---|---|---|
| Linux native Podman or Docker Engine, including WSL rootless managed Podman | `bind-directory` | The app-owned relay directory is bind-mounted with `createHostPath: false`; the relay socket is created by the host worker and MUST be connectable by the actual non-root service user. |
| Podman machine on macOS and Windows, managed or user-owned | `guest-bridge` | The provider opens an SSH reverse forward into the machine using its machine SSH metadata, publishing a guest Unix socket in a machine-side directory that the machine bind-mounts into the service. On Windows the host worker reads the named-pipe upstream and the reverse forward carries a loopback byte stream. Unix sockets are never placed on virtiofs or 9p shares. |
| Docker Desktop on macOS and Windows | `volume-relay` | A provider-owned guest relay container connects to an authenticated host-loopback broker through the Desktop host gateway and publishes the socket in an app-private volume shared with the service. The Desktop `/run/host-services/ssh-auth.sock` socket MUST NOT be used; it only reaches Desktop's own launchd agent. |

The relay carries raw agent bytes and is separate from the §10.10 host-proxy protocol. Failure policy follows §10.4: in sidecar mode an unsupported combination or a failed bridge publishes a warning, the app starts without the socket overlay, and `lando doctor` reports the ssh check degraded; in host mode (`sshAgent.sidecar: false`) and for gpg forwarding, a missing `agentSocket` capability is a planning-time `CapabilityError` naming the provider and the alternatives, start-time discovery and bridge failures are `SshAgentUnavailableError` or `GpgAgentUnavailableError`, and faults after readiness are the matching `*TransportError`. Relay sockets are `0666` inside a per-user `0700` run directory. The Windows `guest-bridge` loopback TCP broker carries no token: other local accounts on that Windows host can reach it while the app runs, which is a documented trust-boundary limitation.

`bindMountPerformance: slow` causes the planner to use the active `FileSyncEngine` unless the user explicitly selects the documented passthrough escape hatch; `none` rejects bind mounts. `sharedCrossAppNetwork` gates global-service contributions. Data-plane declarations select native behavior, documented generic fallback, or typed failure.

### 5.5 The `AppPlan`

The frozen, schema-validated plan is the sole source of truth across the core/provider boundary.

| `ServicePlan` field | Meaning |
|---|---|
| `name`, `type`, `provider`, `primary` | Service identity, resolved type, provider, and primary marker. |
| `artifact` | Existing artifact reference or build specification. |
| `command`, `entrypoint` | Planned process invocation. |
| `environment`, `user`, `workingDirectory` | Runtime process environment and identity. |
| `appMount`, `mounts`, `storage` | App source, mount, and persistent-store intent. |
| `endpoints`, `routes` | Service listeners and references to app routes. |
| `dependsOn` | Planned service dependencies. |
| `healthcheck`, `certs`, `hostAliases` | Health, certificate, and supported host-reachability intent. |
| `metadata` | Provider-neutral planning metadata. |
| `extensions` | Namespaced preserved provider intent. |

| `AppPlan` field | Meaning |
|---|---|
| `id`, `name`, `slug`, `root` | Stable app identity and authoritative root. |
| `provider` | Selected provider id. |
| `services` | Planned services keyed by service name. |
| `routes` | Planner-resolved routes with explicit backend service, protocol, and port. |
| `networks`, `stores` | Provider-neutral network and storage intent. |
| `networking` | Explicit per-app bridge (or `null`) and optional shared-network membership with service aliases. |
| `events` | Compiled Landofile `events:` and `hostEvents` steps with provenance and plan-time status (§8.5.7). Omitted from provider applied-state records. |
| `metadata` | App planning metadata. |
| `extensions` | Namespaced preserved provider intent. |

Providers MAY translate plans into native representations, but MUST consume resolved route backends without endpoint heuristics. Host aliases require declared capability and known gateway data; providers MUST NOT guess missing gateway data or install legacy helper mounts (§6.9).

#### 5.5.1 Supported Compose input at the boundary

The Landofile accepts the supported Compose subset in §7.4, but a raw Compose document never becomes the provider source of truth. Core parses and validates input, normalizes portable intent into plan fields, preserves accepted native intent in namespaced extensions, capability-checks preserved runtime semantics, and rejects unsupported keys with remediation. The §7.4 disposition matrix owns normalize/preserve/reject classification.

### 5.6 Provider extensions

Provider-specific intent MAY appear only under `providers.<id>`. Such intent is non-portable unless the extension defines a portable fallback, generated documentation and `lando config` MUST mark it non-portable, and the owning provider MUST validate it with Effect Schema and return `ProviderConfigError` on invalid input. Shared Compose keys are not provider extensions (§5.5.1).

### 5.7 Provider errors

| `_tag` | Failure |
|---|---|
| `ProviderUnavailableError` | Provider is unavailable on the host. |
| `ProviderCapabilityError` | Requested behavior is unsupported. |
| `ArtifactBuildError` | Artifact build failed. |
| `ServiceStartError` | Service lifecycle start failed. |
| `ServiceExecError` | Service command execution failed. |
| `ServiceNotFoundError` | Selected service does not exist. |
| `ProviderConfigError` | Provider extension configuration is invalid. |
| `ProviderInternalError` | Provider failed outside a more specific category. |
| `VolumeOperationError` | Volume list, remove, snapshot, restore, or snapshot removal failed. |
| `ServiceCopyError` | Service file transfer failed. |
| `ArtifactTransferError` | Artifact export or import failed. |

Every provider error MUST include `providerId`, `operation`, a user-facing `message`, redacted `details` when present, optional `remediation`, and an optional original `cause` for debug logs. `message` and `details` MUST already be redacted with the live value set when the error is returned, so library callers see the same masking as CLI output.

The runtime provider registry MUST enforce redaction on failures from every Effect and Stream member, provider construction, and contribution callback, including applied-plan and resource-ownership reads. It MUST reconstruct canonical error classes with redacted `message`, deep-redacted `details`, `remediation`, and other exposed text fields while preserving tags, schema encoding, yieldability, and the original debug-only `cause`. Defects and interruption are unchanged. Providers MUST still redact errors at construction as defense in depth.

### 5.8 Bundled providers

All bundled providers implement the complete `RuntimeProvider` contract.

#### 5.8.1 Default: Lando-managed runtime (`@lando/provider-lando`)

The default provider uses Podman privately but presents the “Lando runtime” to users. It owns verified runtime bundles, private configuration and storage, its API endpoint, and managed macOS/Windows machines under Lando-controlled roots (§12.4). Production bundle entries MUST name immutable published assets with real checksums and sizes and MUST remain available for older binaries. Overrides MAY redirect development to another manifest or paired URL/checksum but MUST NOT disable verification. Resolution precedence is alternate manifest, paired URL/checksum, then bundled manifest; there is no channel-aware or runtime-fetched production manifest.

Before it stops its runtime service, the provider makes a bounded, best-effort attempt to remove build-only containers left in its private storage. That attempt MUST NOT remove service containers, volumes, artifacts, or build cache, and its failure MUST NOT block the stop.

Podman-backed providers require Podman 6 or newer. Supported managed hosts are Apple Silicon macOS, Windows 11 or newer, and Linux with cgroups v2 and nftables; rootless networking uses Pasta with Netavark/Aardvark. Unsupported legacy stacks MUST fail closed with tagged remediation.

Intel macOS is unsupported by the managed provider. Setup, bundle resolution, runtime readiness, and status MUST fail closed with remediation naming `lando setup --provider=docker` or `LANDO_PROVIDER=docker`; the provider remains discoverable so dependent capability selection does not silently skip it.

On Windows, the Lando-owned machine exposes HTTP over the named pipe `\\.\pipe\podman-lando`. The provider MUST use named-pipe transport, MUST NOT invoke Unix-socket tooling, and MUST NOT probe the Linux managed-service socket.

Podman’s published machine-OS update command spelling is unresolved; this specification does not normatively require one spelling.

`bindMountPerformance` is `native` on Linux and `slow` on supported macOS and Windows hosts. The provider is bundled and active by default, but distributions MAY omit it.

#### 5.8.2 Opt-in: system Docker (`@lando/provider-docker`)

The Docker provider targets Docker Engine or Docker Desktop and is selected by app or global provider configuration. It reports bind performance as `native` for Linux Engine and native WSL2 Engine with a WSL-resident app root, and `slow` for Docker Desktop on macOS or Windows.

#### 5.8.3 Opt-in: system Podman (`@lando/provider-podman`)

The Podman provider targets system Podman 6 or newer and is selected by app or global provider configuration. It follows the same supported-host and fail-closed legacy-stack rules as the managed provider. It reports bind performance as `native` on Linux and `slow` on supported macOS and Windows machine-backed installations. Additional providers MUST report this capability honestly.

### 5.9 Multi-provider apps (deferred)

One provider is selected per app. Per-service provider data remains a non-portable extension hint. Multiple providers within one app, including their networking, route ownership, lifecycle ordering, failure handling, and capability negotiation, are deferred. Host-provider placement of the global app and cross-provider SSH delivery (§10.4) are not deferred. Cross-provider routing is unsupported: an enabled router with nonempty routes MUST fail planning when the app provider differs from the host provider (§10.2).

---
