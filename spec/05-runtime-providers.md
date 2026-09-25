# Lando v4 — Runtime Provider API

> **Part 5 of 18** · [Index](./README.md)
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
3. **Provider selection is explicit and cached.** App or global configuration overrides the bundled `lando` default; host-only commands and host tooling require no provider.
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
| `pullArtifact` | Acquires a referenced artifact. |
| `removeArtifact` | Removes an artifact owned or selected by the request. |
| `apply` | Reconciles an `AppPlan` and returns materialized runtime results. |
| `start`, `stop`, `restart` | Changes lifecycle state for selected services. |
| `destroy` | Removes the selected app realization according to `DestroyOptions`. |
| `exec` | Executes a short command and returns a collected `ExecResult`. |
| `execStream` | Streams stdout/stderr and a terminal exit result for a command. |
| `run` | Runs a scoped ephemeral workload, including declared mounts and input. |
| `runStream` | Streaming sibling of `run`, used by generic data movement. |
| `logs` | Streams raw, source-tagged service logs; redaction occurs at output boundaries. |
| `inspect` | Returns `ServiceRuntimeInfo` for a selected service. |
| `list` | Lists provider instances matching a `ListFilter`. |
| `snapshotVolume`, `restoreVolume` | Creates and restores provider volume snapshots. |
| `listVolumes`, `removeVolume` | Enumerates and removes selected volumes. |
| `copyToService`, `copyFromService` | Transfers bytes to or from a service. |
| `exportArtifact`, `importArtifact` | Streams artifacts across the provider boundary. |
| `openAgentSocketBridge` | Scoped; makes a host-side agent relay reachable to one app's services as a directory containing the named socket (§10.4). |

`exec` MUST be a collector over `execStream`, not a second execution path. `execStream`, foreground `run`, data transfers, and other live operations are scope-bound. `logs` MUST always support the implicit console source when `serviceLogs` is declared; following declared file sources additionally requires `serviceLogSources` and follows §6.14.

The §10.11 `DataMover` uses native data-plane methods only when declared. Otherwise it MAY use the mount-aware ephemeral-run fallback; if `ephemeralMounts` is false and no native capability exists, planning or transfer fails with `CapabilityError`.

### 5.4 Capabilities

Capabilities are schema-validated claims. Providers MUST report them truthfully, and the §13.1 provider contract suite verifies declared behavior.

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
| `volumeSnapshot` | Volume snapshots are `native`, `copy`, or `none`. |
| `serviceFileCopy` | Service copy is `native`, `exec`, or `none`. |
| `artifactExport`, `artifactImport` | Supports streaming artifacts out and in. |
| `ephemeralMounts` | Ephemeral `run` honors declared mounts. |
| `providerExtensions` | Extension namespaces the provider accepts. |
| `agentSocket` | Agent-socket delivery for §10.4 SSH and gpg relays: `{ delivery: "bind-directory" \| "guest-bridge" \| "volume-relay" }`. Omitted means no delivery; §10.4 then fails start with a tagged remediation error. |

Missing required capabilities fail before provider action with `CapabilityError` naming the provider, feature, service when applicable, and remediation. Published endpoints require `hostPortPublish`; internal endpoints do not. Providers return assigned host ports as materialization results and MUST NOT mutate desired publication state.

`composeSpec: native` is necessary but not sufficient for preserved Compose semantics. `composeKnobs`, `composeServiceFields`, `composeProjectFields`, and `composePreservedPaths` are fail-closed exact declarations; omission means no support, non-empty declarations below `native` are invalid, and support MUST NOT be inferred from a parent field or tier. Declaring a field claims complete realization of its accepted forms. Service and project `x-*` fields remain inert preserved metadata unless a specific namespace later gains an explicit capability or provider extension.

#### 5.4.1 Agent-socket delivery (`agentSocket`, `openAgentSocketBridge`)

`openAgentSocketBridge(input)` takes `AgentSocketBridgeInput` (`appId`, `sessionId`, `kind: "ssh" | "gpg"`, an `upstream` that is a host Unix socket path or an authenticated host-loopback TCP endpoint, and `socketName`) and returns `AgentSocketBridgeResult`: either `bind-directory` naming a host directory the provider can bind, or `volume` naming a provider volume; in both cases the directory contains `socketName` once the bridge is live. The result is Scope-owned. Closing the scope tears down any guest listener, relay process, or volume and MUST reap them on interrupt. The provider MUST declare `agentSocket` only when its bridge works on the current host, so capability failure happens before planning rather than at apply.

| Host and provider | `delivery` | Realization |
|---|---|---|
| Linux native Podman or Docker Engine, including WSL rootless managed Podman | `bind-directory` | The app-owned relay directory is bind-mounted with `createHostPath: false`; the relay socket is created by the host worker and MUST be connectable by the actual non-root service user. |
| Podman machine on macOS and Windows, managed or user-owned | `guest-bridge` | The provider opens an SSH reverse forward into the machine using its machine SSH metadata, publishing a guest Unix socket in a machine-side directory that the machine bind-mounts into the service. On Windows the host worker reads the named-pipe upstream and the reverse forward carries a loopback byte stream. Unix sockets are never placed on virtiofs or 9p shares. |
| Docker Desktop on macOS and Windows | `volume-relay` | A provider-owned guest relay container connects to an authenticated host-loopback broker through the Desktop host gateway and publishes the socket in an app-private volume shared with the service. The Desktop `/run/host-services/ssh-auth.sock` socket MUST NOT be used; it only reaches Desktop's own launchd agent. |

The relay carries raw agent bytes and is separate from the §10.10 host-proxy protocol. Unsupported combinations fail `lando start` with `SshAgentUnavailableError` or `GpgAgentUnavailableError` (`reason: "capability-missing"`) naming the provider and the alternatives; bridge faults after readiness are the matching `*TransportError`.

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
| `VolumeOperationError` | Volume list, remove, snapshot, or restore failed. |
| `ServiceCopyError` | Service file transfer failed. |
| `ArtifactTransferError` | Artifact export or import failed. |

Every provider error MUST include `providerId`, `operation`, a user-facing `message`, redacted `details`, optional `remediation`, and an optional original `cause` for debug logs.

### 5.8 Bundled providers

All bundled providers implement the complete `RuntimeProvider` contract.

#### 5.8.1 Default: Lando-managed runtime (`@lando/provider-lando`)

The default provider uses Podman privately but presents the “Lando runtime” to users. It owns verified runtime bundles, private configuration and storage, its API endpoint, and managed macOS/Windows machines under Lando-controlled roots (§12.4). Production bundle entries MUST name immutable published assets with real checksums and sizes and MUST remain available for older binaries. Overrides MAY redirect development to another manifest or paired URL/checksum but MUST NOT disable verification. Resolution precedence is alternate manifest, paired URL/checksum, then bundled manifest; there is no channel-aware or runtime-fetched production manifest.

Podman-backed providers require Podman 6 or newer. Supported managed hosts are Apple Silicon macOS, Windows 11 or newer, and Linux with cgroups v2 and nftables; rootless networking uses Pasta with Netavark/Aardvark. Unsupported legacy stacks MUST fail closed with tagged remediation.

Intel macOS is unsupported by the managed provider. Setup, bundle resolution, runtime readiness, and status MUST fail closed with remediation naming `lando setup --provider=docker` or `LANDO_PROVIDER=docker`; the provider remains discoverable so dependent capability selection does not silently skip it.

On Windows, the Lando-owned machine exposes HTTP over the named pipe `\\.\pipe\podman-lando`. The provider MUST use named-pipe transport, MUST NOT invoke Unix-socket tooling, and MUST NOT probe the Linux managed-service socket.

Podman’s published machine-OS update command spelling is unresolved; v4.0.0 does not normatively require one spelling.

`bindMountPerformance` is `native` on Linux and `slow` on supported macOS and Windows hosts. The provider is bundled and active by default, but distributions MAY omit it.

#### 5.8.2 Opt-in: system Docker (`@lando/provider-docker`)

The Docker provider targets Docker Engine or Docker Desktop and is selected by app or global provider configuration. It reports bind performance as `native` for Linux Engine and native WSL2 Engine with a WSL-resident app root, and `slow` for Docker Desktop on macOS or Windows.

#### 5.8.3 Opt-in: system Podman (`@lando/provider-podman`)

The Podman provider targets system Podman 6 or newer and is selected by app or global provider configuration. It follows the same supported-host and fail-closed legacy-stack rules as the managed provider. It reports bind performance as `native` on Linux and `slow` on supported macOS and Windows machine-backed installations. Additional providers MUST report this capability honestly.

### 5.9 Multi-provider apps (deferred)

v4.0.0 uses one provider per app. Per-service provider data remains a non-portable extension hint. Cross-provider networking, route ownership, lifecycle ordering, failure handling, and capability negotiation are deferred until after v4.0.0.

---
