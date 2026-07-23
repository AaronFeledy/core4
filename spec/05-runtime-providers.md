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
3. **Provider selection is explicit and cached.** When an app plan needs a runtime provider and no app/global config overrides provider selection, Lando selects the bundled Lando-managed runtime (`@lando/provider-lando`) as the default. That selection is stored per-app in the app plan cache. Host-only commands and host-targeted tooling do not need a runtime provider selection at all.
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
  LogSource,
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

  // Data plane (§10.11). Capability-gated; the core `DataMover` calls a native method only when the
  // matching capability is declared, else it falls back to a generic helper-container path built on
  // `run`/`runStream` (which is why `run` is mount-aware — see EphemeralRunSpec below).
  readonly snapshotVolume:  (spec: VolumeSnapshotSpec) => Effect.Effect<VolumeSnapshotRef, ProviderError, Scope.Scope>;
  readonly restoreVolume:   (spec: VolumeRestoreSpec)  => Effect.Effect<void, ProviderError, Scope.Scope>;
  readonly listVolumes:     (filter: VolumeFilter)     => Effect.Effect<ReadonlyArray<VolumeInfo>, ProviderError>;
  readonly removeVolume:    (ref: VolumeRef)           => Effect.Effect<void, ProviderError>;
  readonly copyToService:   (target: ExecTarget, spec: ServiceCopyInSpec)  => Effect.Effect<void, ProviderError, Scope.Scope>;
  readonly copyFromService: (target: ExecTarget, spec: ServiceCopyOutSpec) => Stream.Stream<Uint8Array, ProviderError, Scope.Scope>;
  readonly exportArtifact:  (ref: ArtifactRef)         => Stream.Stream<Uint8Array, ProviderError, Scope.Scope>;
  readonly importArtifact:  (data: Stream.Stream<Uint8Array, ProviderError>) => Effect.Effect<ArtifactRef, ProviderError, Scope.Scope>;
}>()("@lando/core/RuntimeProvider") {}
```

**Data-plane methods and the mount-aware `run`.** The seven data-plane methods above are the
provider side of the §10.11 data-movement primitive. They are capability-gated (§5.4): the core
`DataMover` invokes `snapshotVolume`/`copyToService`/`exportArtifact`/… only when the provider
declares the matching capability `native`, and otherwise realizes the same operation generically by
mounting the target volume into a tiny helper container and streaming `tar` through
`run`/`runStream`. For that generic fallback to work on every provider, `EphemeralRunSpec` is
mount- and stream-aware:

```ts
export interface EphemeralRunSpec {
  readonly image: string;
  readonly command: ReadonlyArray<string>;
  readonly mounts?: ReadonlyArray<MountPlan | DataStoreMountPlan>;   // mount a volume/host path into the helper
  readonly stdin?: "inherit" | "ignore";
  readonly stdinStream?: AsyncIterable<Uint8Array>;                  // feed an archive into the helper
  readonly captureStdout?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly remove?: boolean;                                         // default true
}
// streaming sibling of `run`, for `tar c` → stdout style generic export:
readonly runStream: (spec: EphemeralRunSpec) => Stream.Stream<ExecChunk, ProviderError, Scope.Scope>;
```

A provider that declares `ephemeralMounts: false` (§5.4) cannot host the generic fallback; the
planner/`DataMover` then requires the corresponding native capability and otherwise fails with
`CapabilityError`. The `VolumeRef` / `VolumeInfo` / `VolumeFilter` / `VolumeSnapshotSpec` /
`VolumeSnapshotRef` / `VolumeRestoreSpec` / `ServiceCopyInSpec` / `ServiceCopyOutSpec` schemas are
defined in `@lando/sdk` (`schema/data-transfer.ts`) and detailed in §10.11.

**`exec` vs `execStream`.** `exec` returns a collected `ExecResult` (stdout / stderr buffered, exit code) and is the right primitive for short, structured calls (a single `psql -c "select 1"`, a healthcheck probe). `execStream` returns a `Stream<ExecChunk>` where each chunk is `{ stream: "stdout" | "stderr", data: Uint8Array }` followed by a terminal `{ exit: number }` chunk; it is the right primitive for long-running output that must be observable while it runs (the build orchestrator's `composer install` / `npm ci` steps; `lando logs --follow`'s sibling for one-shot exec; tooling tasks with `interactive: false` that the renderer needs to stream into a tail panel). `exec` MUST be implemented as a thin collector over `execStream` (`Stream.runFold`) — providers do not duplicate spawn logic. `Effect.interrupt` MUST propagate through `execStream` to the underlying `kill()` and the service's `Scope` MUST reap the child before resolving, identical to the contract on `RuntimeProvider.logs`. Unlike `logs`, `execStream` is `Scope`-bounded: a stream that is dropped without being consumed to completion still terminates the underlying exec at scope close.

**`logs` and declared log sources.** `logs` streams the service's container stdout/stderr (the implicit `console` source) from the engine's native log API. `LogOptions` additionally carries the target's resolved **declared log sources** (§6.14) and an optional single-source filter:

```ts
export interface LogTarget extends ServiceSelector {}

export interface LogOptions {
  readonly follow: boolean;
  readonly tail?: number;
  readonly since?: string;
  readonly sources?: ReadonlyArray<LogSource>;   // resolved declared file sources; `console` is always implicit
  readonly source?: LogSourceId;                 // optional: restrict the stream to one source id
}
```

When `sources` contains any `strategy: "follow"` entry, the provider merges the console stream with a follower per file source and tags every emitted chunk with its `LogChunk.source`. Following such a source requires `serviceLogSources: true` (§5.4); a provider that declares it false MUST still stream `console` (and any `redirect` sources, which arrive on the console stream because they were pointed at `/dev/stdout`/`/dev/stderr` at build time). The provider — not a core `execStream(tail -F …)` shim — owns following, so remote/VM providers are first-class and no `tail` dialect is assumed. Followers honor the finite/follow, missing-file, rotation, line-framing, bounding, per-source `since`/`tail`, ordering, and scope-reaping semantics defined normatively in §6.14.4. Like today, `logs` emits **raw** `LogChunk`s; redaction is applied once at the renderer/event/machine-output boundary (§6.14.5).

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
  serviceLogSources: Schema.Boolean,   // can follow declared in-container log files (§6.14) inside `logs`
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
  // Data plane (§10.11). Drive `DataMover` dispatch: native method vs generic helper-container fallback.
  volumeSnapshot: Schema.Literal("native", "copy", "none"),  // native=CoW/commit; copy=tar export+import; none
  serviceFileCopy: Schema.Literal("native", "exec", "none"), // native=cp API; exec=tar-over-exec; none
  artifactExport: Schema.Boolean,                            // `image save`
  artifactImport: Schema.Boolean,                            // `image load`
  ephemeralMounts: Schema.Boolean,                           // `run` honors spec.mounts — gates the generic fallback
  providerExtensions: Schema.Array(Schema.String),
});
export type ProviderCapabilities = Schema.Schema.Type<typeof ProviderCapabilities>;
```

If a service, feature, or subsystem requires a missing capability, planning fails with `CapabilityError` containing the service, feature, capability, provider id, and a suggested fix.

Endpoint publication is explicit desired state (§6.6). Before returning an `AppPlan`, the planner checks every `PublishedEndpoint` against `hostPortPublish`; `"none"` fails with `PublicationUnsupportedError` and remediation before any provider action. `InternalEndpoint` never requires this capability. Providers materialize only published endpoints as host bindings and return any provider-assigned host port as runtime endpoint materialization, not by mutating `publication.hostPort`.

`composeSpec` describes how much supported Compose input the provider can realize after core has parsed it:

- `none` — the provider can only realize fields that core normalized into provider-neutral `AppPlan` fields.
- `portable` — the provider can realize the Compose keys that have direct provider-neutral equivalents, such as standard service environment, command, mounts, stores, networks, endpoints, and dependencies.
- `native` — the provider can also consume Compose-native fields preserved in plan extensions, such as provider labels, deploy hints, build variants, profiles, configs, and secrets.

`bindMountPerformance` describes the provider's host↔guest filesystem-IO characteristics for `bind`-type mounts:

- `native` — the provider's bind mount path is the host filesystem (Linux native runtime, OrbStack on macOS, Linux containers on Linux Docker/Podman). The planner realizes `MountPlan`s of `type: bind` directly through the provider with no `FileSyncEngine` involvement.
- `slow` — the provider runs in a separate filesystem boundary (Docker Desktop's VM-mediated VirtioFS / osxfs / 9p; Podman Desktop machines; Lima/Colima at default settings; Windows Docker Desktop with WSL2 backend when the project lives outside the WSL filesystem). The planner marks every `bind` mount in the resolved `AppPlan` as `realization: "accelerated"` and routes its lifecycle through the active `FileSyncEngine` (§4.2, §10.6); the user's Landofile is unchanged and the user does not opt into the behavior.
- `none` — the provider does not support bind mounts at all (some remote/cloud providers). Plans containing `bind` mounts fail with `CapabilityError` per the §5.4 capability-validation rule.

`sharedCrossAppNetwork` declares whether services in different apps can reach each other via `<service>.<app>.internal` DNS aliases on the same provider network. Required by virtually every plugin-contributed `globalServices:` entry (§20.4); without it the contribution is dropped from the global plan with a doctor warning (§20.8.1).

The five **data-plane capabilities** describe how much of the §10.11 data-movement surface the provider realizes natively versus through the generic helper-container fallback:

- `volumeSnapshot` — `native` means the provider has a fast clone/commit path for a named volume; `copy` means snapshots are realized by `DataMover` as a verified `tar` archive (export + import); `none` means the provider supports no volume snapshot at all (a `lando db snapshot` against such a provider fails with `CapabilityError`).
- `serviceFileCopy` — `native` exposes a host↔container copy API (`docker cp` / `podman cp` equivalent); `exec` realizes the same via `tar`-over-`exec`; `none` forbids arbitrary path copy.
- `artifactExport` / `artifactImport` — whether the provider can stream a built artifact (image) out to / in from an archive, backing `image save` / `image load`.
- `ephemeralMounts` — whether `run` honors `spec.mounts`. This is the **gate for the generic fallback**: when `false`, `DataMover` cannot tar a volume through a helper container, so any operation that lacks a `native` capability fails with `CapabilityError` rather than silently degrading.

These five are informational at the boundary, not knobs; providers MUST report them truthfully and the §13.1 provider contract suite verifies that a provider declaring `native` actually does not fall back.

`bindMountPerformance` is informational at the boundary, not a knob. Providers MUST report it truthfully; misreporting is treated as a contract violation by the §13.1 provider contract suite. The planner consults this field exactly once per `app:start` to compute the `realization` flag on every `MountPlan`; runtime overrides require a Landofile-level escape hatch (`mounts: [..., accelerate: false]`) or a global `defaultFileSyncEngine: passthrough` setting, neither of which is documented in canonical recipes or executable guides. The §13.1 perf-budget suite asserts that `app:start` against a `bindMountPerformance: "slow"` provider does **not** regress to native bind IO — i.e., the `FileSyncEngine` actually engaged.

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

Every `RoutePlan` in the plan carries a planner-resolved `backend` with the target `service`, HTTP protocol, and service port. Route providers consume that backend without inspecting service endpoints or applying fallback-port heuristics.

### 5.5.1 Supported Compose input at the boundary

The Landofile supports a documented Compose subset (§7.4). Core accepts supported Compose top-level keys and Compose service keys at the input boundary, but it does not pass a raw Compose document across the provider boundary as the source of truth.

Planning handles supported Compose input in this order:

1. Parse, merge, and validate the Landofile against the Lando schema plus the documented Compose subset.
2. Normalize Compose keys with provider-neutral meaning into `AppPlan` fields. Examples: top-level `volumes:` → `stores`, top-level `networks:` → `networks`, service `volumes:` → `mounts`/`storage`, service `ports:`/`expose:` → `endpoints`, service `depends_on:` → `dependsOn`.
3. Preserve supported Compose keys that are valid but not provider-neutral under `AppPlan.extensions.compose` or `ServicePlan.extensions.compose` with secrets redacted where needed.
4. Check provider capabilities. If preserved Compose semantics require `composeSpec: native` and the selected provider does not declare it, planning fails with an actionable `CapabilityError` instead of silently dropping config.
5. Reject Compose keys carrying the `rejected` disposition with remediation pointing to either a supported Lando key, a provider extension, or a config translator when one is available.

The normalize/preserve/reject classification for every Compose service key is committed as the §7.4 disposition matrix (backed by the vendored, pinned upstream Compose JSON Schema) and enforced by the `check:compose-coverage` gate; planning consults that matrix rather than re-deciding per key. This preserves the user-facing Compose subset while keeping the provider-neutral `AppPlan` as the runtime contract.

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
  | ProviderInternalError
  | VolumeOperationError      // §10.11 data plane: snapshot/restore/list/remove volume failed
  | ServiceCopyError          // §10.11 data plane: copyTo/copyFromService failed
  | ArtifactTransferError;    // §10.11 data plane: exportArtifact/importArtifact failed
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

- Podman >= 6.0.0 and companion helper binaries.
- A private config root (registries, policy).
- A private storage root (images, volumes).
- An API socket and PID files.
- On macOS and Windows: a managed VM/machine (creation, start, stop, upgrade, teardown).

**Podman 6 runtime floor.** The bundled Lando-managed runtime MUST use Podman >= 6.0.0 on every supported host. Version comparison is numeric over `major.minor.patch`; pre-release and build suffixes are ignored for the floor check, so a `6.x` pre-release gates as its numeric version. The same floor applies to the system-wide Podman provider (§5.8.3). Podman 6.0.0 fixes CVE-2026-57231 / GHSA-4hq8-gpf5-8p68, where malformed image `Env` entries could leak host environment variables into containers; the advisory also lists patched v5 lines, but Lando's supported floor is 6.0.0.

**Podman 6 platform and network contract.** Supported Podman-backed hosts are: Apple Silicon macOS only, Windows 11 or newer, and Linux hosts with cgroups v2 and nftables. Podman 6 removed upstream support for Intel Macs, Windows 10, cgroups v1, iptables, CNI networking, and the `slirp4netns` rootless network stack. Lando's rootless Podman contract is therefore Pasta for rootless networking plus Netavark and Aardvark v2. The provider MUST fail setup/readiness with tagged remediation when a host can only satisfy the removed stack instead of silently selecting a legacy compatibility path.

**Podman machine command caveat.** Managed macOS and Windows machines MAY use Podman 6's machine connection controls, including `podman machine start --update-connection=false`, when preserving a user's default system connection matters. Published Podman v6.0.0/latest manpages expose the machine OS command as `podman machine os upgrade` while the v6.0.0 release notes refer to `podman machine os update`; until that spelling conflict is resolved in the Beta PRD open questions, this top-level spec does not normatively require one exact OS-update subcommand spelling.

It demonstrates:

- Runtime-bundle download and checksum verification during `lando setup`.
- Capability matrix population via internal API introspection — not a `podman` binary on `PATH`.
- OCI artifact build with secrets and SSH forwarding.
- Compose-file emission to a per-app temp directory (Compose is an *internal* implementation detail).
- `Bun.spawn`-driven exec against the private API socket, with stdio, TTY, and signal forwarding.
- A `Stream<LogChunk>` implementation backed by the private log API.
- Provider-extension schema for Compose passthrough, custom labels, registry credentials.

**Runtime-bundle source resolution.** The bundle `lando setup` downloads is resolved from a manifest of per-platform `{ url, sha256, filename, sizeBytes }` entries. Production resolves the manifest bundled into the plugin (`runtime-bundle-versions.json`, §17.2), whose entries MUST be `https://` URLs pinned to immutable runtime-bundle assets published on the core repository's own GitHub Releases under the `runtime-v<runtime-bundle-version>` tag series. There is no separate runtime-bundles repository: the manifest is source (versioned with the code and embedded at compile time like any other module), and the bundle bytes are release assets of this repository. A dev/CI escape hatch lets `lando setup` redirect to a locally-built bundle **without ever weakening verification**:

- `LANDO_RUNTIME_BUNDLE_MANIFEST=<path>` supplies an alternate manifest (identical schema) that replaces the bundled one for the run.
- The paired `--runtime-bundle-url` and `--runtime-bundle-sha256` flags override a single resolved entry's URL and checksum **together** — supplying one without the other is rejected, because a URL swap that keeps the pinned checksum can never verify a different artifact.

Override-loaded entries MAY use `file://` URLs so neither CI nor a developer needs to stand up a server; the bundled production manifest MUST NOT. In every path the selected entry is handed to `Downloader` (§10.3.3), and the downloaded bytes are rejected unless `sha256(bytes)` equals the active entry's checksum — the override **redirects** verification to the locally-built artifact's checksum, it never disables it. There is no flag that skips checksum verification. Precedence: `LANDO_RUNTIME_BUNDLE_MANIFEST` > `--runtime-bundle-url` + `--runtime-bundle-sha256` > bundled pinned manifest.

**The committed-manifest invariant.** At every commit on the default branch, the committed `runtime-bundle-versions.json` MUST reference already-published, immutable release assets with their real SHA-256 checksums and sizes — placeholder entries (all-zero-style checksums or `sizeBytes: 0`) are forbidden. Because the manifest is always true, *any* binary compiled from *any* commit — a local developer build, a dev-channel snapshot, or a tagged release — resolves and verifies the runtime bundle with **zero overrides**, and running from source resolves the same manifest from the checkout. There is no channel-aware manifest resolution and no runtime manifest fetch: dev and release binaries behave identically, differing only in which commit's manifest they embed. Published `runtime-v*` assets are never re-uploaded or deleted, so the embedded manifest of an older binary remains resolvable for that binary's lifetime. The overrides above exist for exactly one situation: exercising a bundle whose contents are not yet published (bundle development and the §13.5 current-commit CI verification).

**`bindMountPerformance` declaration.** `@lando/provider-lando` declares per platform: `native` on Linux (the runtime is on the host filesystem), `slow` on Apple Silicon macOS (the managed Podman machine is a VM with VM-mediated file sharing), `slow` on Windows 11+ (managed machine on WSL2 or Hyper-V; even WSL-resident projects pay for the Windows↔WSL boundary on host-mounted paths). The planner consults the live capability report at `app:start`, so a user who later adopts a future native macOS Linux container substrate sees the value flip without code changes.

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

`@lando/provider-podman` targets a system-wide Podman >= 6.0.0 installation. Activate with `provider: podman` in a Landofile or `defaultProvider: podman` in global config. It demonstrates the same core behaviors as `@lando/provider-docker`, adapted for the Podman API and rootless operation. Version comparison uses the same numeric `major.minor.patch` floor policy as the bundled runtime: pre-release and build suffixes are ignored, so `6.x` prereleases gate as their numeric version.

**`bindMountPerformance` declaration.** `@lando/provider-podman` reports `native` on Linux (rootless or rootful, both run on the host filesystem), `slow` on Apple Silicon macOS and Windows 11+ (the user's Podman machine is a VM), with the same WSL-resident detection as `@lando/provider-docker`. Plugin authors implementing additional providers (Lima, OrbStack, Rancher Desktop, remote/cloud) MUST report `bindMountPerformance` honestly: OrbStack on macOS reports `native` because its file-sharing layer reaches host-filesystem latency; Lima with default settings reports `slow`; Rancher Desktop reports `slow`.

### 5.9 Multi-provider apps (deferred)

The initial v4 planning model assumes one runtime provider per app. Per-service provider selection is non-portable and lives under `services.<name>.providers.<id>` only as a provider-extension hint.

Multi-provider apps require additional design for: shared networking across providers, route ownership, cross-provider lifecycle ordering, failure handling, and capability negotiation. This is explicitly deferred past v4.0.0.

---
