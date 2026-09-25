# Lando v4 — Subsystems

> **Part 11 of 18** · [Index](./README.md)
> **Read next:** [12 Caches and Persistence](./12-caches-and-persistence.md)

This part defines the provider-neutral subsystem contracts between the core runtime and plugins.

---

## 10. Subsystems

Each subsystem exposes a focused Effect service or fixed core primitive. Remote egress uses `HttpClient` and `Downloader`; local, volume, service, and artifact byte movement uses `DataMover`.

### 10.1 Networking

Core defines network intent; `RuntimeProvider` realizes it.

- Services resolve peers by service name when app networking is supported. Cross-app names use `<service>.<app>.internal` only when `sharedCrossAppNetwork` is supported.
- `host.lando.internal` resolves to the host gateway when `hostReachability` is `native` or `emulated`; `LANDO_HOST_IP` contains that resolvable name.
- Providers without shared networking MUST report `sharedCrossAppNetwork: false`; dependent features fail with actionable errors.
- Host endpoints bind to `127.0.0.1` by default; `bindAddress` is the opt-in LAN exposure surface.
- Core has no shared-bridge abstraction. Provider-created networks, including Docker's `lando_bridge_network`, are implementation details.

### 10.2 Router and routes

User surfaces say **router** and **routes**. Service `routes:` is preferred; top-level `proxy:` is a compatibility alias for route maps only. `HostProxyService` and `network.proxy` remain distinct bounded contexts. Internals use `RouterService`, `routerServices:`, `RoutePlan`, and `RouteFilter`; `@lando/proxy-traefik` contributes router id `traefik`.

`RouterService` exposes identity, `ProxyCapabilities`, setup from `ProxyConfig`, route apply/remove returning `ProxyApplyResult`, durable `ProxyStatus`, and stop; failures use `ProxyError`. Core owns `RoutePlan`; plugins own realization.

- The default local domain is configurable and defaults to `lndo.site`.
- `RoutePlan` supports hostnames, wildcard hostnames, ports, paths, TLS intent, and filters. Route status appears in `lando info` and post-start output.
- The global `domain` config supports offline and custom-domain workflows.
- Router plugins reconcile stale routes on rebuild and destroy. `stop` durably removes all app route definitions without stopping unrelated global services; `status` reports that durable state.
- `RouteFilter` contributions translate provider-neutral filters. Bundled filters are `stripPrefix`, `addPrefix`, `requestHeader`, `responseHeader`, `redirect`, `rewritePath`, `auth.basic`, and `rateLimit` (§6.6). Filters merge by `name`, then unnamed type identity, and retain authored order. Path routes MUST NOT strip implicitly.
- `router.enabled: false`, resolved by normal precedence (§7.4, §7.5), MUST prevent router startup and publication for the app. `lando info` reports only published endpoints.

#### 10.2.1 Default global-app realization

`RouterServiceTraefikGlobalAppLive` from `@lando/proxy-traefik` realizes routing through the global app's `traefik` service (§20). The plugin MUST contribute paired `routerServices:` and `globalServices:` entries; otherwise plugin loading fails with `ProxyContributionPairError`.

- `applyRoutes` persists plugin-owned dynamic configuration in a Lando-managed mount; `setup` calls `GlobalAppService.ensureRunning(["traefik"])`.
- Alternative `RouterService` plugins MAY avoid `GlobalAppService`; selection follows §4.3.
- A legacy out-of-band Traefik container produces `LegacyProxyContainerDetected`; migration is plugin-supplied (§20.10.3).

#### 10.2.2 Public tunnels and app sharing (`TunnelService`)

Core owns `TunnelService`, `TunnelTarget`, `TunnelStartRequest`, `TunnelStopRequest`, `TunnelStatusRequest`, `TunnelSessionFilter`, `TunnelSession`, `TunnelStatus`, tagged errors, CLI/API shape, detached-state rules, and the contract suite. Plugins own provider realization through `tunnelServices:` (§9.5).

`TunnelTarget` identifies a `RoutePlan`, a service endpoint, or a core-derived loopback URL. Plugins MUST NOT expose arbitrary host ports by default; raw host-port forwarding requires an advanced option and is rejected by canonical `lando share` UX.

- Selection precedence is explicit command/API provider, Landofile or global default, then sole installed implementation (§4.3). Missing implementations fail with installation remediation.
- Control-plane egress MUST use `HttpClient`; connector tools MUST use pinned `ToolManifest` entries through tool provisioning and `Downloader`; connector processes MUST use scoped `ProcessRunner` execution.
- Foreground sessions close on interrupt. Detached sessions persist until `app:share:stop`, app destroy, or GC.
- Detached state lives in `<userCacheRoot>/tunnels/registry.bin` and process metadata in `<userDataRoot>/run/tunnels/`; status, list, and GC reconcile stale state safely.
- Readiness uses `runProbe`; plugins MUST NOT hand-roll retry loops.
- URLs, auth material, connector environment, and host paths MUST be redacted before logs, events, machine output, telemetry, support bundles, or durable state. Protected debug logging is the only exception.
- Events are `pre-tunnel-start`, `post-tunnel-start`, `tunnel-ready`, `pre-tunnel-stop`, `post-tunnel-stop`, and `tunnel-status`.
- `lando share --format json` and `app.share()` return universal session schemas (§8.11); foreground streams use `StreamFrame` and end with a result frame.
- `TunnelService` is not byte movement; it composes `HttpClient`, tool provisioning, `Downloader`, `ProcessRunner`, `StateStore`, `runProbe`, `InteractionService`, and `RedactionService`.

Tagged errors are `TunnelProviderUnavailableError`, `TunnelTargetUnresolvedError`, `TunnelAuthRequiredError`, `TunnelStartError`, `TunnelReadyTimeoutError`, `TunnelDetachedStateError`, and `TunnelStopError`.

#### 10.2.3 Host-port acquisition

The default router publishes one host-global HTTP/HTTPS pair on `127.0.0.1`; URLs omit ports `80` and `443`. Ports come from fixed ordered per-protocol candidate lists, with first successful TCP bind winning; HTTP reachability MUST NOT determine availability.

- The HTTP order is `80`, `8080`, `8000`, `8888`, `8008`, `38080`; HTTPS is `443`, `8443`, `4443`, `4433`, `4444`, `444`, `38443`.
- Global and Landofile `router:` support `enabled`, `bindAddress`, `httpPort`, `httpsPort`, `httpFallbacks`, and `httpsFallbacks`; env keys are `LANDO_ROUTER_HTTP_PORT`, `LANDO_ROUTER_HTTPS_PORT`, `LANDO_ROUTER_BIND_ADDRESS`, plus JSON-document fallback setters.
- `httpPort` and `httpsPort` replace preferred candidates; fallback arrays replace remaining candidates; an empty fallback list means preferred-only.
- Precedence is compiled defaults, global `router:`, env, then Landofile `router:`. `pluginConfig."@lando/proxy-traefik"` MUST NOT duplicate this surface.
- An already-running router's persisted pair wins. An app-specific mismatch fails with a tagged error and remediation to align config or run `lando global:restart`.
- The chosen pair is the only Traefik host publish. It is persisted and reused while config and ownership still match; changed preference, missing router, or foreign ownership causes rescan.
- Privileged-port `EACCES` MAY use the socket helper and then the same ordered high-port candidates. A healthy peer Lando router MUST NOT be treated as stale `rootlessport`.
- Exhaustion fails closed with the attempted ports; silent disablement is forbidden.
- Fallback selection MUST notify at acquisition, naming occupied preferred ports, chosen ports, identifiable holders, and `lando global:restart` remediation.
- `lando doctor` MUST warn, not fail, for non-Lando holders of preferred ports and offer holder-specific remediation for DDEV, Lando 3, Docksal, Apache, nginx, Caddy, IIS/`http.sys`, or unknown processes. `LegacyProxyContainerDetected` remains the sole legacy-proxy owner.
- Doctor and `EADDRINUSE` remapping MUST use persisted chosen ports.

### 10.3 Certificates and CA

`CertificateAuthority` exposes identity, `CaCapabilities`, scoped `RootCaInfo` acquisition, host trust installation, `LeafCertRequest` to `LeafCertInfo` issuance, and `LeafCertId` revocation; failures use `CaError`. Core owns certificate intent; plugins own issuance and trust installation.

- `lando setup` can create and trust a development CA.
- Leaf SANs include service id, canonical internal alias, configured and routed hostnames, `localhost`, and `127.0.0.1`.
- Services receive `LANDO_SERVICE_CERT` and `LANDO_SERVICE_KEY`.
- Landofile `security.ca:` and global `network.ca` are supported through `lando.security` (§6.8); platform elevation uses `PrivilegeService`.
- Container trust injection does not require host elevation. `CertificateAuthority.installToTrustStore` separately trusts Lando's development CA on the workstation.

#### 10.3.1 Corporate proxies and outbound trust

All Lando-owned egress MUST work behind corporate HTTP(S) proxies and custom CA chains, including runtime, plugin, include, recipe, update, telemetry, helper, tunnel, scanner, MCP, and provider-initiated artifact traffic. In-service trust inheritance is owned by §6.8.

- The canonical network-trust resolver is a pure `@lando/sdk` module consumed by `HttpClient`, providers, `lando setup`, and `BunSelfRunner`. `BunSelfRunner` is the only package-manager exception to the `HttpClient` path.
- Explicit global `network.proxy` precedes `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`.
- Global `network.ca.certs` and `LANDO_NETWORK_CA_CERTS` add CAs; `network.ca.trustHost: true` uses supported host trust stores.
- `network.ca.injectIntoServices` defaults to `true`; `network.proxy.injectIntoServices` defaults to `false`. They are independent and may be overridden per service (§6.8).
- Setup MUST validate trust before long downloads and provide remediation for interception, authentication, missing CA, and blocked registries. It SHOULD report active CA injection for `type: lando` services.
- Providers receive resolved trust independently of service-injection flags. Project `security.ca:` is additive and MUST NOT replace machine-local `network.ca`.
- Host-global arbitrary Dockerfile/build-context injection is a non-goal.
- Proxy credentials MUST be redacted from logs, telemetry, diagnostics, lockfiles, and cache metadata.
- Offline-capable commands MUST use valid local state without contacting unavailable trust endpoints (§12.6).

#### 10.3.2 Outbound HTTP (`HttpClient`)

`HttpClient` is the sole Lando-owned request/response egress port. It exposes `HttpClientCapabilities`, buffered `request`, streaming `stream`, and streaming or buffered `upload` over `HttpRequest`, `HttpResponse`, `HttpStreamResponse`, `HttpUploadRequest`, and `HttpError`. Direct `fetch` and plugin-local trust wiring are forbidden; `BunSelfRunner` remains the package-manager exception.

- Trust resolution follows §10.3.1 unless a caller supplies an already-resolved override.
- `stream` MUST expose a byte stream and MUST NOT buffer the full body; `request` buffers only by caller choice.
- Credentials, URL userinfo, tokens, signed query parameters, and supplied redaction tokens MUST be redacted everywhere except protected active debug logging.
- Calls publish `pre-http-call` and `post-http-call`; downloader-originated calls retain download correlation and MUST NOT be double-counted.
- Interrupt closes connections and scope finalization reaps transfers.
- Offline-only requests fail before opening a connection. Construction of `HttpClientLive` is inert.
- Retry belongs to `runProbe`; artifact verification belongs to `Downloader`.
- Plugin implementations MUST pass the contract suite and MUST NOT weaken trust, redaction, scheme policy, or cancellation.

Tagged errors are `HttpRequestError`, `HttpUploadError`, `HttpTrustError`, and `HttpClientUnavailableError`.

#### 10.3.3 Verified downloads (`Downloader`)

`Downloader` consumes `HttpClient` and owns `DownloaderCapabilities`, `DownloadRequest`, `DownloadResult`, `DownloadError`, `ArtifactManifestEntry`, verification, atomic persistence, cache/offline behavior, and progress. All Lando-owned artifact downloads MUST use it.

- Production manifests MUST use HTTPS. `file://` requires explicit `allowFileSource` and is limited to documented development/CI overrides such as `LANDO_RUNTIME_BUNDLE_MANIFEST` (§5.8.1).
- Egress MUST use `HttpClient.stream`; downloader implementations MUST NOT open sockets or duplicate trust resolution.
- File downloads stream through SHA-256 verification to atomic persistence; interruption or failure removes temporary state. Memory buffering occurs only when explicitly requested.
- A matching destination is a cache hit with no network. Offline cache misses fail before connection.
- Destination paths MUST remain contained.
- Events are `pre-download`, `download-progress`, and `post-download`, with credentials and tokens redacted.
- Executable and provider/helper artifacts MUST supply SHA-256. No skip-verification flag exists. Signature verification remains separate (§17.6).
- Plugin implementations MAY add mirrors or caches but MUST preserve scheme, verification, atomicity, offline, redaction, and cancellation contracts.

Tagged errors are `DownloadFetchError`, `DownloadChecksumError`, `DownloadSizeMismatchError`, `DownloadPersistError`, `DownloadOfflineError`, `DownloadSourceForbiddenError`, and `DownloaderUnavailableError`.

#### 10.3.4 Tool provisioning

The fixed `@lando/sdk` tool-provisioning helper installs pinned host executables through `Downloader` and `FileSystem`; it is not a service tag or pluggable abstraction. `ToolManifest` and `ToolArtifactEntry` name the tool version, per-host artifact, URL, checksum, optional size/archive/member, contained install name, and optional mode.

- Unsupported hosts fail with `ToolManifestError`.
- Downloads MUST use `Downloader`; extraction is bounded and atomic; install paths remain under `<userDataRoot>/bin/` or fail with `ToolInstallPathError`.
- Version markers and binary fingerprints make warm reruns offline, idempotent no-ops.
- Extraction failures use `ToolExtractError`.
- Embedded manifests follow §17.3; caches live at `<userCacheRoot>/tool-downloads/<toolId>/`; binaries and markers live under `<userDataRoot>/bin/`.

### 10.4 SSH and host identity

- Host and managed SSH keys are forwarded or copied by provider capability. `keys: false` disables loading; a string array allowlists keys.
- Passphrase-protected keys use an active agent when available.
- Known host identity is injected as `LANDO_HOST_USER`, `LANDO_HOST_UID`, `LANDO_HOST_GID`, and `LANDO_HOST_HOME`; platform/provider limitations MUST be explicit.
- The `lando.ssh-agent` feature (priority 1200, §6.11.4) applies to every `type: lando` service in both modes and sets `SSH_AUTH_SOCK=/run/lando/ssh-agent/agent.sock`. There is no per-service `sshAgent` key.
- `sshAgent` is an object `{ sidecar?: boolean, socket?: string }` accepted at the Landofile top level and in global config (§7.5). Each field resolves Landofile, then global config, then default. The default is `sidecar: true`: the Lando-managed `ssh-agent` global service (§20.4) runs `ssh-agent` and loads `~/.ssh` keys through `ssh-add`; the managed provider hosts it even when the app uses another provider.
- `sshAgent.sidecar: false` selects host mode: the app forwards a host agent instead of the sidecar, so hardware-backed and third-party agents (1Password, gpg-agent, yubikey-agent, FIDO2 `sk` keys) sign inside the host process. The upstream is discovered at start in this order: explicit `sshAgent.socket`, `SSH_AUTH_SOCK`, the 1Password agent path for the platform (`~/.1password/agent.sock` on Linux, `~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock` on macOS), `gpgconf --list-dirs agent-ssh-socket`, `$XDG_RUNTIME_DIR/yubikey-agent/yubikey-agent.sock`, then the Windows named pipe `\\.\pipe\openssh-ssh-agent`. Discovery ends at the first candidate that accepts a connection.
- Delivery is one contract in both modes: a per-app relay owns a stable app-scoped directory that the provider makes visible to the service (§5.4 `agentSocket`, §5.3 `openAgentSocketBridge`), and the container sees `/run/lando/ssh-agent/agent.sock`. The relay is a raw byte stream between the container socket and the upstream (host agent or sidecar socket); it is never the host socket bound directly into a service. Replacing the relay socket MUST NOT recreate the container, because the mount is the directory, not the socket.
- The planner records only the eligible services and the selected mode (plan extension `@lando/core/ssh-agent`, `{ mode: "sidecar" | "host" }`). The upstream path, relay directory, and `SSH_AUTH_SOCK` mount are a start-time overlay applied by the start, restart, and rebuild operations, like the §10.10 host-proxy overlay, and MUST NOT enter the plan cache. The relay, guest bridge, and socket directory are Scope-owned: retained after a successful apply, closed on stop, destroy, or replacement, and reaped on interrupt.
- Capability is validated after provider selection and before planning; upstream and bridge readiness are validated before provider apply. Failures are never silent: a provider that does not declare `agentSocket` fails `lando start` with `SshAgentUnavailableError` (`reason: "capability-missing"`) naming the provider and the alternatives. Other `SshAgentUnavailableError` reasons are `host-agent-not-found` (no upstream discovered), `socket-missing` (explicit `sshAgent.socket` absent or refusing connections), `sidecar-not-running`, and `bridge-failed`. Relay, worker, and bridge faults after readiness are `SshAgentTransportError` with `stage: "broker" | "worker" | "bridge"`. Both carry remediation.
- `lando doctor` reports the selected mode, upstream availability, bridge readiness, and the security implication: in host mode every opted-in service can request signatures from the host agent for as long as the app runs. It MUST NOT print agent contents, key material, or socket tokens, and MUST NOT claim a hardware key has been moved into the container.
- Alternate feature implementations MAY ship but MUST use the same delivery contract and MUST declare security posture for `lando doctor`.

#### 10.4.1 gpg-agent forwarding

- `gpgAgent` is an object `{ forward?: boolean, socket?: string }` with the same Landofile, global config, then default precedence. The default is `forward: false`; there is no gpg sidecar.
- `gpgAgent.forward: true` enables the `lando.gpg-agent` feature (priority 1210, §6.11.4) for `type: lando` services. The upstream is the explicit `gpgAgent.socket`, otherwise `gpgconf --list-dirs agent-extra-socket` (the restricted remote socket, never `agent-socket`). Discovery requires host `gpg` and `gpgconf`; their absence is `GpgAgentUnavailableError` (`reason: "gpg-missing"`).
- Delivery reuses the §10.4 relay and provider bridge contract with `kind: "gpg"`: the container sees `/run/lando/gpg-agent/S.gpg-agent` and the feature sets `GNUPGHOME=/run/lando/gpg-agent`. The feature exports the host public keyring and trust database into that directory at start so `git commit -S` and `gpg --sign` resolve keys locally and sign through the relay; private keys never leave the host.
- `GpgAgentUnavailableError` reasons are `host-agent-not-found`, `socket-missing`, `capability-missing`, `bridge-failed`, and `gpg-missing`; runtime faults are `GpgAgentTransportError` with the same `stage` values as SSH. Both carry remediation, and doctor reports the gpg relay alongside the SSH relay under the same posture rules.

### 10.5 Healthchecks and scanner

`HealthcheckRunner`, `UrlScanner`, `DoctorService`, downloader retry, and setup readiness use the shared probe primitive.

#### 10.5.1 Probe primitive (`@lando/sdk/probe`)

`RetryPolicy`, `ProbeSpec`, `ProbeOutcome`, `ProbeResult`, `runProbe`, and `toSchedule` form a pure, non-pluggable SDK contract.

- `runProbe` MUST be deterministic under Effect `TestClock`, stop on `green`, retry `yellow` and `red` by policy, and return the final `ProbeResult` when bounded attempts or deadline are exhausted. Consumers decide whether non-green is fatal.
- The primitive performs no IO, logging, or redaction. Consumers MUST redact `ProbeResult.lastError` through `RedactionService` before events, transcripts, or info output.
- `ProbeError` and `ProbeTimeoutError` are exported from `@lando/sdk/probe`, not the frozen errors barrel.
- Core MUST NOT introduce separate provider- or host-probe retry loops.

Healthchecks accept disabled, string, string-array, and object forms, including computed `load()` values (§7.3). Object fields are `command`, `user`, `retry`, `delay`, `timeout`, and `target`.

- Startup distinguishes running from ready; `ready` fires only after all healthchecks pass.
- The default `HealthcheckRunner` uses `RuntimeProvider.exec` plus `runProbe`.
- `target` is `service` by default or `host`. Host targets use `ShellRunner`; native plugin runners MAY bypass shell. Unsupported targets fail at planning with `HealthcheckTargetUnsupportedError`.

`UrlScanner` rules:

- Published URLs MUST be probed after start through bounded `runProbe` execution.
- Global and service config accept `scanner: false | { path?, okCodes?, retries?, timeout? }`; omitted values use finite defaults.
- Results are green/yellow/red. Non-green MUST warn and MUST NOT fail start. All details MUST be redacted.
- The default scanner uses `HttpClient`; plugin scanners MAY use `ShellRunner` while preserving verdict and bound semantics.

### 10.6 Files and performance

- Providers expose app root, user home, and config root when supported. `MountPlan` remains provider-neutral; excludes/includes belong to each mount.
- Heavy directories may be excluded from live sync. Windows/WSL handling is provider setup and documentation, not core logic.
- Bind realization is `passthrough` or `accelerated`, derived from `bindMountPerformance` (§5.4, §6.4), without changing the Landofile.
- `FileSyncEngine` is the pluggable accelerated path. `passthrough` is the no-op default; `@lando/file-sync-mutagen` is bundled for slow-IO providers.

#### 10.6.1 `FileSyncEngine` contract

`FileSyncEngine` exposes identity, capabilities, availability/setup through `FileSyncSetupOptions`, scoped session create/pause/resume/terminate, filtered session listing, and event streaming; failures use `FileSyncError`. `FileSyncEngineCapabilities`, `FileSyncSessionSpec`, `FileSyncSessionRef`, `FileSyncSessionFilter`, `FileSyncSessionInfo`, and `FileSyncEventChunk` are public contracts. One session exists per accelerated `MountPlan` per started app.

- Setup MUST be idempotent; external tools install under `<userDataRoot>/bin/` through verified provisioning. First accelerated start MAY auto-acquire an unavailable engine.
- Sessions MUST be scope-acquired and finalized on app stop or interrupt.
- Lifecycle events are `pre-file-sync-create`, `post-file-sync-create`, `pre-file-sync-pause`, `post-file-sync-pause`, `pre-file-sync-resume`, `post-file-sync-resume`, `pre-file-sync-terminate`, `post-file-sync-terminate`, `file-sync-conflict-detected`, and `file-sync-progress`; progress covers at least `initial-scan`, `staging`, `transitioning`, and `watching`.
- Home paths MUST render as `${HOME}/…` outside protected debug logs.
- Network activity MUST honor §10.3.1. Sources outside the app root require `--allow-load-outside-root` or fail with `FileSyncSourceOutsideRootError`.
- Engines MUST use provider ports rather than provider-native APIs and MUST preserve offline pause/resume once tools are cached.

Tagged errors are `FileSyncEngineUnavailableError`, `FileSyncSessionFailedError`, `FileSyncDaemonUnreachableError`, `FileSyncBinaryMissingError`, `FileSyncSourceOutsideRootError`, `FileSyncCapabilityError`, `FileSyncConflictError`, and `FileSyncInternalError`.

#### 10.6.2 Reference engine: `@lando/file-sync-mutagen`

The bundled engine is invisible to Landofiles and uses a Lando-owned Mutagen daemon and generated client, isolated from system Mutagen.

- Host CLI is `<userDataRoot>/bin/mutagen[.exe]`; agents are under `<userDataRoot>/bin/mutagen-agents/`; the daemon endpoint is `<userDataRoot>/run/file-sync/daemon.sock` or `\\.\pipe\lando-file-sync-daemon`; daemon data is `<userDataRoot>/file-sync/mutagen-data/`.
- Session state is cached at `<userCacheRoot>/file-sync/sessions/<app-id>.bin`. A pinned `mutagen-versions.json` conforming to `ToolManifest` provisions host and agent binaries through `Downloader`. The plugin MUST NOT use a system `mutagen` on `PATH`; doctor reports conflicts without blocking sync.
- The daemon is process-scoped and lazy; sessions are engine-owned while target volumes remain provider-owned.
- Agent deployment uses provider execution ports. Runtime dependency on system code generators or native gRPC addons is forbidden.
- Upgrades replace incompatible pinned tools and recreate sessions. Proxy/CA policy and redaction remain mandatory.
- Capabilities include all four sync modes, automatic agent deployment, exclusions, conflicts, and progress; default mode is `two-way-safe`.
- Port forwarding is out of scope for v4.0.

#### 10.6.3 Doctor checks and replaceability

On slow providers, `lando doctor` MUST verify selected engine availability, binary fingerprints, daemon compatibility, and cached-session decodability; `--fix` runs `setup` with transcript capture. Native providers report that no engine is required.

Alternative air-gapped, audited, recording, or different-engine plugins MAY replace the default by §4.3. They MUST pass the contract suite and MUST NOT weaken event, redaction, security, or determinism requirements. `TestFileSyncEngine` is the testing implementation.

### 10.7 SQL helpers

SQL helpers are plugin-only. Core ships none; bundled `@lando/sql` is the reference implementation.

- Database plugins expose discovery metadata and contribute import/export commands; gzip is supported when declared; replacement imports require confirmation by default.
- `@lando/sql` contributes `db:import`, `db:export`, `db:snapshot`, `db:restore`, and `db:reset` for supported credential-bearing databases. It MUST use `DataMover`, provider data-plane ports, renderer progress, machine output, `RedactionService`, and unambiguous service selection.

### 10.8 Setup and host integration

`lando setup` supports `--yes`, `--provider`, `--skip-provider`, `--no-interactive`, `--skip-proxy`, `--skip-install-ca`, `--skip-shell-integration`, and `--skip-file-sync`. The default installs the managed runtime; `docker` and `podman` select existing system runtimes.

- Plugins add setup flags through `setup.flags`; elevation uses `PrivilegeService`.
- Provider setup MUST follow non-mutating inspect/plan, core-owned consent through `InteractionService`, then apply. Apply MUST NOT discover new mutations.
- Linux managed-provider prerequisite provisioning is limited to missing `newuidmap`/`newgidmap` on exactly Ubuntu 26.04, after consent, using only `/usr/bin/apt-get update` and `/usr/bin/apt-get install --yes --no-install-recommends uidmap` through `PrivilegeService`, followed by re-probing. Every other missing prerequisite fails closed. App lifecycle commands MUST NOT provision host packages.
- Setup task children settle explicitly on failure. `SUDO_ASKPASS` is set when available.
- All setup egress honors §10.3.1.
- `lando shellenv` emits profile configuration for `<userDataRoot>/bin`.
- Slow providers run active file-sync setup unless `--skip-file-sync`; native providers do not.

### 10.9 Logs and diagnostics

- Core logs live under `<userCacheRoot>/logs/`; app logs are discoverable by app id and root.
- `RuntimeProvider.logs` streams service output. Declared service log sources (§6.14) use redirect or provider file-follow capability, are labeled by `LogChunk.source`, and MUST NOT disappear silently.
- Debug logs include provider operation names and redacted inputs; structured logger annotations preserve `traceId`.
- Normal diagnosis MUST NOT require provider-native commands.

`lando doctor` combines core checks with `provides.doctorChecks`. Every finding has severity, context, and automatic or manual remediation; `--fix` runs only declared automatic actions.

- `DoctorCheckContext` exposes bounded app/provider identity, resource inspection, and path-only executable lookup. It MUST NOT execute candidates, read executable contents or state, or import `@lando/container-runtime`.
- Bundled `@lando/lando3` contributes read-only `lando3-leftovers` and `lando3-shadow` checks. They MUST NOT mutate or read Lando 3 user state; `LegacyProxyContainerDetected` solely owns legacy proxy detection.
- Core covers discovery, removed wrappers, plugin metadata, provider availability, and legacy proxy conflicts. A conflict raises `LegacyProxyContainerConflictError`. Plugin metadata failures become attributed self checks rather than aborting the report.
- Shell-shaped checks and fixes SHOULD use `ShellRunner`; transcripts persist at `<userCacheRoot>/logs/doctor/<run-id>.transcript`. `lando doctor --transcript-only` prints that transcript.

#### 10.9.1 Self-resilience

- Doctor MUST emit a structured report for every host state except user interrupt. Provider, subsystem, global-app, MCP, version, deprecation, and config sections run in isolation.
- Failure, defect, or deadline in a section adds a redacted `doctor-self` entry to `self.checks`, appears in every output format, and makes exit non-zero.
- Section deadlines are bounded and configurable by `LANDO_DOCTOR_SECTION_BUDGET_MS`; checks remain interruptible Effect programs.
- Provider failures degrade to a non-pass `selected-provider` check with setup remediation.
- Each plugin check is isolated, attributed, strictly decoded as `PluginDoctorReport`, and bounded. This is cooperative isolation, not a hostile-code sandbox.
- `meta:doctor` declares base bootstrap `none`, constructs the provider runtime once inside its own scope, and degrades provider-bootstrap failure without suppressing independent sections. It still uses native dispatch, Effect, and `Renderer`; `notify.commands` MUST NOT promote it.

### 10.10 Host proxy

`HostProxyService` is the opt-in, per-app container-to-host RPC port installed by `lando.host-proxy` for `type: lando` services. It opens host URLs/paths and re-enters approved Lando or Bun operations. It is not the deferred persistent agent.

#### 10.10.1 Architecture and protocol

- The host dispatcher binds `<userDataRoot>/run/<app-id>/host-proxy.sock`, mounted read-only at `/run/lando/host-proxy.sock`, and injects `LANDO_HOST_PROXY_SOCKET`, `LANDO_HOST_PROXY_TOKEN`, and `LANDO_HOST_PROXY_DEPTH` when provider reachability permits.
- The dispatcher and token live for the app's started scope. One retained `LandoRuntime` serves `runLando` through `@lando/core/cli`.
- `HostProxyRequest` tags are `openUrl`, `openPath`, `runLando`, and `runBun`; `HostProxyResponse` tags are `ok` and `error`, classified by `HostProxyErrorCode`. Requests require bearer-token authentication. `runLando` streams NDJSON stdout, stderr, exit, or error frames.
- Container-initiated notification and clipboard relay are unsupported in v4.0.
- Default `openUrl` schemes are `http`, `https`, `mailto`, `tel`, `vscode`, `vscode-insiders`, `cursor`, `phpstorm`, `idea`, `webstorm`, `goland`, `pycharm`, `rubymine`, `clion`, `fleet`, and `zed`. `file://` is always forbidden. Extensions use the service layer or global `hostProxy.allowedSchemes`.
- `runLando` uses the generated `host-proxy-allowlist`. Lifecycle commands, `meta:bun`, and `meta:x` MUST NOT be allowed; violations fail with `HostProxyAllowlistConflictError`.
- `runBun` uses the non-plugin-extensible `host-proxy-bun-verb-allowlist`: `audit`, `outdated`, `pm`, `info`, and `why`. Mutating verbs fail with `HostProxyBunVerbNotAllowedError`.
- Recursive re-entry is bounded by `LANDO_HOST_PROXY_DEPTH` and fails with `HostProxyRecursionLimitError`. Per-app concurrency is bounded by global `hostProxy.maxConcurrent` and fails with `HostProxyBackpressureError`.

#### 10.10.2 In-container shim and required behavior

One static client is installed as `xdg-open`, `open`, and `lando`; optional `lando.host-proxy.bun: true` installs `bun` only when it does not shadow an existing Bun. It dispatches by invocation name, filters forwarded environment, remaps cwd through `AppMountInfo`, rejects `BUN_BE_BUN` recursion, and prints deterministic fallback errors when proxy env is absent. It is a signed wire client, not the host `lando` binary.

- `HostProxyServiceLive` MUST construct lazily and do nothing for apps without the feature.
- Every request, including rejection, publishes redacted `pre-host-proxy-call` and `post-host-proxy-call`.
- Tokens MUST be cryptographically random. Socket creation MUST be atomic and private; stale sockets fail with `HostProxySocketStaleError`.
- Interrupt MUST close the listener, finalize requests, and unlink the socket. Unsupported provider reachability plans a visible no-op rather than runtime failure.
- Doctor checks socket privacy, reachability, token round-trip, and allowlist freshness.
- Plugin replacements for CI, audit, remote transport, or testing MUST pass the contract suite, retain allowlists and authentication, and MUST NOT weaken security.

Other tagged errors are `HostProxyOpenUrlSchemeError`, `HostProxyCommandNotAllowedError`, and the response error codes registered by the public protocol schema.

### 10.11 Data movement and volumes

`DataMover` is the fixed core chokepoint for local, volume, service, stream, and artifact bytes. It is neither `FileSyncEngine` nor remote transport, and is host/test-overridable but not plugin-contributed. `ManagedFileService` owns user-visible managed project files.

#### 10.11.1 `DataEndpoint` and `DataMover`

`DataEndpoint` tags are `hostPath`, `hostArchive`, `stream`, `volume`, `servicePath`, `serviceCmd`, and `artifact`; `ArchiveFormat` covers supported archive forms. `DataMover` exposes scoped `transfer`, `transferStream`, `snapshot`, `restore`, `listSnapshots`, `removeSnapshot`, and `pruneSnapshots` over `DataTransferSpec`, `DataTransferResult`, `DataTransferProgress`, `VolumeRef`, `SnapshotOptions`, `SnapshotHandle`, `SnapshotId`, `SnapshotInfo`, `SnapshotFilter`, and `PrunePolicy`; failures use `DataMoverError`.

- Native provider data-plane capability wins; otherwise a generic helper path is used; otherwise `DataEndpointUnsupportedError` fails with remediation. Capability honesty is mandatory.
- Helper artifacts are pinned, verified, cached, and reusable offline.
- All movement is streaming and scope-bound; interrupt reaps underlying processes.
- Archive and snapshot writes record SHA-256 and restores verify it. There is no skip-verification flag.
- Redaction uses `RedactionService`; credentials use environment, never argv.
- Events are `pre-data-transfer`, `data-transfer-progress`, `post-data-transfer`, `pre-volume-snapshot`, and `post-volume-snapshot`.
- Host endpoints MUST remain within the app root or explicit base. Destructive restore/import requires `overwrite: true`.

#### 10.11.2 Snapshot store and errors

Snapshots live under `<userDataRoot>/snapshots/<app-id>/<store>/` through `PathsService` and are indexed by `StateStore`. Native providers persist a provider snapshot reference; copy mode persists an archive and metadata. Plain destroy keeps snapshots; `lando destroy --purge` removes them. Destructive teardown MAY take a safety snapshot unless opted out.

Tagged errors are `DataTransferError`, `DataEndpointUnsupportedError`, `DataChecksumMismatchError`, `DataSourceOutsideRootError`, `DataTargetExistsError`, `SnapshotNotFoundError`, `VolumeNotFoundError`, and `ArchiveFormatError`; provider causes may include `VolumeOperationError`, `ServiceCopyError`, and `ArtifactTransferError` (§5.7). `TestDataMover` supports contract testing.

### 10.12 Remote data sync (`RemoteSource` + `Dataset`)

This surface is contract-only for Beta 1 and implementation is deferred to 4.1. `RemoteSource` owns network location and transport; `Dataset` owns local capture/apply. Sync covers databases, user files, and config, never application code.

`RemoteSource` exposes identity, `RemoteCapabilities`, config schema, `RemoteConfig` environment listing, `RemoteLocator` resolution, scoped fetch/send options, and optional `RemoteTestResult`. `Dataset` exposes identity, `DatasetKind`, `DatasetCapabilities`, `DatasetArtifactFormat`, scoped capture/apply through `DatasetContext` and their option/result contracts, and local-store resolution. Their portable seam is a `DataEndpoint`; core owns `app:pull`, `app:push`, `App.pull()`, and `App.push()` orchestration.

- Selection follows explicit remote, Landofile source, then sole installed implementation (§4.3).
- Control and data egress MUST use `HttpClient`; vendor tools MUST use tool provisioning/`Downloader` and scoped `ProcessRunner`.
- Local landing MUST use `Dataset` and `DataMover`; `RemoteSource` MUST NOT implement database import or file extraction.
- Pull snapshots local stores unless `--no-snapshot` and requires consent unless non-interactive approval is explicit. Push requires declared capability; protected environments require force plus typed confirmation.
- Config uses Landofile `remotes:` and optional `sync:` (§7.4). Durable resolution state uses `StateStore`; paths use `PathsService`; readiness uses `runProbe`.
- Secrets, URLs, and paths MUST be redacted before all output or persistence.
- Machine output uses §8.11; streaming uses `StreamFrame`.
- Events are `pre-pull`, `post-pull`, `pre-push`, `post-push`, `pre-dataset-capture`, `post-dataset-capture`, `pre-dataset-apply`, `post-dataset-apply`, `pre-dataset-fetch`, `post-dataset-fetch`, `pre-dataset-send`, and `post-dataset-send`.
- Commands are `app:pull`, `app:push`, `app:remote:list`, `app:remote:add`, `app:remote:remove`, `app:remote:test`, `app:remote:setup`, and `app:remote:env:list`.

Tagged errors are `RemoteError`, `RemoteUnreachableError`, `RemoteAuthError`, `RemoteEnvNotFoundError`, `RemoteDatasetUnsupportedError`, `RemoteProtectedEnvError`, `RemoteToolMissingError`, `DatasetError`, `DatasetCaptureError`, `DatasetApplyError`, and `DatasetBindingError`. `TestRemoteSource`, local source, and `TestDataset` support contract testing.

### 10.13 Managed files

`ManagedFileService` is the fixed core chokepoint for marked, rendered files in the user's working tree. Plugins use the pre-namespaced `LandoPluginContext.managedFiles`; there is no plugin contribution surface.

#### 10.13.1 Contract and ownership

`ManagedFile` names `id`, `owner`, relative `path`, ownership `mode`, `format`, `content`, optional marker, permissions, conflict policy, and base. `ContentSource` tags are `text`, `structured`, `template`, and `inline`. Modes are whole `file`, fenced `block`, and reserved structured `keys`; `landofile` and YAML use the canonical serializer.

`ManagedFileService` exposes `ManagedFilePlan` through `plan`, scoped `apply` with `ApplyOptions` and `ManagedFileResult`, `remove` through `ManagedFileSelector`, `status` as `ManagedFileInfo`, `adopt`, and `release`.

- `ManagedFileServiceLive` is lazy at bootstrap level `minimal` and inert at construction.
- `plan` is side-effect-free and agrees with `apply`; actions are `create`, `update`, `skip-unchanged`, `skip-adopted`, `conflict`, and `adopt-detected`.
- Writes are atomic and contained under the resolved base. Templates use `TemplateRenderer`; structured content uses shared codecs.
- Events are `pre-managed-file-write`, `post-managed-file-write`, `managed-file-conflict-detected`, and `managed-file-skipped`, without file content.
- Removal touches only owned files/blocks. Adoption strips ownership markers and prevents future writes; release reverses ledger ownership.
- Plugin access is owner-namespaced and MUST reject cross-owner operations.

#### 10.13.2 Ledger, errors, and tests

The `StateStore` ledger lives at `<userDataRoot>/managed-files/<app-id>/ledger.json` through `PathsService.managedFileLedger(appId)`. Marked working-tree files are authoritative; the ledger records identity, ownership, checksums, source hash, state, backup metadata, and timestamps. Pre-existing or adopted files are skipped; unchanged files are skipped; source changes update only unmodified managed files; user edits conflict by default; removed markers imply adoption.

The sole tagged error is `ManagedFileError`, with reasons `io`, `decode`, `conflict`, `path`, and `format`, and operations `plan`, `apply`, `remove`, `status`, `adopt`, and `release`. Error payloads MUST be redacted. The §13.1 suite and managed-file boundary gate protect atomicity, containment, ownership, ledger recovery, and secret redaction.

### 10.14 MCP server (`McpService`)

`McpService` is the in-process Model Context Protocol server behind `lando mcp` (§8.2.6). MCP is a projection of canonical command, result, resource, and event registries, not a parallel command surface. It exposes scoped `serve` and `catalog` over `McpServeOptions`, `McpCatalogOptions`, and `McpCatalog`.

- Tools derive from `LandoCommandSpec`, `FlagSpec`, and `ArgSpec`; results use `CommandResultEnvelope` and `encodeCommandResult`; streams use progress notifications and a final result envelope.
- Optional tooling projection uses `mcp.tooling` or `--tooling` and `runTooling`. Resources reuse resolved config, deep info, apps list, and doctor schemas. Notifications replay redacted bounded `EventService` history.
- v4.0 transport is stdio. Streamable HTTP is deferred, and future outbound HTTP MUST use `HttpClient`.
- `serve` retains one `LandoRuntime`; app resolution uses `resolveApp`/`AppSelector` (§16.3).
- Effective tools are generated `mcp-allowlist` plus `mcp.allow`/`--allow`, minus `mcp.deny`/`--deny`; deny wins. Destructive commands are never default-allowed.
- Dispatch is non-interactive; prompt-requiring commands fail rather than hang, and confirmations require explicit inputs.
- Calls are bounded, cancellable fibers; transport close interrupts the serve scope.
- Every result, resource, notification, and JSON-RPC frame MUST be redacted and schema-bounded before retention; oversized serialization fails with `McpTransportError` without invoking application getters or `toJSON` hooks.
- Every dispatch, including rejection, publishes `pre-mcp-call` and `post-mcp-call`.
- `meta:mcp` MUST NOT be host-proxied or recipe-scaffolded. Doctor validates allowlist freshness, catalog generation, and a canary round trip.

Tagged errors are `McpToolNotAllowedError`, `McpToolInputError`, `McpTransportError`, and `McpAllowlistConflictError`; command failures remain inside unsuccessful result envelopes. `McpService` is core-owned and not plugin-replaceable in v4.0; `mcpServers:` is deferred.

---
