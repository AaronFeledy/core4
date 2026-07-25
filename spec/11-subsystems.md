# Lando v4 — Subsystems

> **Part 11 of 18** · [Index](./README.md)
> **Read next:** [12 Caches and Persistence](./12-caches-and-persistence.md)

This part defines the cross-cutting subsystems that sit between the core runtime and provider/plugin implementations. Each subsystem owns a small set of responsibilities, exposes a pluggable `Context.Service`, and is realized by one or more plugin implementations.

Covered here: networking intent (no shared bridge in core; `<service>.<app>.internal` aliasing; `host.lando.internal`), `ProxyService` and `RoutePlan` (with the route-filter abstraction replacing Traefik-specific middleware), `CertificateAuthority` (root CA, leaf certs, trust-store install), corporate proxy and custom CA handling for Lando-owned network access, SSH and host identity (with the new SSH-agent sidecar default that eliminates direct host-agent socket mounts), `HealthcheckRunner` and `UrlScanner`, files and performance, SQL helpers (plugin-provided; not in core), `lando setup` and host integration, the per-app `HostProxyService` that lets in-container shims (`xdg-open`, `lando`) call back to the host over a token-authenticated Unix socket, and logs/diagnostics.

Byte movement is part of this subsystem surface and has two chokepoints, one per direction. **Outbound/remote** bytes go through `HttpClient` (§10.3.2) — the single egress abstraction that centralizes proxy/CA honoring, redaction, streaming request/response and upload, cancellation, and lifecycle events; `Downloader` (§10.3.3) is the verified-artifact specialization layered over it (checksum/size verification, atomic persistence, cache/offline short-circuiting, progress), and the tool-provisioning helper (§10.3.4) extracts and installs pinned host binaries over `Downloader`. **Local/volume/service** bytes go through `DataMover` (§10.11) — the on-host counterpart that moves bytes between host paths/archives, in-process streams, named volumes, service paths/commands, and built artifacts, owning snapshot/restore, verification, and the `Data` lifecycle events. A flow that does both (hosting `pull`/`push`, `image load` from a URL) composes them: `HttpClient` for the remote half, `DataMover` for the local landing half.

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
- `stop` disables routing durably by removing all app route definitions; it does not stop unrelated
  global-app services or require process-local state. `status` reports this durable routing state.
- Proxy plugins consume `RouteFilter` plugin contributions to translate filters into native middleware.

**§10.2.1 Default Live Layer realization through the global app**

The default `ProxyService` Live Layer in v4 — `ProxyServiceTraefikGlobalAppLive`, shipped with `@lando/proxy-traefik` (§1.4) — realizes its work through a `traefik` service running inside the global Lando app (§20). The plugin contributes BOTH a `proxyServices:` entry (the Live Layer) AND a paired `globalServices:` entry (the `traefik` service definition); installing one without the other is rejected at plugin load with `ProxyContributionPairError` (§20.10.1, §20.13).

Required behaviors:

- `ProxyService.applyRoutes(routes, app)` writes Traefik dynamic config under a Lando-managed directory mounted into the `traefik` global service via the standard `mounts:` machinery. The `RoutePlan` schema is core's contract; the on-disk format is the proxy plugin's responsibility.
- `ProxyService.setup` calls `GlobalAppService.ensureRunning(["traefik"])` so the first user-app `lando start` after install brings the proxy up automatically.
- The §10.2 `ProxyService` interface is unchanged; only the realization moved into the global app. Alternative `ProxyService` plugins (remote proxy, Caddy, etc.) MAY contribute a Live Layer that does NOT touch `GlobalAppService`; selection follows §4.3.
- A user upgrading from a pre-§20 install whose host still has a v3-style out-of-band Traefik container running gets a `LegacyProxyContainerDetected` doctor diagnostic (§10.9, §20.10.3); migration is plugin-supplied.

### 10.2.2 Public tunnels and app sharing (`TunnelService`)

Core owns the public-tunnel intent, schemas, tagged errors, CLI/API shape, detached-state rules, and contract suite. `TunnelService` plugins own provider-specific realization: Cloudflare quick tunnels, ngrok, Tailscale Funnel, enterprise relays, or audited no-egress implementations. This is a §4.2 pluggable abstraction because providers differ in authentication, control-plane API, connector process, URL lifetime, and policy constraints.

```ts
export class TunnelService extends Context.Service<TunnelService, {
  readonly id: string;
  readonly capabilities: TunnelCapabilities;
  readonly start:  (request: TunnelStartRequest)  => Effect.Effect<TunnelSession, TunnelError, Scope.Scope>;
  readonly stop:   (request: TunnelStopRequest)   => Effect.Effect<void, TunnelError>;
  readonly status: (request: TunnelStatusRequest) => Effect.Effect<TunnelStatus, TunnelError>;
  readonly list:   (filter?: TunnelSessionFilter) => Effect.Effect<ReadonlyArray<TunnelSession>, TunnelError>;
}>()("@lando/core/TunnelService") {}
```

`TunnelTarget` is a tagged union over app-local targets: a resolved `RoutePlan` id/hostname, a service endpoint (`service`, `port`, optional protocol), or an explicit loopback URL created by core from those shapes. A tunnel plugin MUST NOT accept arbitrary public-to-host-port forwarding by default; raw host-port targets require an explicit advanced option and are rejected by canonical `lando share` UX. The normal route is `public URL -> provider tunnel -> local proxy/service endpoint -> app service`, so app routing, TLS intent, and route filters remain governed by the same app plan users already see in `lando info`.

Required behaviors:

- `TunnelService` is selected through `tunnelServices:` manifest contributions (§9.5) using the standard §4.3 precedence: explicit command/API provider choice, Landofile/global default, then sole installed implementation. If no implementation is installed, `lando share` fails with remediation listing bundled/community options.
- Provider control-plane calls (login/device flow, session create, session delete, metadata/status) MUST use `HttpClient` (§10.3.2). Plugins MUST NOT call `fetch` or open sockets directly for Lando-owned control-plane egress, so proxy/CA/offline/redaction policy is inherited.
- Connector binaries (`cloudflared`, `ngrok`, etc.) MUST be acquired through the §10.3.4 tool-provisioning helper over `Downloader`, with pinned `ToolManifest` entries, checksum verification, `<userDataRoot>/bin/` install markers, and offline reuse once warm. A provider that ships no connector binary can omit this step.
- Connector processes MUST run through `ProcessRunner` with argv-precise invocation, redacted env, and `Scope`-bound finalization. Foreground tunnels close on Ctrl+C / `Effect.interrupt`; detached tunnels persist until explicit `app:share:stop`, app destroy, or GC.
- Detached-session state is a `StateStore` bucket at `<userCacheRoot>/tunnels/registry.bin` (§12.1) plus per-session process metadata under `<userDataRoot>/run/tunnels/`; stale PID/socket entries reconcile safely on `status`, `list`, and `gc` without treating orphaned state as active exposure.
- Readiness waits use the §10.5.1 probe primitive against the public URL or provider status API. Tunnel implementations MUST NOT hand-roll retry/backoff loops.
- Public URLs, provider auth URLs, bearer tokens, device codes, connector env, and local host paths are redacted through `RedactionService` before reaching logs, events, JSON output, transcripts, telemetry, support bundles, or durable state. Debug logs may include provider-native diagnostics only under the existing protected debug-log policy.
- `TunnelService` publishes `pre-tunnel-start`, `post-tunnel-start`, `tunnel-ready`, `pre-tunnel-stop`, `post-tunnel-stop`, and `tunnel-status` events. Payloads include app id, target summary, provider id, detached/foreground mode, redacted public URL summary, readiness status, duration, and tagged failure detail.
- `lando share --format json` and embedding-host `app.share()` return the universal machine-output/session schemas (§8.11) rather than provider-specific text. Long-running foreground share emits `StreamFrame`s and terminates with a result frame when the tunnel closes.
- `TunnelService` is not byte movement. It does not use `DataMover` unless a higher-level feature combines sharing with data transfer. Hosting `pull`/`push` composes `HttpClient` and `DataMover`; `TunnelService` composes `HttpClient`, tool provisioning/`Downloader`, `ProcessRunner`, `StateStore`, the probe primitive, `InteractionService`, and `RedactionService`.

Tagged errors:

- `TunnelProviderUnavailableError` — no selected provider, provider binary unavailable, or provider policy blocks tunnel creation. Payload includes provider id when known and install/auth remediation.
- `TunnelTargetUnresolvedError` — the requested route/service target cannot be resolved from the app plan or current runtime info.
- `TunnelAuthRequiredError` — provider authentication is missing or expired and non-interactive mode cannot complete the prompt/device-flow step.
- `TunnelStartError` — connector/control-plane start failed; carries redacted provider detail and remediation.
- `TunnelReadyTimeoutError` — the provider reported/created a tunnel but the readiness probe never reached green before the deadline.
- `TunnelDetachedStateError` — detached registry or PID/socket state is corrupt, locked, stale, or cannot be reconciled.
- `TunnelStopError` — control-plane or connector teardown failed; best-effort local cleanup already ran where safe.

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

This policy is implemented in exactly one place: the canonical network-trust resolver, exported as a pure `@lando/sdk` module and consumed at runtime by the `HttpClient` service (§10.3.2). Every Lando-owned fetch flows through `HttpClient`, so `Downloader` (§10.3.3), the tool-provisioning helper (§10.3.4), and every request/response caller (hosting push/pull, telemetry delivery, update-manifest fetch, plugin-registry queries, tunnel/share control planes, the in-process MCP surface, the `UrlScanner`) inherit the same proxy/CA resolution without re-implementing it. `lando setup` preflight consumes the same resolver to classify proxy/CA failures before issuing real requests. Package-manager operations delegated to `BunSelfRunner` are the one exception: they honor the same `network.proxy` / `network.ca` policy through their own runner contract rather than through `HttpClient`.

Required behaviors:

- Lando-owned network clients honor explicit global `network.proxy` config (§7.5), then standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables when config is unset.
- Lando-owned network clients honor additional CA certificates from global `network.ca.certs` (§7.5) and `LANDO_NETWORK_CA_CERTS`, and use the host trust store when `network.ca.trustHost: true` and the platform supports it.
- `lando setup` validates proxy/CA configuration before long downloads and surfaces actionable remediation for TLS interception, proxy authentication, missing CA, and blocked registry errors.
- Provider plugins receive the resolved proxy and CA configuration during setup/apply so they can configure private runtimes, helper binaries, provider-native artifact pulls, and Lando-initiated artifact builds consistently.
- App build/dependency commands can opt into inheriting the resolved proxy and CA configuration from service config (§6.8). Lando does not force those settings into arbitrary app processes by default because proxy credentials may be sensitive.
- Service-level `security.ca:` remains separate from Lando-owned outbound trust: it injects CAs into app services, while `network.ca` controls Lando's own fetches.
- Proxy credentials are secrets. They are redacted from logs, telemetry, support diagnostics, lockfiles, and cache metadata.
- Offline-capable commands do not fail because proxy/CA endpoints are unreachable when their required local state is already present (§12.6).

### 10.3.2 Outbound HTTP (`HttpClient`)

`HttpClient` is the single outbound-egress chokepoint for all Lando-owned network access. Every request/response interaction Lando initiates — RemoteSource push/pull orchestration and uploads, telemetry delivery, the update-manifest fetch, plugin-registry queries, tunnel/share control-plane calls, an outbound MCP/LLM call (if and when that surface ships), and the default fetch-based `UrlScanner` (shell-based scanner plugins use `ShellRunner` per §10.5) — MUST flow through `HttpClient`, not direct `fetch` or plugin-local proxy/CA wiring. The one exception is registry/package-manager operations delegated to `BunSelfRunner`, which honor the same `network.proxy` / `network.ca` policy through their own runner contract. `Downloader` (§10.3.3) is itself a consumer: it issues its byte-fetch through `HttpClient`, so overriding `HttpClient` once (audited, air-gapped, mirror, corporate gateway) governs downloads too.

```ts
export class HttpClient extends Context.Service<HttpClient, {
  readonly id: string;
  readonly capabilities: HttpClientCapabilities;
  // Buffered request/response.
  readonly request: (req: HttpRequest)       => Effect.Effect<HttpResponse, HttpError, Scope.Scope>;
  // Streaming response body — REQUIRED so `Downloader` can stream → hash → temp file without buffering whole artifacts.
  readonly stream:  (req: HttpRequest)       => Effect.Effect<HttpStreamResponse, HttpError, Scope.Scope>;
  // Streaming/buffered upload (PUT/POST bodies, multipart) for push and similar.
  readonly upload:  (req: HttpUploadRequest) => Effect.Effect<HttpResponse, HttpError, Scope.Scope>;
}>()("@lando/core/HttpClient") {}
```

`HttpRequest` carries method, URL, headers, optional body, optional per-call resolved network-trust override, redaction tokens, and timeout/retry policy (the §10.5.1 probe primitive supplies retry semantics). `HttpStreamResponse` exposes status, headers, and a `body: Stream.Stream<Uint8Array, HttpError>`.

Required behaviors:

- `HttpClient` resolves outbound trust with the canonical §10.3.1 resolver unless the caller passes an already-resolved trust object (e.g., from setup preflight). Every request honors explicit `network.proxy`, then `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`, plus configured custom CA PEMs.
- `stream` MUST expose the response body as a `Stream<Uint8Array>` and MUST NOT buffer the whole body in memory; `request` buffers only when the caller wants a buffered body.
- Proxy credentials, URL userinfo, bearer tokens, signed-URL query params, and caller-supplied redaction tokens MUST be redacted from logs, telemetry, support diagnostics, lifecycle events, lockfiles, and cache metadata. The active `Logger` at debug level MAY observe unredacted detail.
- Every call publishes `pre-http-call` and `post-http-call` lifecycle events (§3.5/§11.2) with the redacted URL origin, method, caller-subsystem id, status, byte counts, duration, and redacted failure detail. A call issued on behalf of a `Downloader` request is tagged with the originating download so telemetry/transcripts do not double-count it as an independent `http-call`.
- `Effect.interrupt` MUST close the connection and the service's `Scope` MUST reap in-flight transfers.
- Offline cooperation: `HttpClient` does not itself cache, but it honors an offline policy by failing fast without opening a connection when the caller declares offline-only.
- Construction is inert: building `HttpClientLive` (eager at level `minimal`) MUST NOT touch the network, the provider, or any plugin module — it only captures the resolved trust configuration. The first byte of egress happens on the first `request`/`stream`/`upload`, never at Layer construction (§2.4 alignment).
- Scope discipline: `HttpClient` is a thin trust-aware, redacted, cancellable request/response + streaming + upload primitive. It is NOT a REST framework, retry engine, or artifact-verification layer — checksum/size verification and atomic persistence belong to `Downloader` (§10.3.3); retry/backoff belongs to the §10.5.1 probe primitive; hosting/registry/tunnel plugins build their vendor API clients on top of it.

`HttpClient` is a §4.2 pluggable abstraction. Plugin-contributed implementations MAY provide audited, air-gapped, mirror-aware, corporate-gateway, or recording behavior, but they MUST pass the `HttpClient` contract suite (§13.1) and MUST NOT weaken proxy/CA honoring, redaction, scheme policy, or cancellation finalization.

Tagged errors:

- `HttpRequestError` — DNS, TCP, TLS, proxy, HTTP status, or response-body failure on a request/stream. Payload includes redacted URL origin, method, status when available, classified network-trust cause when known, and remediation.
- `HttpUploadError` — an `upload` failed (connection, status, or body-stream failure). Payload includes the redacted target origin and remediation.
- `HttpTrustError` — outbound trust could not be satisfied; carries a classified kind (`proxy-authentication`, `tls-interception`, `missing-custom-ca`, `blocked-endpoint`) and platform-specific remediation. This is the runtime form of the `lando setup` preflight classification (§10.8).
- `HttpClientUnavailableError` — the selected `HttpClient` implementation cannot satisfy the request or its declared capabilities (e.g., a sandboxed host that allowlists specific origins).

### 10.3.3 Verified downloads (`Downloader`)

`Downloader` is the verified-artifact specialization layered over `HttpClient` (§10.3.2). It owns checksum/size verification, atomic persistence, cache/offline short-circuiting, and download progress; it does NOT open its own socket. All Lando-owned artifact downloads MUST flow through `Downloader`, not direct `fetch` or ad-hoc checksum helpers. This includes the `@lando/provider-lando` runtime bundle, Mutagen host and agent binaries, helper binaries, recipe and include tarballs, self-update binary/checksum/signature artifacts, and future provider/helper artifacts that Lando initiates directly.

```ts
export class Downloader extends Context.Service<Downloader, {
  readonly id: string;
  readonly capabilities: DownloaderCapabilities;
  readonly download: (request: DownloadRequest) => Effect.Effect<DownloadResult, DownloadError, Scope.Scope>;
}>()("@lando/core/Downloader") {}

export const ArtifactManifestEntry = Schema.Struct({
  url: Schema.String,          // production manifests MUST be https://; file:// only through explicit dev/CI override paths
  sha256: Schema.String,       // 64 hex chars
  filename: Schema.String,
  sizeBytes: Schema.optional(Schema.Number),
});
```

`DownloadRequest` carries a single resolved artifact URL, an atomic file destination or `memory` destination, optional expected `sha256`/`sizeBytes`, an explicit `allowFileSource` gate for local CI/dev artifacts, optional resolved network-trust override, offline/cache policy, and caller-supplied redaction tokens. Manifest selection remains with the caller: a provider or updater resolves the active per-platform entry and override precedence, then passes that single entry to `Downloader`.

Required behaviors:

- Production artifact manifests MUST use `https://` URLs. `file://` is rejected unless the caller sets the explicit override gate (`allowFileSource: true`), and that gate is limited to documented dev/CI override paths such as `LANDO_RUNTIME_BUNDLE_MANIFEST` (§5.8.1).
- `Downloader` issues its byte-fetch through `HttpClient.stream` (§10.3.2); it does NOT resolve proxy/CA or open a socket itself. Outbound trust, redaction, and the `pre-/post-http-call` events are inherited from `HttpClient`, so overriding `HttpClient` (audited, air-gapped, mirror, corporate gateway) automatically governs every download.
- File downloads pipe the `HttpClient.stream` body through a SHA-256 hasher while writing to a unique temp file in the destination filesystem, then atomically rename on success. The temp file is deleted on `Effect.interrupt`, fetch failure, size mismatch, checksum mismatch, or persistence failure. This stream → SHA-256 → temp-file → atomic-rename logic is the pure, dependency-free `@lando/sdk` streaming-hash/atomic-write helper (same contracts-only tier as `@lando/sdk/probe` / `@lando/sdk/secrets`); `DataMover` (§10.11) consumes the **same** helper for archive verification so the verify-and-persist path exists once, not twice.
- `memory` downloads buffer only when the caller explicitly requests bytes in memory. Large artifacts default to file streaming so runtime bundles and helper binaries are never double-buffered.
- If the destination already exists and matches the expected SHA-256, the download is a cache hit: no network request is made, `fromCache: true` is returned, and offline mode succeeds. If offline mode is active and no matching cached artifact exists, the request fails with `DownloadOfflineError` before opening a network connection.
- Destination filenames are path-contained. A manifest `filename` whose realpath would escape the destination directory is rejected with `DownloadSourceForbiddenError` before any bytes are read.
- The service publishes `pre-download`, zero or more `download-progress`, and `post-download` lifecycle events. Payloads include URL origin, artifact kind/caller id, byte counts, cache-hit status, checksum summary, duration, and redacted failure detail. URL credentials, proxy credentials, bearer tokens, signed-URL query params, and caller-supplied redaction tokens MUST NOT appear in events, telemetry, support diagnostics, lockfiles, or cache metadata.
- Checksum verification is mandatory whenever a request supplies `expected.sha256`; callers that download executable or provider/helper artifacts MUST supply it. There is no skip-verification flag. Signature verification is a separate release/signing primitive (§17.6); callers may run it after `Downloader` returns the verified bytes/path, but the Downloader itself owns SHA-256 and size checks only.
- Plugin-contributed `Downloader` implementations MAY provide mirror or artifact-level cache behavior (e.g., rewriting a manifest URL to a mirror before fetching), but they MUST route every byte of egress through the resolved `HttpClient` (§10.3.2) — they MUST NOT open their own sockets or re-implement proxy/CA wiring. They MUST pass the Downloader contract suite (§13.1) and MUST NOT weaken scheme gating, checksum verification, atomic persistence, cache/offline semantics, redaction, or cancellation finalization.

Tagged errors:

- `DownloadFetchError` — DNS, TCP, TLS, proxy, HTTP status, or response-body failure. Payload includes redacted URL origin, status when available, classified network-trust cause when known, and remediation.
- `DownloadChecksumError` — actual SHA-256 differs from expected. Payload includes expected/actual hashes, size, destination, and caller id; temp files are already removed.
- `DownloadSizeMismatchError` — actual byte count differs from manifest `sizeBytes`.
- `DownloadPersistError` — temp-file creation, write, fsync, chmod, or atomic rename failed.
- `DownloadOfflineError` — offline/cache-only policy could not satisfy the request from an existing verified artifact.
- `DownloadSourceForbiddenError` — rejected scheme, `file://` without explicit override, path traversal, or destination escape.
- `DownloaderUnavailableError` — the selected downloader implementation cannot satisfy the request or declared capabilities.

### 10.3.4 Tool provisioning

Several subsystems acquire a pinned **host binary** rather than an opaque artifact: the bundled `@lando/file-sync-mutagen` engine installs the Mutagen host CLI and per-platform agents (§10.6.2), and the same shape recurs for any future bundled tool that ships a host executable (a tunnel CLI, `mkcert`, a profiler, a RemoteSource vendor CLI). That work is "verify bytes, then extract a named member from an archive and install it under `<userDataRoot>/bin/` with the right mode, recording what version is installed so re-runs are idempotent." `Downloader` (§10.3.3) deliberately stops at verified bytes/file, so this extract-and-install step is factored into one shared helper.

The tool-provisioning helper is a pure module published from `@lando/sdk` (the same contracts-only tier as `@lando/sdk/probe` and `@lando/sdk/secrets`); it is **not** an Effect service tag and **not** a §4.2 pluggable abstraction. Host-override of network behavior happens one layer down at `HttpClient` / `Downloader`; the helper itself is fixed so every bundled tool installs binaries identically. It consumes `Downloader` for the verified bytes and `FileSystem` for placement.

```ts
// Multi-platform pinned manifest for tools that install a host binary; one
// canonical schema replaces bespoke per-plugin versions-manifest shapes such
// as mutagen-versions.json. (The provider runtime bundle is NOT a ToolManifest:
// it is artifact-mode — fetched+verified via Downloader and unpacked by the
// provider, never installed under bin/ — so it keeps its own per-platform
// artifact manifest, §5.8.1.)
export const ToolManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  toolVersion:   Schema.String,                                  // e.g. the pinned Mutagen version
  // host key (e.g. "linux-x64", "darwin-arm64", "win32-x64") → artifact entry
  artifacts:     Schema.Record({ key: Schema.String, value: ToolArtifactEntry }),
});

export const ToolArtifactEntry = Schema.Struct({
  url:        Schema.String,                                     // https:// (file:// only via the documented dev/CI override)
  sha256:     Schema.String,
  sizeBytes:  Schema.optional(Schema.Number),
  archive:    Schema.optional(Schema.Literal("tar.gz", "zip")),  // omitted ⇒ the downloaded bytes are the binary
  member:     Schema.optional(Schema.String),                   // member to extract from the archive
  installName: Schema.String,                                   // basename to install under <userDataRoot>/bin (or a contained subdir)
  mode:       Schema.optional(Schema.String),                   // POSIX mode; default 0o755 on non-Windows
});
```

Required behaviors:

- The helper resolves the active host entry from `ToolManifest.artifacts` by `${platform}-${arch}`; an unrepresented host fails with `ToolManifestError` (the fail-closed equivalent of the per-plugin "unsupported platform" errors removed by this consolidation).
- It fetches and verifies the entry's bytes through `Downloader` (§10.3.3) — never directly — so checksum verification, proxy/CA honoring, redaction, and atomic temp handling are inherited and never re-implemented.
- When `archive` is set it extracts `member` (tar.gz or zip); extraction is bounded and the extracted member is written atomically. `installName` is realpath-contained under `<userDataRoot>/bin/`; a name that escapes is rejected with `ToolInstallPathError`. Non-Windows installs apply `mode` (default `0o755`).
- It records an installed-version marker plus a per-binary `.sha256` fingerprint, so a re-run whose pinned `toolVersion` and fingerprints already match is an **idempotent no-op** with no network access — the offline contract (§1.4) holds once a tool is provisioned.
- Extraction/install failures surface `ToolExtractError`; manifest/host-resolution failures surface `ToolManifestError`; containment failures surface `ToolInstallPathError`. All three live in `@lando/sdk/errors`.
- The pinned `ToolManifest` JSON is a compile-time embedded asset (§17.3 mechanism A) generated by the unified tool-manifest codegen (§17.2); the downloaded archive cache lives at `<userCacheRoot>/tool-downloads/<toolId>/` (§12.1) and the installed binaries plus markers under `<userDataRoot>/bin/` (§12.4).

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

Healthchecks and the URL scanner are both **retry-until-a-verdict** loops: run a probe effect, classify the result, and retry on a schedule until it passes, a budget is exhausted, or a deadline hits. v4 factors that shared shape into one declarative primitive — the **probe primitive** — so healthchecks, the scanner, `lando doctor` shell checks, the `Downloader` retry path (§10.3.3), and `lando setup` readiness waits share one retry/backoff/timeout vocabulary and one deterministic runner instead of each hand-rolling `Effect.retry` + `Schedule`.

#### 10.5.1 The probe primitive (`@lando/sdk/probe`)

The probe primitive is a pure, dependency-light SDK module published from `@lando/sdk/probe` — the same contracts-only tier as `@lando/sdk/secrets` and `@lando/sdk/expressions`, importable without constructing a `LandoRuntime`. It is **not** a pluggable abstraction (§4.2) and **not** an Effect service tag: it is a declarative `RetryPolicy` plus a pure runner that the `HealthcheckRunner`, `UrlScanner`, `DoctorService`, `Downloader`, and `lando setup` readiness paths all consume.

```ts
// @lando/sdk/probe — schemas (illustrative; canonical in the SDK)
export const RetryPolicy = Schema.Struct({
  maxAttempts: Schema.optional(Schema.Int),                 // total attempts incl. the first; default 1 (no retry)
  delay:       Schema.optional(DurationFromMillis),         // base delay between attempts; default 0
  backoff:     Schema.optional(Schema.Literal("fixed", "exponential")), // default "fixed"
  factor:      Schema.optional(Schema.Number),              // exponential multiplier; default 2
  maxDelay:    Schema.optional(DurationFromMillis),         // cap on a single inter-attempt delay; default unbounded
  jitter:      Schema.optional(Schema.Boolean),             // full jitter on each delay; default false
  timeout:     Schema.optional(DurationFromMillis),         // overall deadline across all attempts; default unbounded
});

export const ProbeOutcome = Schema.Literal("green", "yellow", "red");

export const ProbeSpec = Schema.Struct({
  id:     Schema.String,                                     // probe id for events/transcripts (e.g. "healthcheck:web", "scanner:https://app.lndo.site")
  policy: RetryPolicy,
  // Maps an attempt's success value or failure to a verdict. Default: success ⇒ green, failure ⇒ red.
  // A `yellow` verdict retries like `red` but is surfaced distinctly in the result.
  classify: Schema.optional(ClassifyFn),
});

export const ProbeResult = Schema.Struct({
  outcome:   ProbeOutcome,
  attempts:  Schema.Int,
  elapsedMs: Schema.Number,
  lastError: Schema.optional(Schema.Unknown),               // redacted by the consuming surface before it reaches events/transcripts
});
```

```ts
// Pure helpers — no service dependencies; deterministic under Effect's TestClock.
export const toSchedule: (policy: RetryPolicy) => Schedule.Schedule<unknown>;
export const runProbe:   <A, E, R>(spec: ProbeSpec, attempt: Effect.Effect<A, E, R>) => Effect.Effect<ProbeResult, ProbeError, R>;
```

Required behaviors:

- `runProbe` MUST be deterministic under Effect's `TestClock`: inter-attempt delays, exponential backoff, jitter, and the overall `timeout` deadline are all driven through Effect's `Clock`/`Schedule`, never `Date.now()` or `setTimeout`. Healthcheck, scanner, doctor, and setup suites assert attempt counts and elapsed time without wall-clock flake.
- `runProbe` MUST stop at the first `green` (the caller's success verdict), retry on `red`/`yellow` per `policy`, and resolve with a `ProbeResult` carrying the final `outcome`, the attempt count, the elapsed time, and the last error. Exhausting `maxAttempts` or hitting `timeout` resolves with the last non-`green` `ProbeResult` — it does NOT fail the Effect. The **consumer** decides whether a non-`green` outcome fails its own Effect (a healthcheck that never goes `green` fails app readiness; a scanner that ends `yellow` reports `yellow` without failing start).
- The primitive performs no IO, no logging, and no redaction. The consuming surface owns event publication and redaction: a `ProbeResult.lastError` that embeds a command, URL, or secret MUST be passed through the canonical `RedactionService` (§3.7) before it reaches a lifecycle event, transcript, or `lando info`.
- `ProbeError` (and the `ProbeTimeoutError` sub-shape it carries for deadline expiry) is a tagged error exported from `@lando/sdk/probe`. Like the `@lando/sdk/expressions` errors, it deliberately does NOT ride the frozen `@lando/sdk/errors` barrel, so adding the primitive widens no frozen error union.
- Core MUST NOT hand-roll a second `Schedule`/backoff/retry loop for any host- or provider-shaped probe. `HealthcheckRunner`, `UrlScanner`, `DoctorService` shell checks, the `Downloader` retry path, and `lando setup` readiness waits all build on `runProbe`; a §13.4-style boundary check keeps net-new `Effect.retry(… Schedule …)` loops out of `core/src/**` outside the primitive and its consumers.

**Healthcheck behaviors:**

- Healthchecks support `false`/`disabled`, string, string-array, and object forms; any form may be computed from disk via `load()` (§7.3).
- Object form supports `command`, `user`, `retry`, `delay`, `timeout`, `target`.
- Startup distinguishes `running` from `ready`. The `ready` event fires when all healthchecks pass.
- The active `HealthcheckRunner` decides execution mechanics. Default: `RuntimeProvider.exec` driving the probe primitive (§10.5.1) — the object form's `retry`/`delay`/`timeout` map onto a `RetryPolicy`, and the `ready` verdict is the probe's `green` `ProbeOutcome`.
- Healthchecks may declare `target: service | host` (default `service`). Service-target healthchecks run inside the named service via `RuntimeProvider.exec`. Host-target healthchecks run on the host via `ShellRunner` (§3.4) and are useful for probing proxy routes, TLS endpoints, port reachability, or DNS resolution from outside the container — exactly the cases where running the probe inside the service would test the wrong thing. Plugin-supplied `HealthcheckRunner` implementations MAY provide native probes (e.g., a TCP probe, a Postgres `SELECT 1`) that bypass shell entirely; runners declare which targets they can satisfy via `capabilities`, and the planner refuses healthchecks whose declared `target:` no installed runner supports with `HealthcheckTargetUnsupportedError`.

**URL scanner behaviors:**

- After start, the active `UrlScanner` probes host-facing URLs.
- Scanner config: `enabled`, `retry`, `delay`, `timeout`, `path`, `okCodes`, `maxRedirects`.
- Per-service overrides under `services.<name>.scanner:`.
- Results are reported as green/yellow/red with optional structured detail. The `retry`/`delay`/`timeout` config resolves to a `RetryPolicy` and the green/yellow/red verdict is the probe primitive's `ProbeOutcome` (§10.5.1); only the probe effect differs between the built-in and plugin scanners.
- The default scanner issues its probe through `HttpClient` (§10.3.2) against the resolved host-facing URL, inheriting the canonical proxy/CA resolution, redaction, and cancellation policy rather than calling `fetch` directly. Plugin-supplied scanners MAY use `ShellRunner` (§3.4) for shell-shaped probes — `curl --resolve` for testing custom DNS, `openssl s_client -connect` for TLS handshake details, `dig +short` for record validation — particularly when a project's routing depends on host networking that `fetch` cannot reproduce. Plugin scanners surface the same green/yellow/red verdict shape; only the underlying probe mechanism differs.

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

- **Binary placement.** Mutagen host CLI at `<userDataRoot>/bin/mutagen[.exe]`; agent binaries at `<userDataRoot>/bin/mutagen-agents/mutagen-agent-<platform>` (§12.4). The plugin provisions both through the shared tool-provisioning helper (§10.3.4): it ships a pinned `ToolManifest` asset (a `mutagen-versions.json` validated against the canonical `ToolManifest` schema; §17.2/§17.3 mechanism A) and the helper fetches `https://github.com/mutagen-io/mutagen/releases/download/...` through `Downloader` (§10.3.3) against the manifest's pinned SHA-256, extracts the host CLI and agent members, and installs them under `<userDataRoot>/bin/`. The plugin does not hand-roll fetch, checksum, extraction, or atomic install.
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
            [--no-interactive]
            [--skip-proxy] [--skip-install-ca]
            [--skip-shell-integration] [--skip-file-sync]
```

By default, `lando setup` installs the Lando-managed runtime without requiring any pre-existing Docker or Podman installation. Users who prefer a system runtime pass `--provider=docker` or `--provider=podman`; those providers assume the corresponding system installation already exists.

Rules:

- Provider plugins declare additional setup flags via the `setup.flags` manifest field.
- Platform-specific elevation runs through `PrivilegeService`.
- Provider setup is a normative `inspect/plan -> core consent -> apply` flow. Inspection performs no mutation and returns a schema-backed `ProviderSetupPlan` whose closed host-change union core can inspect and render. Core resolves every required consent through the injected `InteractionService`; only an approved plan is passed to provider apply. Providers MUST NOT embed consent callbacks or discover new host mutations during apply.
- On Linux, the managed provider preflights rootless prerequisites before detached runtime launch. Missing `newuidmap`/`newgidmap` is the only setup-time package change Lando may provision automatically, and only when `/etc/os-release` identifies exactly `ID=ubuntu`, `VERSION_ID=26.04`. Interactive setup prompts once with the fixed `uidmap` package and reason; `--yes` grants consent, `--no-interactive` without `--yes` denies it, and `--yes --no-interactive` grants unattended consent. The provider invokes only `/usr/bin/apt-get update` and `/usr/bin/apt-get install --yes --no-install-recommends uidmap` through `PrivilegeService`, then re-probes both helpers before launch. Other distributions and all other missing rootless prerequisites fail closed with tagged remediation; app lifecycle commands never auto-provision host packages.
- The setup task tree declares distinct prerequisite provisioning/preflight, managed-runtime launch, and runtime-readiness children. A failed child reports the tagged error message and remediation, and every unstarted child is settled before the tree completes so no setup state remains ambiguously waiting.
- Linux commands that may prompt for sudo set `SUDO_ASKPASS` when an askpass helper is available.
- Setup honors corporate proxy and custom CA configuration for every Lando-owned download or registry call (§10.3.1).
- `lando shellenv` prints shell-profile snippets to add `<userDataRoot>/bin` to `PATH`.
- When the resolved provider declares `bindMountPerformance: "slow"` (§5.4), setup also runs the active `FileSyncEngine`'s `setup()` (§10.6) — by default this downloads the bundled Mutagen host CLI and the per-platform agent binaries to `<userDataRoot>/bin/` against the plugin's pinned checksums. `--skip-file-sync` defers the download to first accelerated `app:start` instead. When the resolved provider declares `bindMountPerformance: "native"`, the file-sync stage is a no-op regardless of whether `--skip-file-sync` was passed.

### 10.9 Logs and diagnostics

**Required behaviors:**

- Core logs live under `<userCacheRoot>/logs/`.
- App logs are discoverable by app id and app root.
- Service logs stream via `RuntimeProvider.logs`. By default this is the service's container stdout/stderr; a service (via its service type, or a user via `services.<name>.logs:`) MAY additionally declare in-container **log sources** (§6.14) — file paths such as an Apache error log or a MySQL slow-query log — which are surfaced through the same `lando logs` stream, either by build-time redirect to `/dev/stdout`/`/dev/stderr` (preferred, zero runtime cost) or by a provider-owned file follower gated on the `serviceLogSources` capability. Declared sources are labeled by `LogChunk.source`; an unavailable source is reported, never silently dropped.
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
);
export type HostProxyRequest = Schema.Schema.Type<typeof HostProxyRequest>;

export const HostProxyResponse = Schema.Union(
  Schema.TaggedStruct("ok",    { data: Schema.optional(Schema.Unknown) }),
  Schema.TaggedStruct("error", { code: HostProxyErrorCode, message: Schema.String, remediation: Schema.optional(Schema.String) }),
);
```

`runLando` responses are delivered as NDJSON frames over the socket so the in-container shim can stream stdout/stderr in real time and exit with the host command's exit code. Each frame is one of `{ kind: "stdout", chunk }`, `{ kind: "stderr", chunk }`, `{ kind: "exit", code }`, or `{ kind: "error", … }`.

**Container-initiated terminal notification / clipboard relay is unsupported in 4.0.** `HostProxyRequest` carries no `notify` or `clipboardCopy` verb, and none is planned as a `HostProxyService` responsibility: the dispatcher (§10.10.1) is a detached background worker with no renderer and no controlling terminal, so it has nothing to relay a notification/clipboard write *to*; a container process that already has a PTY attached (an interactive `docker exec -t` / `lando shell` session) can emit terminal escape sequences (OSC 9/777/52 or any other protocol its own terminal supports) directly to its own inherited stdio without going through the host proxy at all, and a container process with no PTY has no terminal for any server-side response to write to either — so a cooperative "the host decides, the container asks" relay would not be a real security boundary in either case. §8.9.7 covers the one notification path 4.0 does ship: the *foreground* CLI process notifying about its own command.

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
- **Audited builds.** Every dispatch is appended to a tamper-evident append-only log.
- **Remote host transports.** Dispatch over a different transport (e.g., a teams-mode build that posts URLs to Slack instead of opening them locally).
- **Recording/test runs.** Capture every request for assertions; never call out to the real host.

Plugin implementations MUST pass the same contract suite as the default and MUST honor the allowlist cache; weakening the security posture of the default (e.g., disabling token auth) is forbidden and is checked by the contract suite.

---

### 10.11 Data movement and volumes

`DataMover` is the single chokepoint for **local/volume/service byte movement** — the on-host counterpart to the `HttpClient` egress chokepoint (§10.3.2). Every feature that moves bytes into or out of a named volume, a path inside a service, the host filesystem, or a built artifact goes through it: DB import/export, DB snapshot / fast-reset, the local landing half of hosting `pull`/`push`, scratch `--isolate=full`, disposable-toolbox seeding, and `image save`/`load`. Core ships exactly one implementation; the pluggable seam is the `RuntimeProvider` data plane (§5.3/§5.4), not `DataMover` itself (§4.2).

`DataMover` is **not** a sync engine (live bidirectional sync stays `FileSyncEngine`, §10.6) and **not** a remote transport (a `RemoteSource` plugin owns remote I/O via `HttpClient`; it uses `DataMover` only for the local extract/land half — §10.12).

`DataMover` moves opaque bytes and archives. `ManagedFileService` (§10.13) owns rendered, marked project files the user can adopt. Both primitives share the streaming-hash/atomic-write helper and the realpath-containment helper, but a settings file write never goes through `DataMover` and a DB dump never goes through `ManagedFileService`.

#### 10.11.1 The `DataEndpoint` model

Movement is expressed as a transfer between two typed endpoints. The union is the heart of the primitive; every feature is one `transfer(from, to)` or one `snapshot`/`restore`.

```ts
// @lando/sdk/schema/data-transfer.ts
export const DataEndpoint = Schema.Union(
  Schema.TaggedStruct("hostPath",    { path: AbsolutePath }),                   // dir or file tree
  Schema.TaggedStruct("hostArchive", { path: AbsolutePath, format: ArchiveFormat }),
  Schema.TaggedStruct("stream",      {}),                                       // in-process byte stream (Scope-bound)
  Schema.TaggedStruct("volume",      { app: AppId, store: Schema.String }),     // a DataStorePlan name
  Schema.TaggedStruct("servicePath", { app: AppId, service: ServiceName, path: PortablePath }),
  Schema.TaggedStruct("serviceCmd",  { app: AppId, service: ServiceName, command: CommandSpec }), // pipe in/out of a CLI
  Schema.TaggedStruct("artifact",    { ref: Schema.String }),                   // built image
);
export const ArchiveFormat = Schema.Literal("tar", "tar.gz", "tar.zst");
```

| Feature | Expressed as |
|---|---|
| `lando db export` | `transfer(serviceCmd(pg_dump) → hostArchive(.sql.gz))` |
| `lando db import` | `transfer(hostArchive(.sql.gz) → serviceCmd(psql))` |
| `lando db snapshot` / `restore` | `snapshot(volume(db-store))` / `restore(handle, volume(db-store))` |
| hosting `pull` (db / files) | `HttpClient.stream` → `transfer(stream → serviceCmd(psql))` / `transfer(stream → hostPath)` — but the local landing endpoint (which `serviceCmd`/`creds`, or which `hostPath`) is chosen by the app's resolved **`Dataset`** (§10.12), **not** hardcoded by the `RemoteSource`; `DataMover` only executes the transfer |
| scratch `--isolate=full` | `transfer(hostPath → hostPath)` (folds in the former `copyAppRoot`) |
| `image save` / `load` | `transfer(artifact ↔ hostArchive)` |

The `serviceCmd` endpoint relies on the existing `CommandSpec.stdinStream` / `execStream` contract (§5.3), so piping a dump into a CLI's stdin or capturing a CLI's stdout needs **no** new provider method — only the orchestrator.

#### 10.11.2 The `DataMover` service

```ts
export class DataMover extends Context.Service<DataMover, {
  readonly transfer:       (spec: DataTransferSpec) => Effect.Effect<DataTransferResult, DataMoverError, Scope.Scope>;
  readonly transferStream: (spec: DataTransferSpec) => Stream.Stream<DataTransferProgress, DataMoverError, Scope.Scope>;
  // snapshot sugar over a PathsService-resolved snapshot store indexed in a StateStore bucket
  readonly snapshot:       (store: VolumeRef, opts?: SnapshotOptions) => Effect.Effect<SnapshotHandle, DataMoverError, Scope.Scope>;
  readonly restore:        (handle: SnapshotHandle | SnapshotId, store: VolumeRef) => Effect.Effect<void, DataMoverError, Scope.Scope>;
  readonly listSnapshots:  (filter: SnapshotFilter) => Effect.Effect<ReadonlyArray<SnapshotInfo>, DataMoverError>;
  readonly removeSnapshot: (id: SnapshotId) => Effect.Effect<void, DataMoverError>;
  readonly pruneSnapshots: (policy: PrunePolicy) => Effect.Effect<ReadonlyArray<SnapshotId>, DataMoverError>;
}>()("@lando/core/DataMover") {}
```

Required behaviors:

- **Dispatch.** For `transfer(from, to)`, `DataMover` chooses the native `RuntimeProvider` data-plane method when the matching capability (§5.4) is `native`, else the generic helper-container fallback (mount the volume into a tiny helper image, stream `tar` through `run`/`runStream`), else fails `DataEndpointUnsupportedError` with remediation. `DataTransferResult.accelerated` reports which path ran; the §13.1 perf suite asserts the native path engaged when the capability is `native`.
- **Helper image.** The generic fallback resolves its `tar`-capable helper image from a pinned `{ image, digest }` (the §10.3.4 `ToolManifest` model, at the provider-image layer): resolved through `RuntimeProvider.pullArtifact`, digest-verified, cached, and offline-reused so the §1.4 offline contract holds once warm.
- **Streaming + interruption.** All moves are `Scope`-bound streams; `Effect.interrupt` propagates to the underlying `execStream`/`runStream` `kill()` and reaps children, identical to §5.3.
- **Verification.** Archive writes compute SHA-256 over the byte stream via the shared `@lando/sdk` streaming-hash helper that also backs `Downloader` (§10.3.3); `transfer` to a `hostArchive`/snapshot records the digest, and `restore`/`import` verifies it, failing `DataChecksumMismatchError`. There is no skip-verification flag.
- **Compression.** `tar.gz` / `tar.zst` via Bun-native streams; no external `gzip` binary.
- **Redaction.** Routed through the canonical `RedactionService` (§3.7) only — secrets/`${secret:…}` and host-home paths are redacted in events/logs/transcripts; DB credentials passed to a `serviceCmd` ride env, never argv.
- **Events.** Publishes the `Data` lifecycle scope (§3.5): `pre-data-transfer`, `data-transfer-progress`, `post-data-transfer`, `pre-volume-snapshot`, `post-volume-snapshot`, with redacted payloads.
- **Containment.** A `hostPath`/`hostArchive` whose realpath escapes the app root (or an explicitly opted-in base) is rejected with `DataSourceOutsideRootError`, mirroring §10.6 / `runScript`.
- **Idempotence.** `restore`/`import` into an existing volume requires `{ overwrite: true }` for destructive replace, else `DataTargetExistsError`; snapshot ids are content+timestamp derived.

#### 10.11.3 Snapshot store

The snapshot store is rooted at `appSnapshotsDir(appId)` (resolved by `PathsService`, §7.5.1; default `<userDataRoot>/snapshots/<app-id>/<store>/`) and **indexed in a `StateStore` bucket** (§12.7) — not a bespoke registry file — so it inherits atomic write, advisory lock, version header, and corruption quarantine.

```
<appSnapshotsDir>/<store>/<snapshot-id>.<format>   # archive (copy mode)
<appSnapshotsDir>/<store>/<snapshot-id>.json       # SnapshotInfo: digest, size, createdAt, label, native-ref?
```

A `volumeSnapshot: "native"` provider stores a `VolumeSnapshotRef` in the `.json` sidecar instead of an archive; `copy` mode stores the archive. `lando destroy --purge` removes an app's snapshot subtree; plain `destroy` keeps it (data-safety). `app:destroy --purge` and scratch teardown MAY take a safety snapshot first (opt-out), per the destructive-confirmation rule.

#### 10.11.4 Errors

Tagged errors live in `@lando/core/errors`:

- `DataTransferError` — a `transfer` failed for a reason not covered by a more specific tag.
- `DataEndpointUnsupportedError` — the `(from, to)` pair is not realizable on the active provider (missing capability and no fallback). Includes the pair and remediation.
- `DataChecksumMismatchError` — a restored/imported archive's SHA-256 did not match the recorded digest.
- `DataSourceOutsideRootError` — a host endpoint's realpath escaped the permitted base.
- `DataTargetExistsError` — a non-overwrite `restore`/`import` targeted an existing volume.
- `SnapshotNotFoundError` / `VolumeNotFoundError` — the named snapshot/volume does not exist.
- `ArchiveFormatError` — unsupported or corrupt archive format.

Provider-side data-plane failures surface as `VolumeOperationError` / `ServiceCopyError` / `ArtifactTransferError` (§5.7) and are wrapped by `DataMover` into the tags above with the provider cause attached.

#### 10.11.5 Contract suite

The §13.1 provider contract suite gains a data-plane section run against `TestRuntimeProvider` and every real provider: `importVolume(exportVolume(x)) == x`; `snapshot → mutate → restore` restores bytes; `copyTo`/`copyFrom` round-trips; `artifact` export/import round-trips; and capability honesty (a provider declaring `native` must not fall back). `@lando/core/testing` ships an in-memory `TestDataMover` and fixtures so embedding-host and `@lando/sql` unit tests need no real provider. Security tests cover path-escape rejection, checksum-mismatch rejection, and secret redaction in emitted events/transcripts.

### 10.12 Remote data sync (`RemoteSource` + `Dataset`)

Core owns the remote-sync intent, schemas, tagged errors, CLI/API shape, safety rules, the `Sync` lifecycle events, and the contract suites. Two §4.2 pluggable abstractions compose to do the work, and the split is the whole design: **`RemoteSource`** owns *where data lives and how to move it across the network* (the egress half), and **`Dataset`** owns *what a slice of app state is and how to capture/apply it locally* (the landing half). A portable artifact is the seam between them. This part is **contract-only for Beta 1** (frozen in PRD-17, mirroring the §10.2.2 `TunnelService` freeze); the bundled generic remotes, the first hoster plugins, the `database`/`files` `Dataset` implementations, and the real `app:pull`/`app:push` connector wiring ship in 4.1.

**Scope.** Remote sync moves **datasets — database, user files, and config — never application code.** Code is git's job (matching DDEV/Docksal). A `RemoteSource` that would write into the app's tracked source tree is rejected (`DatasetBindingError`). `pull` is destructive locally (overwrites a dataset); `push` is destructive remotely.

**Why two abstractions, not one monolithic hoster abstraction.** A monolithic hosting provider re-implements DB dump, file tar, gzip, progress, and redaction per provider — an N×M explosion. Splitting `Dataset` (a `database` dataset is identical whether the remote is Pantheon, rsync, or S3) from `RemoteSource` (an rsync transport works for DB *and* files) makes it N+M: a new hoster is one `RemoteSource`; a new dataset kind is one `Dataset`; they compose for free. "Hosting" is the marquee *category* of `RemoteSource`, not the contract name — the contract also covers rsync/ssh/s3/url/local and future peer/CI-artifact remotes.

```ts
export class RemoteSource extends Context.Service<RemoteSource, {
  readonly id: string;                              // "rsync" | "s3" | "pantheon" | "local" | ...
  readonly capabilities: RemoteCapabilities;        // { environments, push, datasets[], tool?, auth, protectedByDefault[] }
  readonly configSchema: Schema.Schema<unknown>;    // validates the Landofile `remotes.<name>` block
  readonly listEnvironments: (cfg: RemoteConfig) => Effect.Effect<ReadonlyArray<RemoteEnvironment>, RemoteError>;
  readonly resolve: (cfg: RemoteConfig, env: RemoteEnvId, datasetId: string) => Effect.Effect<RemoteLocator, RemoteError>;
  readonly fetch:   (locator: RemoteLocator, opts?: RemoteFetchOptions) => Effect.Effect<DataEndpoint, RemoteError, Scope.Scope>;  // REMOTE → portable artifact
  readonly send:    (locator: RemoteLocator, artifact: DataEndpoint, opts?: RemoteSendOptions) => Effect.Effect<void, RemoteError, Scope.Scope>; // portable artifact → REMOTE
  readonly test?:   (cfg: RemoteConfig, env?: RemoteEnvId) => Effect.Effect<RemoteTestResult, RemoteError>;
}>()("@lando/core/RemoteSource") {}

export class Dataset extends Context.Service<Dataset, {
  readonly id: string;                              // "database" | "files" | "config" | <plugin id>
  readonly kind: DatasetKind;                       // "database" | "files" | "config" | "blob"
  readonly capabilities: DatasetCapabilities;
  readonly artifactFormat: DatasetArtifactFormat;   // documented portable shape per kind
  readonly capture:    (ctx: DatasetContext, opts?: DatasetCaptureOptions) => Effect.Effect<DataEndpoint, DatasetError, Scope.Scope>; // LOCAL → portable artifact (via DataMover)
  readonly apply:      (ctx: DatasetContext, artifact: DataEndpoint, opts?: DatasetApplyOptions) => Effect.Effect<DatasetApplyResult, DatasetError, Scope.Scope>; // portable artifact → LOCAL (via DataMover)
  readonly localStore: (ctx: DatasetContext) => Effect.Effect<VolumeRef | null, DatasetError>; // so the orchestrator can auto-snapshot before apply
}>()("@lando/core/Dataset") {}
```

The portable artifact is a `DataMover` `DataEndpoint` (`stream` or `hostArchive`): `RemoteSource.fetch` produces it and `Dataset.apply` consumes it (pull); `Dataset.capture` produces it and `RemoteSource.send` consumes it (push). The `pull`/`push` orchestration lives in core (the `app:pull`/`app:push` commands and `App.pull`/`App.push` handle methods), not in either plugin.

Required behaviors:

- **Selection** follows §4.3: `<remote>[@<env>]` / `--remote`, then Landofile `remotes.<name>.source`, then sole installed implementation. No installed `RemoteSource` ⇒ `lando pull`/`push` fails with remediation.
- **Egress** (control-plane + byte fetch) MUST go through `HttpClient` (§10.3.2); a `RemoteSource` MUST NOT call `fetch` or open sockets directly, so proxy/CA/offline/redaction policy is inherited. Vendor CLIs (`terminus`, `platform`, `acli`, `lagoon`) MUST be acquired through the §10.3.4 tool-provisioning helper over `Downloader` with pinned `ToolManifest` entries; CLI processes run through `ProcessRunner` with redacted env and `Scope`-bound finalization.
- **Landing** MUST go through the resolved `Dataset` + `DataMover` (§10.11); a `RemoteSource` MUST NOT re-implement DB import or file extraction. The `Dataset` chooses the local endpoint (which `serviceCmd`/`creds`, or which `hostPath`); DB credentials ride env, never argv.
- **Safety.** Before `Dataset.apply` overwrites a local store, the orchestrator takes a `DataMover.snapshot(localStore)` unless `--no-snapshot`; pull confirms through `InteractionService` unless `-y`/`--no-interactive`. `push` is rejected when `capabilities.push` is false; pushing to an environment in `capabilities.protectedByDefault` requires `--force` plus typed confirmation of the env name.
- **State.** Remote configuration is Landofile-declared (`remotes:`, §7.4); any remote-resolution lockfile/marker rides a `StateStore` bucket (§12.7) — no bespoke registry. Roots resolve through `PathsService` (§7.5.1).
- **Readiness/retry** uses the §10.5.1 probe primitive; no hand-rolled retry loops.
- **Redaction.** Tokens, auth URLs, signed-URL query params, and host paths are redacted through `RedactionService` before any log/event/transcript/JSON/telemetry/durable-state write.
- **Machine output.** `lando pull`/`push`/`remote --format json` and `App.pull`/`App.push` return the universal machine-output/result schemas (§8.11); long-running foreground transfers emit `StreamFrame`s.
- **Events.** The `Sync` lifecycle scope (§3.5): `pre-/post-pull`, `pre-/post-push`, `pre-/post-dataset-capture`, `pre-/post-dataset-apply`, `pre-/post-dataset-fetch`, `pre-/post-dataset-send`. A pull/push is a `pre-/post-pull`/`-push` envelope around the composed `pre-/post-http-call` (§10.3.2) and `pre-/post-data-transfer` (§10.11) events; subscribers see the redacted payloads.

Tagged errors (`@lando/core/errors`): `RemoteError`, `RemoteUnreachableError`, `RemoteAuthError`, `RemoteEnvNotFoundError`, `RemoteDatasetUnsupportedError`, `RemoteProtectedEnvError`, `RemoteToolMissingError`; `DatasetError`, `DatasetCaptureError`, `DatasetApplyError`, `DatasetBindingError` (no local service bound, or a binding that would touch the code tree).

**Landofile surface** (§7.4): a top-level `remotes:` map (each entry validated by its source's `configSchema`) plus optional `sync:` dataset bindings; bindings are usually inferred (a `database` service-type auto-provides the `database` dataset bound to itself; framework presets auto-bind `files` to the upload dir). Commands: `app:pull` / `app:push` (top-level `pull` / `push`), `app:remote:list` / `:add` / `:remove` / `:test` / `:setup`, and `app:remote:env:list`.

This abstraction is **not** byte movement and **not** a tunnel: it composes `HttpClient`, tool provisioning/`Downloader`, `DataMover`, `StateStore`, the probe primitive, `InteractionService`, `SecretStore`, and `RedactionService`. The §13.1 `RemoteSource` and `Dataset` contract suites pin every guarantee above; `@lando/core/testing` ships an in-memory `TestRemoteSource` (and a `local` source) plus `TestDataset` so the surface is testable without a real hoster or network.

### 10.13 Managed files

`ManagedFileService` is the single chokepoint for Lando-owned writes into the user's working tree: files the user sees, commits, edits, and may adopt (`settings.php`, `wp-config.php`, `.env`, `.devcontainer/devcontainer.json`, or a generated Landofile fragment). It is the working-tree peer of `DataMover` (§10.11): `DataMover` moves opaque local/volume/service/archive bytes, while `ManagedFileService` renders content, encodes structured formats, applies ownership markers, records a `StateStore` ledger, detects drift/adoption, and refuses to silently clobber a user edit.

Core ships exactly one implementation. The service is host/test-overridable but is **not** a §4.2 plugin contribution surface (§4.2): plugins write managed files only through the pre-namespaced `LandoPluginContext.managedFiles` accessor (§9.8). It composes existing primitives instead of inventing new ones: `StateStore` (§12.7), `PathsService.managedFileLedger(appId)` (§7.5.1), the shared streaming-hash/atomic-write helper and realpath-containment helper factored for PRD-16, `RedactionService` (§3.7), `EventService` redacted history (§11.1), and the `@lando/sdk/landofile` serializer (§7.8.1).

#### 10.13.1 The `ManagedFile` model

Managed-file intent is declarative. A caller supplies one or more `ManagedFile` entries and the service plans or applies them against a resolved base (app root by default):

```ts
export const ManagedFile = Schema.Struct({
  id: Schema.String,                         // "drupal:settings"
  owner: Schema.String,                      // recipe/plugin/core id
  path: PortablePath,                        // relative to base
  mode: Schema.Literal("file", "block", "keys"),
  format: FileFormat,                        // text | env | json | yaml | toml | ini | landofile | javascript | typescript
  content: ContentSource,                    // text | structured | template | inline
  marker: Schema.optional(Schema.String),    // defaults to id
  perms: Schema.optional(Schema.String),     // octal
  onConflict: Schema.optional(Schema.Literal("skip", "overwrite", "fail")),
  base: Schema.optional(AbsolutePath),
});
```

`ContentSource` is a tagged union:

| Tag | Meaning |
|---|---|
| `text` | Already-rendered string/bytes, encoded as-is for `format` |
| `structured` | JSON-like data encoded by the shared codec for `env`/`json`/`yaml`/`landofile` |
| `template` | Template file + vars rendered through `TemplateRenderer` before encode |
| `inline` | Inline template string + vars rendered through `TemplateRenderer` before encode |

Modes:

- `file` owns the whole file and writes the ownership marker at the top (or ledger + optional `x-lando-generated` for JSON).
- `block` owns only a fenced region (`# >>> lando:<id> >>>` … `# <<< lando:<id> <<<`) inside a user-owned file and replaces only that region.
- `keys` owns a structured subtree in `json`/`yaml`/`landofile`; the model reserves it, but the structural merge consumer is 4.x.

The codec module is pure and shared with the §6.4 mount materializer. `landofile` and `yaml` delegate to the canonical `@lando/sdk/landofile` serializer so there is one Landofile round-trip implementation.

#### 10.13.2 The `ManagedFileService` service

```ts
export class ManagedFileService extends Context.Service<ManagedFileService, {
  readonly plan:    (files: ReadonlyArray<ManagedFile>) => Effect.Effect<ManagedFilePlan, ManagedFileError>;
  readonly apply:   (files: ReadonlyArray<ManagedFile>, opts?: ApplyOptions) => Effect.Effect<ManagedFileResult, ManagedFileError, Scope.Scope>;
  readonly remove:  (selector: ManagedFileSelector) => Effect.Effect<ManagedFileResult, ManagedFileError>;
  readonly status:  Effect.Effect<ReadonlyArray<ManagedFileInfo>, ManagedFileError>;
  readonly adopt:   (path: PortablePath) => Effect.Effect<void, ManagedFileError>;
  readonly release: (path: PortablePath) => Effect.Effect<void, ManagedFileError>;
}>()("@lando/core/ManagedFileService") {}
```

Required behaviors:

- **Bootstrap.** `ManagedFileServiceLive` is available at level `minimal` and `Layer.suspend`-wrapped. Constructing the layer MUST NOT touch the provider, the network, or plugin modules.
- **Plan/apply agreement.** `plan(files)` is side-effect-free and produces per-file actions (`create`, `update`, `skip-unchanged`, `skip-adopted`, `conflict`, `adopt-detected`). `apply(files)` honors that plan and reports what it actually did.
- **Rendering and encoding.** Template sources render through `TemplateRenderer`; structured sources encode through the shared codec module; `toml`/`ini` may fail with a `format` remediation until 4.x.
- **Atomicity.** Every write goes through the shared streaming-hash/atomic-write helper (temp → fsync → rename; temp removed on interrupt/failure). A crash or `Effect.interrupt` never leaves a torn live file.
- **Containment.** The resolved file realpath MUST stay under `base` (app root by default). Symlink escapes and `../` escapes fail with `ManagedFileError reason:"path"` via the shared containment helper.
- **Events.** The `ManagedFile` lifecycle scope (§3.5) publishes `pre-managed-file-write`, `post-managed-file-write`, `managed-file-conflict-detected`, and `managed-file-skipped`. Payloads carry path/owner/action/summary only, never file content, and are routed through `RedactionService` before publish/history/transcript.
- **Removal/adoption.** `remove(selector)` deletes only files/blocks the ledger records as Lando-owned. `adopt(path)` / `release(path)` flip ledger ownership state and `adopt` strips the marker so future applies skip.
- **Plugin and host exposure.** Plugins receive a `managedFiles` accessor on `LandoPluginContext` (§9.8) pre-namespaced to the plugin's `owner` id: every write is recorded with `owner:<plugin-id>`, `status` is filtered to that owner, and a cross-owner `remove`/`adopt`/`release` (or a write declaring a foreign owner) is refused with `ManagedFileError reason:"conflict"`. Embedding hosts resolve the `ManagedFileService` tag from `makeLandoRuntime` (exposed from level `minimal`) and operate under an isolated `base` (app root).

#### 10.13.3 Marker, StateStore ledger, and decision algorithm

The inline marker is the user-facing adoption affordance. Deleting the marker means Lando stops touching the file. Per-format comment syntax is used where possible; JSON relies on the ledger plus an optional `x-lando-generated` field because JSON has no comments.

The ledger is a `StateStore` bucket, not a bespoke file:

```ts
stateStore.open({
  root: "userData",
  namespace: `managed-files/${appId}`,
  key: "ledger.json",
  codec: "json",
  lock: "advisory",
  onCorrupt: "quarantine",
  version: 1,
});
```

The default concrete path is `<userDataRoot>/managed-files/<app-id>/ledger.json`, resolved through `PathsService.managedFileLedger(appId)` (§7.5.1). Each entry records `{ id, owner, path, mode, format, marker, lastWrittenChecksum, sourceHash, state, backup?, createdAt, updatedAt }`. The ledger is local and rebuildable: marked files in the working tree are the committed source of truth.

Decision table:

| Current state | Action |
|---|---|
| Path does not exist | `create` — write desired content + marker + ledger |
| Exists, no marker, no ledger entry | `skip-adopted` — pre-existing user file; record adopted |
| Marker present, ledger checksum equals current bytes, desired `sourceHash` unchanged | `skip-unchanged` |
| Marker present, ledger checksum equals current bytes, desired `sourceHash` changed | `update` |
| Marker present, ledger checksum differs from current bytes | `conflict` — default `onConflict:"skip"` warns/skips; `overwrite` backs up then updates; `fail` errors |
| Ledger state is `adopted` | `skip-adopted` |
| Marker was removed from a previously managed file | `adopt-detected` then `skip-adopted` |

This is safer than DDEV's `#ddev-generated` rule: an in-place user edit under a still-present marker is detected through the ledger checksum and is a conflict by default, not a silent overwrite.

#### 10.13.4 Errors

The service exposes one tagged error, `ManagedFileError`, with a discriminator and operation context:

```ts
type ManagedFileError = {
  readonly _tag: "ManagedFileError";
  readonly reason: "io" | "decode" | "conflict" | "path" | "format";
  readonly operation: "plan" | "apply" | "remove" | "status" | "adopt" | "release";
  readonly path?: string;
  readonly cause?: unknown;
  readonly remediation?: string;
};
```

`conflict` identifies a protected in-place edit; `path` covers realpath-containment failures; `format` covers unsupported codecs or deferred `keys`-mode merges; `decode` covers invalid existing structured content; `io` covers filesystem, permission, and ledger access failures. Error payloads are redacted before reaching events, logs, transcripts, or JSON output.

#### 10.13.5 Contract suite

The §13.1 managed-file contract suite is StateStore-style: it protects a core integrity invariant rather than a §4.2 plugin abstraction. It runs against `ManagedFileServiceLive`, `TestManagedFileStore`, and host/test overrides. It asserts create/update/skip-unchanged/skip-adopted/conflict/adopt/release/remove; `plan` matches `apply`; atomic replace leaves no torn file under `Effect.interrupt`; path escapes are rejected; markers round-trip per format; `block` mode is idempotent; ledger corruption uses `StateStore` quarantine semantics; and a known secret never appears in emitted events/history/transcripts. The §13.4 `check:managed-file-boundary` gate forbids parallel host-project-file writers with their own marker/overwrite logic outside `core/src/managed-file/**` and named consumers.

### 10.14 MCP server (`McpService`)

`McpService` is the in-process **Model Context Protocol server**: the subsystem behind `lando mcp` (§8.2.6) that exposes Lando's command surface to AI agents as typed, discoverable MCP tools. It exists because the agent-native tenet (§1.2) makes agents a first-class operator: the machine-output contract (§8.11) already gives every command a schema-backed result; `McpService` is the thin dispatch layer that publishes those commands *as* an agent protocol instead of leaving agents to shell out and scrape.

Design rule: **MCP is a projection, not a parallel surface.** The server owns no command logic, no second result encoding, and no bespoke tool list. Everything it serves is derived from canonical registries:

- **Tools** are generated from the `LandoCommandSpec` registry (§8.3): one tool per allowlisted canonical id. Tool input schemas derive from the command's `FlagSpec`/`ArgSpec` set; tool results are the command's `CommandResultEnvelope` (§8.11.1) encoded through the single `encodeCommandResult` seam — redaction included. Streaming commands surface their `StreamFrame`s as MCP progress notifications terminated by the result envelope.
- **Tooling tasks** (§8.5) are optionally projected as tools (config `mcp.tooling`, flag `--tooling`), dispatched through `runTooling` (§16.7).
- **Resources** expose read surfaces an agent needs for grounding: the resolved Landofile (`app config view --source resolved` shape), `app:info --deep`, `apps:list`, and the doctor report. Resource payloads are the same schemas the corresponding commands emit.
- **Notifications** replay redacted lifecycle events from the `EventService` bounded history (§11.1) for the apps a session touches; they are not a second event tap.

```ts
export class McpService extends Context.Service<McpService, {
  readonly serve: (options: McpServeOptions) => Effect.Effect<void, McpError, Scope.Scope>;
  readonly catalog: (options?: McpCatalogOptions) => Effect.Effect<McpCatalog, McpError>;  // the `--list` shape
}>()("@lando/core/McpService") {}
```

Required behaviors:

- **Transport.** stdio in v4.0; the dispatch core is transport-agnostic and a streamable-HTTP transport is deferred post-v4.0 (the architecture MUST NOT preclude it). Inbound stdio is not network egress; any *outbound* HTTP a future transport or capability performs MUST flow through `HttpClient` (§10.3.2) — this is the "in-process MCP surface" consumer already named there.
- **Retained runtime.** `serve` holds one retained `LandoRuntime` for the session and dispatches tool calls through the `@lando/core/cli` command operations (§16.7), exactly like the host-proxy dispatcher (§10.10.1). Successive tool calls hit the §2.1 hot-path budgets, not cold start. App resolution per call follows `resolveApp`/`AppSelector` (§16.3) against the tool call's declared app path or the serve-time cwd.
- **Allowlist enforcement.** The effective tool set is the generated `mcp-allowlist` cache (from `mcpAllowed: true` specs, §8.3) plus `mcp.allow` (§7.5) and `--allow`, minus `mcp.deny` / `--deny`. Requests for ids outside the effective set are rejected with `McpToolNotAllowedError`. Destructive command ids are never default-allowed and carry MCP's destructive-operation annotation when explicitly enabled.
- **Non-interactive by construction.** Tool dispatch runs with `interaction: "non-interactive"` (§8.10.3); a command that would prompt fails with its standard missing-answer tagged error rather than hanging the protocol. Confirmation-gated commands require their `--yes`-equivalent input field to be set explicitly by the client.
- **Concurrency and cancellation.** In-flight tool calls are capped (default 4, config `mcp.maxConcurrent`); each call runs in its own fiber, MCP cancellation requests map to `Effect.interrupt`, and closing the transport interrupts the serve scope — every in-flight call finalizes through its `Scope`.
- **Redaction and serialization bound.** Every tool result, resource payload, and notification passes through `RedactionService` (§3.7) before any serialized JSON string is retained. Each result envelope, progress payload, and complete JSON-RPC frame MUST fit an **8 MiB (8,388,608-byte) UTF-8 serialization limit** enforced while traversing data; implementations MUST fail with `McpTransportError` before retaining an over-limit serialization and MUST NOT invoke application-defined getters or `toJSON` hooks while enforcing the bound. The contract suite asserts known secret keys and values never cross the transport.
- **Events.** The server publishes `pre-mcp-call` / `post-mcp-call` lifecycle events for every dispatch (including rejected ones) with redacted payloads: tool id, canonical command id, app ref summary, duration, and tagged failure detail.
- **Not proxied, not scaffolded.** `meta:mcp` is excluded from the host-proxy `runLando` allowlist and the recipe post-init allowlist (§8.3); a container or recipe MUST NOT be able to start a host MCP server.
- **Doctor.** `lando doctor` includes an MCP check: allowlist cache fresh, catalog generates cleanly, and a canary tool round-trip against the test runtime succeeds.

Tagged errors: `McpToolNotAllowedError` (id outside the effective allowlist; payload lists the effective set source), `McpToolInputError` (input failed the derived schema decode; carries the flag/arg path), `McpTransportError` (stdio framing/protocol failure), `McpAllowlistConflictError` (a destructive built-in declared `mcpAllowed: true` at registration), plus pass-through of the dispatched command's own tagged errors inside the result envelope (`ok: false`), which is not an MCP-level failure.

`McpService` is **core-owned and not plugin-replaceable in v4.0** (like `DataMover`, §10.11): the pluggable seams are the allowlist flags on command specs, the `mcp.*` config keys, and the fact that plugin-contributed commands with `mcpAllowed: true` project into the catalog automatically. A `mcpServers:`-style plugin contribution surface is deferred until real demand exists (§14.2 discipline).

The §13.1 MCP contract suite exercises: catalog generation matches the allowlist caches; tool input schemas round-trip against `FlagSpec`/`ArgSpec`; a success and a failure dispatch both return schema-valid envelopes; deny wins over allow; destructive-id self-allow rejection; non-interactive prompt failure; cancellation mid-call; concurrency cap; and redaction.

---
