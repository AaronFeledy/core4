# Lando v4 — Subsystems

> **Part 11 of 18** · [Index](./README.md)
> **Read next:** [12 Caches and Persistence](./12-caches-and-persistence.md)

This part defines the cross-cutting subsystems that sit between the core runtime and provider/plugin implementations. Each subsystem owns a small set of responsibilities, exposes a pluggable `Context.Service`, and is realized by one or more plugin implementations.

Covered here: networking intent (no shared bridge in core; `<service>.<app>.internal` aliasing; `host.lando.internal`), `ProxyService` and `RoutePlan` (with the route-filter abstraction replacing Traefik-specific middleware), `CertificateAuthority` (root CA, leaf certs, trust-store install), corporate proxy and custom CA handling for Lando-owned network access, SSH and host identity (with the new SSH-agent sidecar default that eliminates direct host-agent socket mounts), `HealthcheckRunner` and `UrlScanner`, files and performance, SQL helpers (plugin-provided; not in core), `lando setup` and host integration, the per-app `HostProxyService` that lets in-container shims (`xdg-open`, `lando`) call back to the host over a token-authenticated Unix socket, and logs/diagnostics.

---

## 10. Subsystems

Each subsystem defines a small set of responsibilities, exposes a pluggable `Context.Service`, and is realized by one or more plugin implementations.

### 10.1 Networking

Core defines network *intent*, not implementation. The `RuntimeProvider` is responsible for realizing the intent.

**Required behaviors** (provider-implemented when capability allows):

- Services in an app resolve each other by service name (`<service>`) when the provider supports app networking.
- Cross-app service names use `<service>.<app>.internal` when the provider supports `sharedCrossAppNetwork`.
- `host.lando.internal` resolves to the host gateway when `hostReachability` is `native` or `emulated`. `LANDO_HOST_IP` is set to the resolvable name (not necessarily a numeric IP).
- Providers without shared networking MUST report `sharedCrossAppNetwork: false`. Features depending on it produce actionable errors.
- Host-exposed endpoints bind to `127.0.0.1` by default. LAN exposure is opt-in via `bindAddress`.

There is no built-in concept of a "shared bridge network" in core. Providers that need one create and manage it themselves; the docker provider creates `lando_bridge_network` as an implementation detail.

### 10.2 Proxy and routing

Core owns the `RoutePlan` schema. `ProxyService` plugins own implementation.

```ts
export class ProxyService extends Context.Service<ProxyService, {
  readonly id: string;
  readonly capabilities: ProxyCapabilities;
  readonly setup: (config: ProxyConfig) => Effect.Effect<void, ProxyError, Scope.Scope>;
  readonly applyRoutes: (routes: ReadonlyArray<RoutePlan>, app: AppId) => Effect.Effect<ProxyApplyResult, ProxyError>;
  readonly removeRoutes: (app: AppId) => Effect.Effect<void, ProxyError>;
  readonly status: Effect.Effect<ProxyStatus, ProxyError>;
  readonly stop: Effect.Effect<void, ProxyError>;
}>()("@lando/core/ProxyService") {}
```

**Required behaviors:**

- Default local domain configurable; default `lndo.site`.
- Route plans support hostnames, wildcard hostnames, ports, paths, TLS intent, filters.
- Route status appears in `lando info` and post-start messages.
- Offline/custom-domain workflows are supported via the global `domain` config.
- Proxy plugins reconcile stale routes during rebuild and destroy.
- Proxy plugins consume `RouteFilter` plugin contributions to translate filters into native middleware.

**§10.2.1 Default Live Layer realization through the global app**

The default `ProxyService` Live Layer in v4 — `ProxyServiceTraefikGlobalAppLive`, shipped with `@lando/proxy-traefik` (§1.4) — realizes its work through a `traefik` service running inside the global Lando app (§20). The plugin contributes BOTH a `proxyServices:` entry (the Live Layer) AND a paired `globalServices:` entry (the `traefik` service definition); installing one without the other is rejected at plugin load with `ProxyContributionPairError` (§20.10.1, §20.13).

Required behaviors:

- `ProxyService.applyRoutes(routes, app)` writes Traefik dynamic config under a Lando-managed directory mounted into the `traefik` global service via the standard `mounts:` machinery. The `RoutePlan` schema is core's contract; the on-disk format is the proxy plugin's responsibility.
- `ProxyService.setup` calls `GlobalAppService.ensureRunning(["traefik"])` so the first user-app `lando start` after install brings the proxy up automatically.
- The §10.2 `ProxyService` interface is unchanged; only the realization moved into the global app. Alternative `ProxyService` plugins (remote proxy, Caddy, etc.) MAY contribute a Live Layer that does NOT touch `GlobalAppService`; selection follows §4.3.
- A user upgrading from a pre-§20 install whose host still has a v3-style out-of-band Traefik container running gets a `LegacyProxyContainerDetected` doctor diagnostic (§10.9, §20.10.3); migration is plugin-supplied.

### 10.3 Certificates and CA

Core owns certificate intent. `CertificateAuthority` plugins own issuance and host trust.

```ts
export class CertificateAuthority extends Context.Service<CertificateAuthority, {
  readonly id: string;
  readonly capabilities: CaCapabilities;
  readonly ensureRootCA: Effect.Effect<RootCaInfo, CaError, Scope.Scope>;
  readonly installToTrustStore: Effect.Effect<void, CaError>;
  readonly issueLeaf: (request: LeafCertRequest) => Effect.Effect<LeafCertInfo, CaError>;
  readonly revokeLeaf: (id: LeafCertId) => Effect.Effect<void, CaError>;
}>()("@lando/core/CertificateAuthority") {}
```

**Required behaviors:**

- A dev CA can be generated and trusted via `lando setup`.
- Service certs include SANs for the service id, the canonical internal alias, configured `hostnames:`, proxied hostnames, `localhost`, and `127.0.0.1`.
- Cert/key paths are exposed as `LANDO_SERVICE_CERT` and `LANDO_SERVICE_KEY` in service env.
- Corporate/custom CA injection via `security.ca:` is supported; the install-to-trust-store path is plugin-implemented.
- Trust-store install is `PrivilegeService`-aware on platforms that require elevation.

### 10.3.1 Corporate proxies and outbound trust

Lando-owned network access MUST work behind corporate HTTP(S) proxies and custom CA chains. This applies to runtime bundle downloads, plugin resolution/install, include and recipe resolution, update checks, telemetry delivery, provider-helper downloads, and any provider artifact pull that Lando initiates directly.

Required behaviors:

- Lando-owned network clients honor explicit global `network.proxy` config (§7.5), then standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables when config is unset.
- Lando-owned network clients honor additional CA certificates from global `network.ca.certs` (§7.5) and `LANDO_NETWORK_CA_CERTS`, and use the host trust store when `network.ca.trustHost: true` and the platform supports it.
- `lando setup` validates proxy/CA configuration before long downloads and surfaces actionable remediation for TLS interception, proxy authentication, missing CA, and blocked registry errors.
- Provider plugins receive the resolved proxy and CA configuration during setup/apply so they can configure private runtimes, helper binaries, provider-native artifact pulls, and Lando-initiated artifact builds consistently.
- App build/dependency commands can opt into inheriting the resolved proxy and CA configuration from service config (§6.8). Lando does not force those settings into arbitrary app processes by default because proxy credentials may be sensitive.
- Service-level `security.ca:` remains separate from Lando-owned outbound trust: it injects CAs into app services, while `network.ca` controls Lando's own fetches.
- Proxy credentials are secrets. They are redacted from logs, telemetry, support diagnostics, lockfiles, and cache metadata.
- Offline-capable commands do not fail because proxy/CA endpoints are unreachable when their required local state is already present (§12.6).

### 10.4 SSH and host identity

**Required behaviors:**

- Host SSH keys from `~/.ssh` and managed Lando keys are forwarded or copied per provider capability.
- `keys: false` disables key loading.
- A string array allowlists keys (`keys: ["~/.ssh/work_id"]`).
- Passphrase-protected keys work through an active SSH agent when available.
- Host identity env (`LANDO_HOST_USER`, `LANDO_HOST_UID`, `LANDO_HOST_GID`, `LANDO_HOST_HOME`) is injected when known.
- Provider limitations are surfaced clearly on Windows, remote providers, and rootless runtimes.

**SSH-agent design.** v4 ships an `ssh-agent` feature for `type: lando` services. The default implementation uses a dedicated SSH-agent **sidecar** rather than directly bind-mounting the host agent socket into every service. This eliminates the v3-era pattern where every service had unrestricted access to the host SSH agent.

Behavior in v4.0:

- `sshAgent.sidecar: true` is the default (global setting; per-service override `packages.ssh-agent.sidecar:`). The sidecar mode is **decided** for v4.0.
- `sshAgent.sidecar: false` is reserved and rejected in Beta 1. Direct host SSH-agent socket mounts do not ship; users must use the supported sidecar path instead.
- Plugins MAY provide alternate SSH-agent implementations via the `features` contribution surface. Alternate implementations MUST declare their security posture in the feature manifest so `lando doctor` can surface non-default agent forwarding.

### 10.5 Healthchecks and scanner

**Healthcheck behaviors:**

- Healthchecks support `false`/`disabled`, string, string-array, and object forms; any form may be computed from disk via `load()` (§7.3).
- Object form supports `command`, `user`, `retry`, `delay`, `timeout`, `target`.
- Startup distinguishes `running` from `ready`. The `ready` event fires when all healthchecks pass.
- The active `HealthcheckRunner` decides execution mechanics. Default: `RuntimeProvider.exec` with retry/delay loop.
- Healthchecks may declare `target: service | host` (default `service`). Service-target healthchecks run inside the named service via `RuntimeProvider.exec`. Host-target healthchecks run on the host via `ShellRunner` (§3.4) and are useful for probing proxy routes, TLS endpoints, port reachability, or DNS resolution from outside the container — exactly the cases where running the probe inside the service would test the wrong thing. Plugin-supplied `HealthcheckRunner` implementations MAY provide native probes (e.g., a TCP probe, a Postgres `SELECT 1`) that bypass shell entirely; runners declare which targets they can satisfy via `capabilities`, and the planner refuses healthchecks whose declared `target:` no installed runner supports with `HealthcheckTargetUnsupportedError`.

**URL scanner behaviors:**

- After start, the active `UrlScanner` probes host-facing URLs.
- Scanner config: `enabled`, `retry`, `delay`, `timeout`, `path`, `okCodes`, `maxRedirects`.
- Per-service overrides under `services.<name>.scanner:`.
- Results are reported as green/yellow/red with optional structured detail.
- The default scanner uses Bun's built-in `fetch` against the resolved host-facing URL. Plugin-supplied scanners MAY use `ShellRunner` (§3.4) for shell-shaped probes — `curl --resolve` for testing custom DNS, `openssl s_client -connect` for TLS handshake details, `dig +short` for record validation — particularly when a project's routing depends on host networking that `fetch` cannot reproduce. Plugin scanners surface the same green/yellow/red verdict shape; only the underlying probe mechanism differs.

### 10.6 Files and performance

**Required behaviors:**

- App root, user home, and user config root are accessible to services when the provider supports it.
- File-sharing strategy is provider-specific behind portable `MountPlan` intent.
- Excludes/includes live on individual mounts, never on a global key.
- Heavy directories (`node_modules`, `vendor`, `.cache`) can be excluded from live host sync.
- Windows/WSL guidance is documentation and provider-setup behavior, not core logic.
- Bind-mount realization is split between the provider's native primitive (`realization: "passthrough"`) and an accelerated path through a pluggable `FileSyncEngine` (`realization: "accelerated"`) selected by the provider's `bindMountPerformance` capability (§5.4, §6.4). The user's Landofile is the same in both cases — the engine is invisible by design.

The pluggable engine — `FileSyncEngine` (§4.2) — is what makes accelerated bind mounts work. The default implementation is the no-op `passthrough` engine; the bundled default for slow-IO providers is `@lando/file-sync-mutagen`, the Mutagen-backed reference engine documented in §10.6.2.

#### 10.6.1 `FileSyncEngine` architecture

`FileSyncEngine` is a session-stateful service. One session per accelerated `MountPlan` per started app. The engine is a `Layer.suspend`-wrapped service in the level-`app` bootstrap layer (§3.4); the suspended Layer is forced only when the planner emits the first `createSession` call, so apps with zero accelerated mounts pay zero engine cost.

```ts
export class FileSyncEngine extends Context.Service<FileSyncEngine, {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: FileSyncEngineCapabilities;

  // Availability and one-time setup. `setup` is called by `lando setup` (§10.8) and by
  // the planner's auto-acquisition path on first accelerated `app:start`.
  readonly isAvailable: Effect.Effect<boolean, FileSyncError>;
  readonly setup:        (options: FileSyncSetupOptions) => Effect.Effect<void, FileSyncError, Scope.Scope>;

  // Per-mount session lifecycle. createSession is `Scope`-acquired so that interruption
  // and app-stop both flow through the standard finalization path.
  readonly createSession:    (spec: FileSyncSessionSpec) => Effect.Effect<FileSyncSessionRef, FileSyncError, Scope.Scope>;
  readonly pauseSession:     (ref: FileSyncSessionRef)   => Effect.Effect<void, FileSyncError>;
  readonly resumeSession:    (ref: FileSyncSessionRef)   => Effect.Effect<void, FileSyncError>;
  readonly terminateSession: (ref: FileSyncSessionRef)   => Effect.Effect<void, FileSyncError>;

  // Diagnostics
  readonly listSessions: (filter: FileSyncSessionFilter) => Effect.Effect<ReadonlyArray<FileSyncSessionInfo>, FileSyncError>;
  readonly streamEvents: (ref: FileSyncSessionRef)       => Stream.Stream<FileSyncEventChunk, FileSyncError>;
}>()("@lando/core/FileSyncEngine") {}

export const FileSyncEngineCapabilities = Schema.Struct({
  modes:                Schema.Array(Schema.Literal("two-way-safe", "two-way-resolved", "one-way-safe", "one-way-replica")),
  remoteAgentDeployment: Schema.Literal("auto", "preinstalled", "none"),
  exclusionPatterns:    Schema.Boolean,
  conflictReporting:    Schema.Boolean,
  progressReporting:    Schema.Boolean,
});
export type FileSyncEngineCapabilities = Schema.Schema.Type<typeof FileSyncEngineCapabilities>;

export const FileSyncSessionSpec = Schema.Struct({
  app:        AppRef,
  service:    ServiceName,
  mountKey:   Schema.String,                                  // §6.4 stable mount key
  source:     AbsolutePath,                                   // host-side source
  target:     Schema.Union(
    Schema.TaggedStruct("volume",  { name: Schema.String, path: PortablePath }),
    Schema.TaggedStruct("service", { service: ServiceName,  path: PortablePath }),
  ),
  mode:       Schema.Literal("two-way-safe", "two-way-resolved", "one-way-safe", "one-way-replica"),
  excludes:   Schema.Array(Schema.String),
  permissions: Schema.optional(Schema.Struct({
    owner: Schema.optional(Schema.String),
    mode:  Schema.optional(Schema.String),
  })),
});
export type FileSyncSessionSpec = Schema.Schema.Type<typeof FileSyncSessionSpec>;
```

Required `FileSyncEngine` behaviors:

- `setup` is the engine's "make yourself ready" entry point. It MUST be idempotent. The default `passthrough` engine's `setup` is a no-op; engines that require external binaries (Mutagen and any plugin equivalent) MUST download and verify their binaries during `setup`, write them under `<userDataRoot>/bin/` (§12.4), and report progress through the standard `Renderer` channel. `setup` is run by `lando setup` and by the planner's auto-acquisition path on first accelerated `app:start` when the engine reports `isAvailable: false`.
- `createSession` MUST be `Scope`-acquired. The associated `Scope` is the app's started state; `app:stop` finalizes it; `Effect.interrupt` propagates as a session terminate. The returned `FileSyncSessionRef` is opaque to the planner and stable across pause/resume cycles.
- Engines MUST publish `pre-file-sync-create` / `post-file-sync-create`, `pre-file-sync-pause` / `post-file-sync-pause`, `pre-file-sync-resume` / `post-file-sync-resume`, and `pre-file-sync-terminate` / `post-file-sync-terminate` events for every session-lifecycle transition (§3.5, §11.2). Engines MUST stream `file-sync-conflict-detected` for conflicts and `file-sync-progress` for at-least the four standard phases (`initial-scan`, `staging`, `transitioning`, `watching`).
- Source paths under the host user's home directory MUST be normalized to a `${HOME}/<...>` shape in event payloads, transcript captures, and `lando info` output. The active `Logger` at debug level MAY observe the absolute path for diagnostic purposes.
- Engines MUST be safe to use behind corporate proxies and custom CA chains (§10.3.1) for any binary download or registry call they perform. The default Mutagen engine resolves Mutagen release URLs through the same `network.proxy` / `network.ca` resolution path as the rest of core.
- Engines MUST refuse to start a session whose `source` resolves outside the app root (after symlink resolution) unless the global `--allow-load-outside-root` opt-in is set (§7.3); the failure is `FileSyncSourceOutsideRootError`.
- Engines MUST NOT speak to the runtime provider directly. Volume creation, container exec, and agent-deployment hooks (when needed) go through `RuntimeProvider.exec` and `RuntimeProvider.run` per the §5.3 contract. This keeps the engine portable across providers.
- Engines MUST cooperate with offline mode (§1.4 disconnectable local-dev): a `pause` operation triggered by network loss MUST be silent and reversible, and `resume` MUST not require network for sessions whose binaries and agent images are already cached.

Tagged errors live in `@lando/core/errors`:

- `FileSyncEngineUnavailableError` — `setup` failed or the engine cannot satisfy `isAvailable` (binary missing, daemon unreachable, agent deployment refused). Payload includes the engine id, a debug `cause`, and remediation pointing at `lando setup` or `lando doctor`.
- `FileSyncSessionFailedError` — a `createSession` call failed (provider volume creation refused, agent deploy refused, target path conflict). Payload includes the rejected `FileSyncSessionSpec` (with secrets redacted), the engine-side cause, and remediation.
- `FileSyncDaemonUnreachableError` — for engines that require a long-running daemon (Mutagen). Payload includes the daemon socket path and the timeout.
- `FileSyncBinaryMissingError` — the engine's required binary is not present at the expected path. Payload includes the resolved path, the expected SHA-256, and a remediation pointing at `lando setup`.
- `FileSyncSourceOutsideRootError` — source path resolves outside the app root.
- `FileSyncCapabilityError` — a `MountPlan` requires a capability the engine does not declare (e.g., the spec asks for `mode: "one-way-replica"` and the engine declares only `two-way-*` modes).
- `FileSyncConflictError` — a conflict the engine cannot resolve under the requested `mode`. Surfaces the conflicted paths and the suggested `mode` upgrade.
- `FileSyncInternalError` — engine-internal failure that does not match any other tag.

#### 10.6.2 Reference engine: `@lando/file-sync-mutagen`

The bundled default for `bindMountPerformance: "slow"` is `@lando/file-sync-mutagen`, a Mutagen-backed engine. It is bundled per §1.4 and library consumers MAY opt into it through the standard bundled-discovery mechanism (§16.4). Mutagen was chosen because it is the only mature open-source engine that handles two-way bidirectional sync with conflict resolution, has a stable gRPC API designed for embedding, and has years of edge-case coverage on macOS/Windows file-system semantics. The integration is invisible to users; they never invoke `mutagen` directly and the spec does not introduce a `mutagen.yml` or any user-facing Mutagen surface.

**Architecture.** The plugin embeds a generated TypeScript Connect-RPC client (codegen entry in §17.2, "Mutagen gRPC client") for Mutagen's `Synchronization` service plus the small subset of `Daemon` and `Prompting` services needed for session management. The plugin spawns the Mutagen daemon as a Lando-owned subprocess and dials it over a Lando-owned Unix domain socket (Linux/macOS) or Windows named pipe (Windows). Lando's daemon runs in a Lando-owned data directory and is bit-for-bit isolated from any system Mutagen install the user may already have.

- **Binary placement.** Mutagen host CLI at `<userDataRoot>/bin/mutagen[.exe]`; agent binaries at `<userDataRoot>/bin/mutagen-agents/mutagen-agent-<platform>` (§12.4). Both are downloaded by `lando setup` from `https://github.com/mutagen-io/mutagen/releases/download/...` against checksums shipped in the plugin's compile-time `mutagen-versions.json` asset (§17.3 mechanism A).
- **Daemon lifetime.** `Layer.scoped` resource owned by the engine. Acquired lazily on the first `createSession` call within a process, finalized at process exit. The daemon is **process-scoped, not app-scoped**: a single Lando process drives N apps with N×M sessions through one daemon, matching how Mutagen is designed.
- **Daemon socket.** `<userDataRoot>/run/file-sync/daemon.sock` (POSIX, mode `0600`) or `\\.\pipe\lando-file-sync-daemon` (Windows). Pre-existing socket triggers `FileSyncDaemonUnreachableError` with remediation `lando doctor --fix` or `lando apps poweroff`.
- **Daemon data directory.** `<userDataRoot>/file-sync/mutagen-data/` — Mutagen's own state directory (sessions registry, Mutagen logs). Lando does not interpret these files; they are owned by the embedded Mutagen and are not part of the §13.5 cache catalog.
- **Wire protocol.** gRPC over the daemon socket. The client is generated at build time from vendored `.proto` files; runtime dependency on a system `protoc` or system gRPC implementation is forbidden (no `node-grpc`, no `@grpc/grpc-js` C++ addons; Connect-ES over Bun's HTTP/2 stack is used because it ships pure-JS and runs unmodified under `bun build --compile`).
- **Agent deployment.** Mutagen's standard `auto` agent-deployment path is used: when a session targets a service path, Mutagen copies the platform-appropriate `mutagen-agent-<linux>-<arch>` binary into the container via the provider's exec primitive and runs it on stdin/stdout. Lando wraps the deploy through `RuntimeProvider.run` with stdio piped into the gRPC stream so agent transport stays inside the standard Effect resource model.
- **Volume targets.** When the planner emits an accelerated `bind` (§6.4), the realization pair is (provider-managed `volume` named `lando-sync-<app-id>-<service>-<mountKeyHash>`) + (Mutagen session with target `service` mode mounted on that volume's container path). The volume is provider-owned for lifecycle; the sync session is engine-owned for content.

**Session creation flow** (illustrative; the canonical path lives in `core/plugins/file-sync-mutagen/src/engine.ts`):

```ts
yield* engine.createSession({
  app, service, mountKey,
  source: appRoot,
  target: { _tag: "service", service, path: "/app" },
  mode: "two-way-safe",
  excludes: ["node_modules", "vendor", ".cache"],
});
// → 1. lazy-spawn daemon if not running
// → 2. gRPC: Synchronization.Create{ alpha: file://<appRoot>, beta: docker://<container>:/app, ... }
// → 3. record FileSyncSessionRef in <userCacheRoot>/file-sync/sessions/<app-id>.bin (§12.1)
// → 4. fork a fiber that subscribes to Synchronization.List streaming and translates frames
//      into file-sync-progress / file-sync-conflict-detected events
// → 5. publish post-file-sync-create with the redacted spec
```

Required behaviors specific to the Mutagen engine:

- Mutagen version is pinned in `mutagen-versions.json`. Upgrades are a plugin release (not a runtime decision), and the §17.6 self-update flow reuses the same checksum-verification path it uses for the Lando binary itself. When the plugin is updated and the daemon protocol bumps, the next `lando setup` (or first `app:start` after the upgrade) terminates the prior daemon, replaces the binaries, and restarts; existing sessions are recreated against the new daemon transparently.
- The plugin MUST refuse to use a system `mutagen` binary on PATH. Conflicting installs are surfaced by `lando doctor` as a warning ("Mutagen detected at `/usr/local/bin/mutagen`; Lando uses its own copy at `<userDataRoot>/bin/mutagen` and ignores the system version") but do not block sync.
- The plugin MUST honor `network.proxy` and `network.ca` (§10.3.1) for both the binary download path and any registry call Mutagen makes for agent images. Proxy credentials are redacted from logs and the lifecycle event payloads identical to other Lando-owned network access.
- The plugin's `FileSyncEngineCapabilities` declaration at runtime is fixed: `modes: ["two-way-safe", "two-way-resolved", "one-way-safe", "one-way-replica"]`, `remoteAgentDeployment: "auto"`, `exclusionPatterns: true`, `conflictReporting: true`, `progressReporting: true`. The default `mode` for the planner-emitted `bind` realization is `two-way-safe` — Mutagen's safest mode that refuses ambiguous conflicts rather than auto-resolving them.

**v4.0 scope: sync only.** Mutagen also offers TCP/UDP forwarding sessions; these are explicitly out of scope for v4.0 (§14.1). Lando's `RuntimeProvider` host-port and `ProxyService` route stories already cover host-facing networking, and adding forwarding through Mutagen would create two paths for one user-facing concern. A future plugin MAY contribute a `PortForwardingService` abstraction reusing the same daemon; v4.0 does not.

#### 10.6.3 Doctor checks

`lando doctor` (§10.9) MUST include the following file-sync checks when the active provider declares `bindMountPerformance: "slow"`:

- `FileSyncEngineRegistry` reports the planned engine id (`mutagen` by default) and that engine's `isAvailable` returns `true`.
- The engine's required binaries are present at the expected paths and match the recorded SHA-256 fingerprints.
- For Mutagen specifically: the daemon socket is reachable, the daemon's gRPC `Daemon.Version` reports a compatible protocol version, and the cached session list (`<userCacheRoot>/file-sync/sessions/<app-id>.bin`, §12.1) round-trips through the encoder without corruption.
- `lando doctor --fix` runs `engine.setup()` to recover from missing-binary or stale-daemon states; transcripts of the run are captured per the §10.9 transcript policy.

When the active provider declares `bindMountPerformance: "native"`, the file-sync checks reduce to a single "no engine required" entry and skip availability probing.

#### 10.6.4 Replaceability

`FileSyncEngine` is a §4.2 pluggable abstraction. Plugins replace the default Layer to satisfy use cases the bundled Mutagen engine does not cover:

- **Air-gapped variant.** A plugin that pre-bundles Mutagen binaries into a custom Lando distribution and refuses any network-dependent setup.
- **Audited variant.** Every session create/pause/resume/terminate is appended to a tamper-evident append-only log; conflict events trigger explicit user prompts.
- **Alternate engine.** A plugin contributing Unison, `docker-sync`, or a future native macOS bind-acceleration path through the same `FileSyncEngine` contract. Engines compete via the standard §4.3 selection rules; the planner does not care which engine actually handles the session as long as the contract holds.
- **Recording variant.** A test-only engine that captures every session spec for assertions; never spawns a real daemon. The library API testing surface (§16.8) ships this as `TestFileSyncEngine` — used by the §13.1 file-sync engine contract suite.

Plugin implementations MUST pass the same contract suite as the default and MUST honor every event-publication and redaction requirement above; weakening the security or determinism posture of the default is forbidden and is checked by the contract suite.

### 10.7 SQL helpers

SQL helper behavior is plugin-provided.

**Required behaviors for database plugins:**

- Import and export commands are contributed as tooling commands or built-in plugin commands.
- Service info exposes database discovery metadata.
- Gzipped import/export is supported when the service type declares it.
- Replacement imports require explicit confirmation by default.

Core does not ship SQL helpers.

### 10.8 Setup and host integration

`lando setup` runs provider, CA, proxy, and shell-integration setup through plugin subscribers and direct service calls.

```text
lando setup [--yes] [--provider=<id>] [--skip-provider]
            [--skip-proxy] [--skip-install-ca]
            [--skip-shell-integration] [--skip-file-sync]
```

By default, `lando setup` installs the Lando-managed runtime without requiring any pre-existing Docker or Podman installation. Users who prefer a system runtime pass `--provider=docker` or `--provider=podman`; those providers assume the corresponding system installation already exists.

Rules:

- Provider plugins declare additional setup flags via the `setup.flags` manifest field.
- Platform-specific elevation runs through `PrivilegeService`.
- Linux commands that may prompt for sudo set `SUDO_ASKPASS` when an askpass helper is available.
- Setup honors corporate proxy and custom CA configuration for every Lando-owned download or registry call (§10.3.1).
- `lando shellenv` prints shell-profile snippets to add `<userDataRoot>/bin` to `PATH`.
- When the resolved provider declares `bindMountPerformance: "slow"` (§5.4), setup also runs the active `FileSyncEngine`'s `setup()` (§10.6) — by default this downloads the bundled Mutagen host CLI and the per-platform agent binaries to `<userDataRoot>/bin/` against the plugin's pinned checksums. `--skip-file-sync` defers the download to first accelerated `app:start` instead. When the resolved provider declares `bindMountPerformance: "native"`, the file-sync stage is a no-op regardless of whether `--skip-file-sync` was passed.

### 10.9 Logs and diagnostics

**Required behaviors:**

- Core logs live under `<userCacheRoot>/logs/`.
- App logs are discoverable by app id and app root.
- Service logs stream via `RuntimeProvider.logs`.
- Debug mode includes provider operation names and redacted command inputs.
- Users should never need provider-native commands for normal diagnosis.
- Effect's structured logger annotations propagate through provider operations so a single `traceId` follows the lifecycle.

`lando doctor` is the user-facing diagnostics command. It runs core checks for common app-config and selected-provider issues, then loads plugin-contributed checks declared as `provides.doctorChecks`. Each issue reports severity, context, and a solution. Solutions are either `automatic` tasks that doctor can run with `--fix`, or `manual` instructions when automation is unsafe or impossible.

Core doctor coverage MUST include:

- Landofile discovery and clear remediation when no app config is in scope.
- Detection of removed v3/v4-forbidden top-level wrapper keys such as `compose:`, `recipe:`, and `recipes:`.
- Selected Podman provider availability and machine readiness, with an automatic `podman machine start` remediation when applicable.
- Detection of a pre-§20 out-of-band proxy container left behind by an upgrade (`LegacyProxyContainerDetected`, §20.10.3) — read-only doctor diagnostic. The same condition is independently checked at `meta:setup` and at first `meta:global:start`, where it raises `LegacyProxyContainerConflictError` (§20.13) and refuses to start the global-app proxy service to prevent two proxies competing for the same ports; remediation is plugin-supplied via `meta:setup --migrate-proxy`.

Doctor checks are read-only by default. `--fix` runs only explicitly declared automatic solution commands and reports their stdout/stderr and exit code.

**Diagnostic transcripts.** Every shell-shaped check that `lando doctor` runs (probing PATH, testing connectivity, verifying file permissions, inspecting Podman/Docker state) goes through `ShellRunner` (§3.4) so each invocation is captured as a redacted, structured record. The renderer surfaces these records as a transcript whose lines are literal Bun Shell commands the user can copy-paste into their own terminal to reproduce. `--fix` invocations are recorded the same way, so a doctor session that auto-remediates produces a complete audit log of "what we ran, with which redacted values, and the exit code we got." Transcripts are written to `<userCacheRoot>/logs/doctor/<run-id>.transcript` alongside the structured run log; `lando doctor --transcript-only` skips the rendered diagnostic UI and prints the transcript directly to stdout for sharing in bug reports. Plugin-contributed checks that need shell access SHOULD register their commands through `ShellRunner` rather than calling `Bun.$` directly so their probes show up in the transcript with the same redaction and lifecycle-event treatment as core checks.

### 10.10 Host proxy

The **host proxy** is a per-app container→host RPC channel that lets tools running inside a Lando service call back to the host machine for two narrow purposes: opening a URL in the user's real browser (so `drush user:login`'s call to `xdg-open` actually pops up a tab), and re-entering Lando's command runtime on the host (so `lando drush` typed inside an interactive container shell still does the right thing). It is the inverse of the existing host→container exec path: where `RuntimeProvider.exec` runs host-initiated work inside a service, `HostProxyService` runs container-initiated work on the host, with the same redaction/lifecycle/auth discipline applied in reverse.

The host proxy is an opt-in service feature (`lando.host-proxy`, §6.11) attached to `type: lando` services; `l337` services do not receive it. It is **not** the deferred persistent agent (§14.2): its lifetime is bound to a single app's `app:start` / `app:stop` cycle, it holds no cross-app runtime state, and it dispatches only the typed messages enumerated in §10.10.2.

#### 10.10.1 Architecture

A small Bun-served HTTP/JSON dispatcher runs **on the host** for the duration of `app:start` … `app:stop`:

- **Socket placement.** The dispatcher binds a Unix domain socket at `<userDataRoot>/run/<app-id>/host-proxy.sock` with mode `0600`, owned by the invoking user. The path is added to the persistent-artifact list in §12.4. Cross-platform: Docker Desktop on macOS and Windows transparently bind-mounts the host's per-user socket into the Linux VM, so the same path is reachable inside containers; Linux native and Podman bind it directly.
- **Mount.** The `lando.host-proxy` feature bind-mounts the socket into every `type: lando` service in the app at `/run/lando/host-proxy.sock` with `:ro` and the same uid/gid mapping the rest of the service uses. Mounting is gated on the active provider's `hostReachability` capability (§5.4) being `native` or `emulated`; when capability is `none`, the feature is a no-op and shims fall back to a friendly stderr message.
- **Discovery.** The feature injects `LANDO_HOST_PROXY_SOCKET=/run/lando/host-proxy.sock` and `LANDO_HOST_PROXY_TOKEN=<random>` into every service. The token is regenerated at every `app:start` and never persisted to disk outside the app-plan cache's `secrets:` slot (which is itself redaction-aware). The tuple is the in-container analog of `$VSCODE_IPC_HOOK_CLI`.
- **Server lifetime.** The dispatcher is acquired in the `cli-app:start-run` post-phase as a `Layer.scoped` resource owned by `HostProxyService` (§3.4). Its scope is the app's started state; `cli-app:stop-init` triggers finalization, which closes the listener, deletes the socket file, and revokes the token. SIGINT propagates through `Effect.interrupt` exactly as it does for the proxy and CA scopes (§3.6).
- **Embedding-host reuse.** `HostProxyService` is built on the same `makeLandoRuntime`-style runtime reuse pattern as the rest of core (§16.3). The dispatcher holds **one** retained `LandoRuntime` for the duration of the app's started state and dispatches every inbound `runLando` request through `@lando/core/cli` (§16.7) against that retained runtime. This is what makes nested `runLando` calls fast — the second call through the proxy hits the warm hot-path budgets in §2.1, not cold-start.

#### 10.10.2 Wire protocol

The dispatcher speaks plain HTTP/1.1 on the Unix socket with `Content-Type: application/json` request bodies. Every request MUST carry `Authorization: Bearer <token>` matching the per-app `LANDO_HOST_PROXY_TOKEN`; missing or mismatched tokens are answered with HTTP 401 and an opaque body. The protocol is registered as a public schema in `@lando/sdk` (§7.8) and is part of the §13.1 host-proxy contract suite.

```ts
// Canonical request shapes registered in @lando/sdk
export const HostProxyRequest = Schema.Union(
  Schema.TaggedStruct("openUrl", {
    url:    Schema.String,                                    // validated against the scheme allowlist below
    target: Schema.optional(Schema.String),                   // optional host browser id for plugin-served impls
  }),
  Schema.TaggedStruct("openPath", {
    path: AbsolutePath,                                       // host-side path mapped from a container path by the caller
  }),
  Schema.TaggedStruct("runLando", {
    argv: Schema.Array(Schema.String),                        // canonical-id + args; subject to the §8.3 allowlist
    cwd:  AbsolutePath,                                       // host-side cwd; remapped from the container cwd
    tty:  Schema.Boolean,                                     // whether the caller has a TTY attached
    env:  Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  }),
  Schema.TaggedStruct("runBun", {                             // forwards `bun <argv>` to the host's BunSelfRunner (§3.4)
    argv: Schema.Array(Schema.String),                        // bun argv; subject to the verb allowlist below
    cwd:  AbsolutePath,                                       // host-side cwd; remapped from the container cwd
    tty:  Schema.Boolean,                                     // whether the caller has a TTY attached
    env:  Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  }),
  Schema.TaggedStruct("notify", {
    title: Schema.String,
    body:  Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("clipboardCopy", {
    text: Schema.String,
  }),
);
export type HostProxyRequest = Schema.Schema.Type<typeof HostProxyRequest>;

export const HostProxyResponse = Schema.Union(
  Schema.TaggedStruct("ok",    { data: Schema.optional(Schema.Unknown) }),
  Schema.TaggedStruct("error", { code: HostProxyErrorCode, message: Schema.String, remediation: Schema.optional(Schema.String) }),
);
```

`runLando` responses are delivered as NDJSON frames over the socket so the in-container shim can stream stdout/stderr in real time and exit with the host command's exit code. Each frame is one of `{ kind: "stdout", chunk }`, `{ kind: "stderr", chunk }`, `{ kind: "exit", code }`, or `{ kind: "error", … }`.

**Allowed URL schemes for `openUrl`** (out-of-the-box):

- `http`, `https`, `mailto`, `tel`
- Editor schemes: `vscode`, `vscode-insiders`, `cursor`, `phpstorm`, `idea`, `webstorm`, `goland`, `pycharm`, `rubymine`, `clion`, `fleet`, `zed`

Every other scheme is rejected with `HostProxyOpenUrlSchemeError`. `file://` is **always** rejected because the path's meaning differs between container and host. Plugins may extend the allowlist via the `HostProxyService` Layer; users may extend it through global config (`hostProxy.allowedSchemes:`).

**`runLando` allowlist.** The dispatcher consults the `host-proxy-allowlist` cache (§12.1), which is generated from every `LandoCommandSpec` with `hostProxyAllowed: true` (§8.3), every plugin command with the same flag, and every tooling task with `hostProxyAllowed: true` (§8.5). Requests for canonical ids outside the allowlist are rejected with `HostProxyCommandNotAllowedError`. Lifecycle commands (`app:start`, `app:stop`, `app:restart`, `app:rebuild`, `app:destroy`, `apps:poweroff`) MUST NOT be on the allowlist; the spec rejects any plugin or tooling task that attempts to add them with `HostProxyAllowlistConflictError` at registration. `meta:bun` and `meta:x` (§8.2.4) MUST NOT be on the allowlist either: a container that needs Bun should declare a container-side Bun primitive (e.g., `lando.bun-self` service feature) rather than round-tripping through the host's package manager, which would write to the host user's `~/.bun` cache and registry auth.

**`runBun` verb allowlist.** `runBun` requests dispatch through `BunSelfRunner.run(argv, { cwd, env, mode: "embedded" })` on the host. The dispatcher consults a separate **`host-proxy-bun-verb-allowlist`** (a static list embedded in the binary, NOT plugin-extensible in v4.0). The default allowlist is **`audit`**, **`outdated`**, **`pm`**, **`info`**, and **`why`** — the read-only diagnostic verbs. Mutating verbs (`install`, `add`, `remove`, `update`, `link`, `unlink`, `publish`, `create`, `init`, `run`, `x`, `build`, `test`) are rejected with `HostProxyBunVerbNotAllowedError`. Rationale: a `runBun` call is a *container asking the host to do something*; only verbs that are read-only relative to the host's package state, registry auth, and home directory are safe by default. A container that needs a mutating Bun verb should declare a container-side Bun primitive instead. Plugin-replaceable `BunSelfRunner` Layers (§4.2) reach `runBun` through the same allowlist, so an audited or sandboxed plugin still respects this fence.

**Recursion guard.** Every dispatched `runLando` invocation increments `LANDO_HOST_PROXY_DEPTH` in the env passed into the host re-entry. If the inbound request already carries `LANDO_HOST_PROXY_DEPTH >= 3`, the dispatcher refuses with `HostProxyRecursionLimitError`. This bounds runaway loops in a misbehaving container without preventing legitimate two-hop scenarios.

**Concurrency cap.** The dispatcher caps in-flight requests at 16 per app (configurable via global `hostProxy.maxConcurrent:`); excess requests get HTTP 429 with `HostProxyBackpressureError`. This stops a runaway container from DoS-ing the host runtime.

#### 10.10.3 In-container shim

The `lando.host-proxy` feature ships **one** Bun-compiled static binary at `/usr/local/lib/lando/host-proxy-client` inside `type: lando` services and symlinks it as:

- `/usr/local/bin/xdg-open`
- `/usr/local/bin/open`
- `/usr/local/bin/lando`
- `/usr/local/bin/bun` *(only when no other `bun` is already at this or a higher-priority PATH location; opt-in per-service via the `lando.host-proxy.bun: true` feature option)*

The binary dispatches on `argv[0]` (host-spawn pattern):

| `argv[0]` | Wire request | Notes |
|---|---|---|
| `xdg-open` / `open` | `{ "_tag": "openUrl", url: argv[1] }` | The shim refuses extra arguments to keep `xdg-open <single-url>` semantics intact. Multiple URLs require multiple invocations. |
| `lando` | `{ "_tag": "runLando", argv: argv.slice(1), cwd: process.cwd(), tty: isatty(0), env: <filtered> }` | `cwd` is the container path; the host dispatcher remaps it to the host app root using the active `AppMountInfo` (§6.4). The shim filters env to a small allowlist (`LANDO_*`, `LC_*`, `LANG`, `TERM`) before forwarding so container-leaked env never poisons the host program. |
| `bun` | `{ "_tag": "runBun", argv: argv.slice(1), cwd: process.cwd(), tty: isatty(0), env: <filtered> }` | Forwards to host `BunSelfRunner` subject to the `runBun` verb allowlist above. Only enabled when the service's `lando.host-proxy.bun: true` option is set; the symlink is NOT installed otherwise. The shim refuses to forward when an inbound `BUN_BE_BUN` env var is present (which would create a recursion path through the host). For containers that legitimately need full mutating Bun verbs (install, build, run), the `lando.bun-self` service feature is the right primitive — see §6.11. |

The shim is intentionally tiny: no Effect runtime, no plugin loading, no schema validation beyond reading `LANDO_HOST_PROXY_SOCKET` / `LANDO_HOST_PROXY_TOKEN`, opening the socket, writing one HTTP request, and reading the response or NDJSON stream. Cold-start budget for the shim itself is < 20 ms; the user-visible latency floor is dominated by host-side dispatch.

If `LANDO_HOST_PROXY_SOCKET` is unset (the user is in a service without the feature enabled, or running detached via raw `docker exec`), the shim prints a deterministic fallback message to stderr explaining the situation and exits non-zero. For `xdg-open` the message includes the URL the caller passed so the user can copy-paste it; for `lando` the message points to the canonical-id form on the host.

**Shim distribution.** The binary is built by the §17.1 release pipeline as part of the `@lando/service-lando` artifact, signed alongside the main `lando` binary (§17.4), and embedded into the base image build via `Bun.embeddedFiles` (§17.3). It is **not** the same binary as the host `lando`: it is a wire-protocol client only, and the spec forbids the host `lando` binary from being used as the in-container shim because architecture mismatch (host `darwin/arm64` vs container `linux/amd64`) would otherwise hide.

#### 10.10.4 Required behaviors

- The default `HostProxyServiceLive` MUST construct lazily via `Layer.suspend` (§3.4); `app:start` for an app whose plan does not include the `lando.host-proxy` feature MUST NOT bind a socket, allocate a token, or spawn the dispatcher.
- The dispatcher MUST publish `pre-host-proxy-call` and `post-host-proxy-call` lifecycle events for every request, including rejected ones, with the redacted payload shape from §11.2. Subscribers MUST observe redacted forms only; the active `Logger` at debug level MAY observe full URLs and argv tails subject to `${secret:…}` redaction (§3.4).
- Token generation MUST use a CSPRNG (`crypto.randomBytes(32)`-equivalent in Bun); tokens MUST be at least 256 bits.
- Socket file creation MUST be atomic (create with `O_CREAT | O_EXCL`) and MUST set mode `0600` before any client can connect. A pre-existing socket at the path triggers `HostProxySocketStaleError` with remediation pointing at `app:cache:refresh` or `apps:poweroff` followed by `app:start`.
- Cancellation propagates: `Effect.interrupt` of the dispatcher fiber MUST close the listener, finalize all in-flight request fibers, and unlink the socket file, in that order, within 1 second.
- Capability gating: when the active provider declares `hostReachability: "none"`, `lando.host-proxy` MUST plan as a no-op feature with a deprecation-style notice in `lando info`; the feature MUST NOT silently fail at runtime by mounting an unreachable socket.
- The host-proxy contract test suite (§13.1) is mandatory and exercises every message type, the allowlist enforcement, the recursion guard, the concurrency cap, the URL scheme allowlist, the token mismatch path, and the cancellation contract.
- `lando doctor` MUST include a host-proxy check: socket present, mode `0600`, dispatcher reachable, token round-trip works, allowlist cache fresh.

#### 10.10.5 Replaceability

`HostProxyService` is a §4.2 pluggable abstraction. Plugins replace the default Layer to satisfy use cases the bundled implementation deliberately does not cover:

- **Headless CI.** Swallow `openUrl` (log instead of opening a browser); `runLando` proceeds normally.
- **Audited builds.** Every dispatch is appended to a tamper-evident append-only log; `notify`/`clipboardCopy` are rejected.
- **Remote host transports.** Dispatch over a different transport (e.g., a teams-mode build that posts URLs to Slack instead of opening them locally).
- **Recording/test runs.** Capture every request for assertions; never call out to the real host.

Plugin implementations MUST pass the same contract suite as the default and MUST honor the allowlist cache; weakening the security posture of the default (e.g., disabling token auth) is forbidden and is checked by the contract suite.

---
