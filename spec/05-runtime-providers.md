# Lando v4 — Runtime Provider API

> **Part 5 of 18** · [Index](./README.md)
> **Read next:** [06 Services](./06-services.md)

This part is the deep dive on the most critical pluggable abstraction in v4: the `RuntimeProvider`. A provider is a plugin that turns a provider-neutral `AppPlan` into a running, networked set of service instances. The Lando-managed runtime (default), system Docker, system Podman, Lima, OrbStack, remote runtimes, and lightweight VMs all implement this contract.

Covered here: terminology, the eight design principles (no shellouts to provider binaries from core, the bundled default provider owns its private runtime lifecycle, capability-before-plan, plan-before-action, etc.), the `RuntimeProvider` Effect service interface, the `ProviderCapabilities` matrix, the `AppPlan` and `ServicePlan` schemas, Compose-spec input compatibility at the provider boundary, provider extension config (the non-portable opt-in), the typed error model, the bundled providers (Lando-managed runtime as default, system Docker and system Podman as opt-in), and the deferred multi-provider design.

---

## 5. Runtime Provider API

### 5.1 Concept and terminology

A **Runtime Provider** is a plugin that turns a provider-neutral `AppPlan` into a running, networked set of service instances. The "provider" abstraction replaces the v3 notion of an "engine".

| Term | Meaning |
|---|---|
| **Runtime provider** | Plugin implementing `RuntimeProvider`. Examples: Lando-managed runtime (default), system Docker, system Podman, Lima, OrbStack, a remote Kubernetes provider, a VM-based provider. |
| **App plan** | Effect Schema-validated desired state for one app: services, mounts, endpoints, routes, networks, stores, metadata. Provider-neutral. |
| **Service instance** | A running or startable realization of one `ServicePlan` in a provider. |
| **Artifact** | A provider-specific runnable asset. Container providers use *images*; VM providers use *templates/disks*; remote providers may use *deployment manifests*. |
| **Endpoint** | A service listener (e.g., `8080/http`, `5432/tcp`, `unix:/var/run/foo.sock`). |
| **Route** | A host-facing HTTP/TLS mapping to one or more endpoints. |

### 5.2 Design principles

1. **Core never shells out to provider binaries.** No `Bun.spawn('docker', [...])` in core. All provider operations go through the `RuntimeProvider` Effect interface.
2. **Core never writes provider-native plan files as source of truth.** Compose files, Pod specs, Vagrantfiles are emitted by the provider, not by core.
3. **Provider selection is explicit and cached.** The selected provider is stored per-app in the app plan cache.
4. **Provider capabilities are declared and validated before plans are applied.** A planner that needs `bindMounts` checks `provider.capabilities.bindMounts === true` and emits a typed `CapabilityError` if not.
5. **Provider-specific config is namespaced.** It lives under `providers.<id>` and is invisible unless the provider plugin opts to read it.
6. **Provider escape hatches don't become portable v4 semantics.** A user who sets `providers.docker.composeFiles:` is opting out of portability. A user who writes supported Compose keys directly in the Landofile is using the shared input schema; planning decides whether those keys normalize to provider-neutral intent or require a provider capability.
7. **Providers may be containerization, virtualization, remote execution, or hybrid implementations.** The interface deliberately uses the abstract terms `artifact` and `instance`.
8. **The bundled default provider owns its private runtime lifecycle.** The Lando-managed runtime provider manages its own Podman binaries, configuration root, storage root, API socket, and (on macOS and Windows) VM/machine lifecycle entirely under Lando-controlled paths (§12.4). It writes nothing to and reads nothing from system-wide Docker or Podman installations.

### 5.3 The `RuntimeProvider` service

```ts
import { Context, Effect, Schema, Scope, Stream } from "effect";
import {
  AppPlan,
  AppSelector,
  ApplyOptions,
  ApplyResult,
  ArtifactBuildSpec,
  ArtifactPullSpec,
  ArtifactRef,
  CommandSpec,
  DestroyOptions,
  EphemeralRunSpec,
  ExecResult,
  ExecTarget,
  HostPlatform,
  ListFilter,
  LogChunk,
  LogOptions,
  LogTarget,
  ProviderCapabilities,
  ProviderError,
  ProviderSetupOptions,
  ProviderStatus,
  ProviderVersions,
  ServiceRuntimeInfo,
  ServiceSelector,
} from "@lando/sdk";

export class RuntimeProvider extends Context.Service<RuntimeProvider, {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly platform: HostPlatform;
  readonly capabilities: ProviderCapabilities;

  readonly isAvailable: Effect.Effect<boolean, ProviderError>;
  readonly setup: (options: ProviderSetupOptions) => Effect.Effect<void, ProviderError, Scope.Scope>;
  readonly getStatus: Effect.Effect<ProviderStatus, ProviderError>;
  readonly getVersions: Effect.Effect<ProviderVersions, ProviderError>;

  readonly buildArtifact: (spec: ArtifactBuildSpec) => Effect.Effect<ArtifactRef, ProviderError, Scope.Scope>;
  readonly pullArtifact: (spec: ArtifactPullSpec) => Effect.Effect<ArtifactRef, ProviderError>;
  readonly removeArtifact: (ref: ArtifactRef) => Effect.Effect<void, ProviderError>;

  readonly apply: (plan: AppPlan, options: ApplyOptions) => Effect.Effect<ApplyResult, ProviderError, Scope.Scope>;
  readonly start: (target: ServiceSelector) => Effect.Effect<void, ProviderError>;
  readonly stop: (target: ServiceSelector) => Effect.Effect<void, ProviderError>;
  readonly restart: (target: ServiceSelector) => Effect.Effect<void, ProviderError>;
  readonly destroy: (target: AppSelector, options: DestroyOptions) => Effect.Effect<void, ProviderError>;

  readonly exec: (target: ExecTarget, command: CommandSpec) => Effect.Effect<ExecResult, ProviderError>;
  readonly execStream: (target: ExecTarget, command: CommandSpec) => Stream.Stream<ExecChunk, ProviderError, Scope.Scope>;
  readonly run: (spec: EphemeralRunSpec) => Effect.Effect<ExecResult, ProviderError, Scope.Scope>;
  readonly logs: (target: LogTarget, options: LogOptions) => Stream.Stream<LogChunk, ProviderError>;
  readonly inspect: (target: ServiceSelector) => Effect.Effect<ServiceRuntimeInfo, ProviderError>;
  readonly list: (filter: ListFilter) => Effect.Effect<ReadonlyArray<ServiceRuntimeInfo>, ProviderError>;
}>()("@lando/core/RuntimeProvider") {}
```

**`exec` vs `execStream`.** `exec` returns a collected `ExecResult` (stdout / stderr buffered, exit code) and is the right primitive for short, structured calls (a single `psql -c "select 1"`, a healthcheck probe). `execStream` returns a `Stream<ExecChunk>` where each chunk is `{ stream: "stdout" | "stderr", data: Uint8Array }` followed by a terminal `{ exit: number }` chunk; it is the right primitive for long-running output that must be observable while it runs (the build orchestrator's `composer install` / `npm ci` steps; `lando logs --follow`'s sibling for one-shot exec; tooling tasks with `interactive: false` that the renderer needs to stream into a tail panel). `exec` MUST be implemented as a thin collector over `execStream` (`Stream.runFold`) — providers do not duplicate spawn logic. `Effect.interrupt` MUST propagate through `execStream` to the underlying `kill()` and the service's `Scope` MUST reap the child before resolving, identical to the contract on `RuntimeProvider.logs`. Unlike `logs`, `execStream` is `Scope`-bounded: a stream that is dropped without being consumed to completion still terminates the underlying exec at scope close.

### 5.4 Capabilities

Capabilities are a typed manifest of what the provider can do. Planning consults capabilities before assembling an `AppPlan`, and emits actionable errors when a feature is requested that the provider can't honor.

```ts
export const ProviderCapabilities = Schema.Struct({
  artifactBuild: Schema.Boolean,
  artifactPull: Schema.Boolean,
  buildSecrets: Schema.Boolean,
  buildSsh: Schema.Boolean,
  multiServiceApply: Schema.Boolean,
  serviceExec: Schema.Boolean,
  serviceLogs: Schema.Boolean,
  serviceHealth: Schema.Literal("native", "lando", "none"),
  hostReachability: Schema.Literal("native", "emulated", "none"),
  sharedCrossAppNetwork: Schema.Boolean,
  persistentStorage: Schema.Boolean,
  bindMounts: Schema.Boolean,
  bindMountPerformance: Schema.Literal("native", "slow", "none"),
  copyMounts: Schema.Boolean,
  hostPortPublish: Schema.Literal("native", "proxy", "manual", "none"),
  routeProvider: Schema.Boolean,
  tlsCertificates: Schema.Literal("native", "lando", "none"),
  rootless: Schema.Boolean,
  privilegedServices: Schema.Boolean,
  composeSpec: Schema.Literal("none", "portable", "native"),
  providerExtensions: Schema.Array(Schema.String),
});
export type ProviderCapabilities = Schema.Schema.Type<typeof ProviderCapabilities>;
```

If a service, feature, or subsystem requires a missing capability, planning fails with `CapabilityError` containing the service, feature, capability, provider id, and a suggested fix.

`composeSpec` describes how much supported Compose input the provider can realize after core has parsed it:

- `none` — the provider can only realize fields that core normalized into provider-neutral `AppPlan` fields.
- `portable` — the provider can realize the Compose keys that have direct provider-neutral equivalents, such as standard service environment, command, mounts, stores, networks, endpoints, and dependencies.
- `native` — the provider can also consume Compose-native fields preserved in plan extensions, such as provider labels, deploy hints, build variants, profiles, configs, and secrets.

`bindMountPerformance` describes the provider's host↔guest filesystem-IO characteristics for `bind`-type mounts:

- `native` — the provider's bind mount path is the host filesystem (Linux native runtime, OrbStack on macOS, Linux containers on Linux Docker/Podman). The planner realizes `MountPlan`s of `type: bind` directly through the provider with no `FileSyncEngine` involvement.
- `slow` — the provider runs in a separate filesystem boundary (Docker Desktop's VM-mediated VirtioFS / osxfs / 9p; Podman Desktop machines; Lima/Colima at default settings; Windows Docker Desktop with WSL2 backend when the project lives outside the WSL filesystem). The planner marks every `bind` mount in the resolved `AppPlan` as `realization: "accelerated"` and routes its lifecycle through the active `FileSyncEngine` (§4.2, §10.6); the user's Landofile is unchanged and the user does not opt into the behavior.
- `none` — the provider does not support bind mounts at all (some remote/cloud providers). Plans containing `bind` mounts fail with `CapabilityError` per the §5.4 capability-validation rule.

`sharedCrossAppNetwork` declares whether services in different apps can reach each other via `<service>.<app>.internal` DNS aliases on the same provider network. Required by virtually every plugin-contributed `globalServices:` entry (§20.4); without it the contribution is dropped from the global plan with a doctor warning (§20.8.1).

`bindMountPerformance` is informational at the boundary, not a knob. Providers MUST report it truthfully; misreporting is treated as a contract violation by the §13.1 provider contract suite. The planner consults this field exactly once per `app:start` to compute the `realization` flag on every `MountPlan`; runtime overrides require a Landofile-level escape hatch (`mounts: [..., accelerate: false]`) or a global `defaultFileSyncEngine: passthrough` setting, neither of which is documented in canonical recipes or executable tutorials. The §13.1 perf-budget suite asserts that `app:start` against a `bindMountPerformance: "slow"` provider does **not** regress to native bind IO — i.e., the `FileSyncEngine` actually engaged.

### 5.5 The `AppPlan`

The app plan is a frozen, schema-validated, provider-neutral description of what the provider must realize.

```ts
export const ServicePlan = Schema.Struct({
  name: ServiceName,
  type: Schema.String,
  provider: ProviderId,
  primary: Schema.Boolean,
  artifact: Schema.optional(Schema.Union(ArtifactRef, ArtifactBuildSpec)),
  command: Schema.optional(CommandSpec),
  entrypoint: Schema.optional(CommandSpec),
  environment: Schema.ReadonlyMap({ key: Schema.String, value: Schema.String }),
  user: Schema.optional(Schema.String),
  workingDirectory: Schema.optional(PortablePath),
  appMount: Schema.optional(AppMountPlan),
  mounts: Schema.Array(MountPlan),
  storage: Schema.Array(DataStoreMountPlan),
  endpoints: Schema.Array(EndpointPlan),
  routes: Schema.Array(RouteRef),
  dependsOn: Schema.Array(DependencyPlan),
  healthcheck: Schema.optional(HealthcheckPlan),
  certs: Schema.optional(CertificatePlan),
  hostAliases: Schema.Array(HostAliasPlan),
  metadata: PlanMetadata,
  extensions: ProviderExtensionConfig,
});

export const AppPlan = Schema.Struct({
  id: AppId,
  name: Schema.String,
  slug: Schema.String,
  root: AbsolutePath,
  provider: ProviderId,
  services: Schema.ReadonlyMap({ key: ServiceName, value: ServicePlan }),
  routes: Schema.Array(RoutePlan),
  networks: Schema.Array(NetworkPlan),
  stores: Schema.Array(DataStorePlan),
  metadata: PlanMetadata,
  extensions: ProviderExtensionConfig,
});
```

The plan is what crosses the core↔provider boundary. Providers MAY translate this into their own native representation (compose files, pod specs, Vagrantfiles) but the *truth* lives in the plan.

### 5.5.1 Supported Compose input at the boundary

The Landofile supports a documented Compose subset (§7.4). Core accepts supported Compose top-level keys and Compose service keys at the input boundary, but it does not pass a raw Compose document across the provider boundary as the source of truth.

Planning handles supported Compose input in this order:

1. Parse, merge, and validate the Landofile against the Lando schema plus the documented Compose subset.
2. Normalize Compose keys with provider-neutral meaning into `AppPlan` fields. Examples: top-level `volumes:` → `stores`, top-level `networks:` → `networks`, service `volumes:` → `mounts`/`storage`, service `ports:`/`expose:` → `endpoints`, service `depends_on:` → `dependsOn`.
3. Preserve supported Compose keys that are valid but not provider-neutral under `AppPlan.extensions.compose` or `ServicePlan.extensions.compose` with secrets redacted where needed.
4. Check provider capabilities. If preserved Compose semantics require `composeSpec: native` and the selected provider does not declare it, planning fails with an actionable `CapabilityError` instead of silently dropping config.
5. Reject unsupported Compose keys with remediation pointing to either a supported Lando key, a provider extension, or a config translator when one is available.

This preserves the user-facing Compose subset while keeping the provider-neutral `AppPlan` as the runtime contract.

### 5.6 Provider extensions

Provider-specific config is permitted under namespaced keys. Core validates only that the namespace matches a known provider; the provider plugin owns extension validation.

```yaml
provider: docker
providers:
  docker:
    composeFiles:
      - compose.override.yml
    native:
      labels:
        example.com/private: "true"
    buildkitVersion: "0.16"
```

Rules:

- A Landofile that uses provider extensions is not portable across providers unless the extension declares a portable fallback.
- Compose-spec keys written directly in the Landofile are not provider extensions. They are accepted by the shared schema and are either normalized into provider-neutral plan fields or capability-checked as preserved Compose extensions (§5.5.1).
- Generated docs and `lando config` mark provider extensions as non-portable.
- Provider plugins MUST validate their extension schema with Effect Schema and emit `ProviderConfigError` on invalid input.

### 5.7 Provider errors

```ts
export type ProviderError =
  | ProviderUnavailableError
  | ProviderCapabilityError
  | ArtifactBuildError
  | ServiceStartError
  | ServiceExecError
  | ServiceNotFoundError
  | ProviderConfigError
  | ProviderInternalError;
```

Every provider error MUST include:

- Provider id (`providerId: string`).
- Operation name (`operation: string`).
- User-facing message (`message: string`).
- Debug details with secrets redacted (`details: unknown`).
- Suggested remediation when known (`remediation?: string`).
- Original cause attached for debug logs (`cause?: unknown`).

### 5.8 Bundled providers

Three providers ship with Lando v4. All implement the full `RuntimeProvider` contract.

#### 5.8.1 Default: Lando-managed runtime (`@lando/provider-lando`)

`@lando/provider-lando` is the default provider and the reference implementation of a self-contained provider. It uses Podman internally but exposes no Podman-specific interface to core or to users. User-facing messages, `lando setup` output, and status commands refer to it as the "Lando runtime" — not "Podman" — unless a debug or diagnostic context requires precision.

What this provider owns privately (all paths under Lando-controlled roots — see §12.4):

- Podman and companion helper binaries.
- A private config root (registries, policy).
- A private storage root (images, volumes).
- An API socket and PID files.
- On macOS and Windows: a managed VM/machine (creation, start, stop, upgrade, teardown).

It demonstrates:

- Runtime-bundle download and checksum verification during `lando setup`.
- Capability matrix population via internal API introspection — not a `podman` binary on `PATH`.
- OCI artifact build with secrets and SSH forwarding.
- Compose-file emission to a per-app temp directory (Compose is an *internal* implementation detail).
- `Bun.spawn`-driven exec against the private API socket, with stdio, TTY, and signal forwarding.
- A `Stream<LogChunk>` implementation backed by the private log API.
- Provider-extension schema for Compose passthrough, custom labels, registry credentials.

**`bindMountPerformance` declaration.** `@lando/provider-lando` declares per platform: `native` on Linux (the runtime is on the host filesystem), `slow` on macOS (the managed Podman machine is a VM with VM-mediated file sharing), `slow` on Windows (managed machine on WSL2 or Hyper-V; even WSL-resident projects pay for the Windows↔WSL boundary on host-mounted paths). The planner consults the live capability report at `app:start`, so a user who later adopts a future native macOS Linux container substrate sees the value flip without code changes.

`@lando/provider-lando` is bundled and active by default. Removing it from a distribution is supported.

#### 5.8.2 Opt-in: system Docker (`@lando/provider-docker`)

`@lando/provider-docker` targets a system-wide Docker installation (Docker Desktop or Docker Engine). Activate with `provider: docker` in a Landofile or `defaultProvider: docker` in global config.

It demonstrates:

- Capability matrix population via `docker version` introspection of the system socket.
- Buildx/BuildKit-based artifact build with secrets and SSH forwarding.
- `Bun.spawn`-driven `docker exec`, with stdio, TTY, and signal forwarding.
- A `Stream<LogChunk>` implementation backed by `docker logs --follow`.
- Provider-extension schema for Compose passthrough, native labels, registry credentials.

**`bindMountPerformance` declaration.** `@lando/provider-docker` reports `native` when the system Docker is Docker Engine on Linux, `slow` when the system Docker is Docker Desktop on macOS or Windows (the daemon runs in a VM regardless of WSL2/Hyper-V backend), and `native` when the system Docker is Docker Engine running natively inside WSL2 with the user's project living inside the WSL filesystem (detected via `/proc/version` introspection plus the resolved app-root path). The Compose-spec input subset documented in §7.4 is independent of this signal; bind performance is purely a host-IO concern.

#### 5.8.3 Opt-in: system Podman (`@lando/provider-podman`)

`@lando/provider-podman` targets a system-wide Podman installation. Activate with `provider: podman` in a Landofile or `defaultProvider: podman` in global config. It demonstrates the same core behaviors as `@lando/provider-docker`, adapted for the Podman API and rootless operation.

**`bindMountPerformance` declaration.** `@lando/provider-podman` reports `native` on Linux (rootless or rootful, both run on the host filesystem), `slow` on macOS and Windows (the user's Podman machine is a VM), with the same WSL-resident detection as `@lando/provider-docker`. Plugin authors implementing additional providers (Lima, OrbStack, Rancher Desktop, remote/cloud) MUST report `bindMountPerformance` honestly: OrbStack on macOS reports `native` because its file-sharing layer reaches host-filesystem latency; Lima with default settings reports `slow`; Rancher Desktop reports `slow`.

### 5.9 Multi-provider apps (deferred)

The initial v4 planning model assumes one runtime provider per app. Per-service provider selection is non-portable and lives under `services.<name>.providers.<id>` only as a provider-extension hint.

Multi-provider apps require additional design for: shared networking across providers, route ownership, cross-provider lifecycle ordering, failure handling, and capability negotiation. This is explicitly deferred past v4.0.0.

---
