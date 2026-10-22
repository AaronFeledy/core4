# Lando v4: Subsystems

> **Part 11 of 19** · [Index](./README.md)
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

- The default local domain is global `proxy.defaultDomain`, which defaults to `lndo.site`. Generated default route hostnames and their certificate SANs use it for user and global apps, and a change to it invalidates cached plans.
- `RoutePlan` supports hostnames, wildcard hostnames, ports, paths, TLS intent, and filters. Route status appears in `lando info` and post-start output.
- `proxy.defaultDomain` supports offline and custom-domain workflows. Public DNS answers `*.lndo.site` with `127.0.0.1`. Lando writes no host DNS, so offline hosts, resolvers that drop loopback answers, and custom domains need resolution configured outside Lando.
- Router plugins reconcile stale routes on rebuild and destroy. `stop` durably removes all app route definitions without stopping unrelated global services; `status` reports that durable state.
- `RouteFilter` contributions translate provider-neutral filters. Bundled filters are `stripPrefix`, `addPrefix`, `requestHeader`, `responseHeader`, `redirect`, `rewritePath`, `auth.basic`, and `rateLimit` (§6.6). Non-empty filter overlays merge by `name`, then unnamed type identity, and retain authored order; an explicitly empty overlay clears inherited filters (§7.2). Path routes MUST NOT strip implicitly.
- `router.enabled: false`, resolved by normal precedence (§7.4, §7.5), MUST prevent router startup and publication for the app. `lando info` reports only published endpoints.
- A router MUST set `X-Lando-Router: <reason>` (`no-route`, `upstream-unreachable`) on every error response it generates itself, and MUST NOT set it on a response proxied from a service, so `http` checks attribute router pages to Lando (§10.5.2).
- Route priority is one shared space across every app, derived from the route alone under §6.6. A router that publishes its own routers (dashboard, diagnostics, fallback) MUST pin them outside the app bands defined there: diagnostic fallbacks at `ROUTE_PRIORITY_DIAGNOSTIC`, router-owned hostnames above `ROUTE_PRIORITY_MAX`. Otherwise an app that claims the same hostname captures them.
- `RouterService.revalidateStartup` re-observes the running router's startup against its live state and refreshes whatever persisted startup observation the implementation keeps. It is distinct from `setup`: it acquires no ports, starts no services, and takes no `Scope`. It fails with `ProxyError` or `RouterWatcherError`. An unavailable router implements it as a no-op, so a record left by an earlier router stays reported until a selected router revalidates it.
- `applyRoutes` and `removeRoutes` MUST NOT require `setup` in the same process. Global lifecycle commands publish routes without it (§20.6.5), so `applyRoutes` reports authorities and maintains TLS for the router state the last `setup` established.
- A remediation MUST NOT name a command that cannot affect the condition it diagnoses. Every operation named as a recovery step for a router diagnostic (`lando global:restart`, `lando global:rebuild`, `lando setup`, `lando doctor --fix`) MUST run `revalidateStartup` on success so a cleared condition clears its record (§20.6.5).

#### 10.2.1 Default global-app realization

The `@lando/proxy-traefik` router layer realizes routing through the global app's `traefik` service (§20). The plugin MUST contribute paired `routerServices:` and `globalServices:` entries; otherwise plugin loading fails with `ProxyContributionPairError`.

`setup`, after ensuring the global router is running, and `revalidateStartup`, which only observes it, poll both advertised ports through `runProbe` until both answer HTTP or a 10-second overall deadline expires; this readiness check never decides port availability (§10.2.3). Expiry publishes a warning, not a failure. A warning from `revalidateStartup` MUST NOT recommend `lando global:restart` or `lando global:rebuild`, which just ran; it names `lando global:logs --service=traefik` and `lando global:info` instead.

- `applyRoutes` persists plugin-owned dynamic configuration in a Lando-managed mount; `setup` calls `GlobalAppService.ensureRunning(["traefik"])`. `setup` persists the configured default domain beside the port-acquisition state, and a process that has not run `setup` reads both before applying routes.
- The router plugin is the only writer of the dashboard configuration, which serves `traefik.<domain>` over HTTP and HTTPS above `ROUTE_PRIORITY_MAX`. `prepare`, `setup`, and `applyRoutes` reconcile it with the router's default domain, so a domain change applies without recreating the router; `stop` removes it with the rest of the router's dynamic configuration. The fallback certificate covers `*.<domain>`, `<domain>`, and `traefik.<domain>`.
- `setup` and `revalidateStartup` read the router's startup log once, classify file-watcher failures (`inotify-limit`, `disk`, `permission`, `other`), and either clear or rewrite a persisted watcher-diagnostic record under the global app root. A classified failure fails with `RouterWatcherError` carrying `failureClass`, `watcherHost`, redacted `detail`, and ordered remediation. `stop` removes the record. The `router-file-watcher` doctor check reports the record as an unrevalidated observation and never clears it or probes live.
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

The default router publishes one host-global HTTP/HTTPS pair on `127.0.0.1`; URLs omit ports `80` and `443`. Ports come from fixed ordered per-protocol candidate lists, with the first available candidate winning. TCP bind outcomes determine availability, subject to the router-ownership and socket-helper rules below; HTTP reachability MUST NOT determine availability.

- The HTTP order is `80`, `8080`, `8000`, `8888`, `8008`, `38080`; HTTPS is `443`, `8443`, `4443`, `4433`, `4444`, `444`, `38443`.
- Global and Landofile `router:` support `enabled`, `bindAddress`, `httpPort`, `httpsPort`, `httpFallbacks`, and `httpsFallbacks`; env keys are `LANDO_ROUTER_HTTP_PORT`, `LANDO_ROUTER_HTTPS_PORT`, `LANDO_ROUTER_BIND_ADDRESS`, plus JSON-document fallback setters.
- `httpPort` and `httpsPort` replace preferred candidates; fallback arrays replace remaining candidates; an empty fallback list means preferred-only.
- Precedence is compiled defaults, global `router:`, env, then Landofile `router:`. `pluginConfig."@lando/proxy-traefik"` MUST NOT duplicate this surface.
- App-specific pins MUST NOT replace an already-running router's persisted pair. An app-specific mismatch fails with a tagged error and remediation to align the pin with the running pair, or to set it in installation config and run `lando setup`. Global restart never re-acquires ports (§20.6.5).
- The chosen pair is the only Traefik host publish. App start, including its router setup step, and scratch startup reuse an owned persisted pair while its bind address and preferred candidates are unchanged and both selected ports remain candidates; otherwise acquisition rescans. Explicit `lando setup` MUST pass `reacquirePorts` to router setup, which then always rescans.
- During a rescan, an `EADDRINUSE` candidate MUST count as available when provider ownership verification shows the global app's `traefik` service publishes it; missing or failed verification keeps it occupied.
- Privileged-port `EACCES` MAY use the socket helper and then the same ordered high-port candidates. A healthy peer Lando router MUST NOT be treated as stale `rootlessport`.
- Exhaustion fails closed with the attempted ports; silent disablement is forbidden.
- Fallback selection MUST notify at acquisition, naming occupied preferred ports, chosen ports, identifiable holders, and `lando info`. The doctor recovery for a fallback pair is to free the preferred ports, then run `lando setup`.
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

All Lando-owned egress MUST work behind corporate HTTP(S) proxies and custom CA chains, including runtime, plugin, include, recipe, update, telemetry, helper, tunnel, check, MCP, and provider-initiated artifact traffic. In-service trust inheritance is owned by §6.8.

- The canonical network-trust resolver is a pure `@lando/sdk` module consumed by `HttpClient`, providers, `lando setup`, `BunSelfRunner`, and the external-tool exception below. `BunSelfRunner` is the only package-manager exception to the `HttpClient` path.
- External-client exception: declared host `git`, `ssh`, `rsync`, vendor CLIs, and Dataset database/object/file clients MAY use their native transports. Host execution MUST use scoped `ProcessRunner`; service execution MUST use scoped provider execution (§10.12.4). Output MUST be redacted before events, logs, receipts, or errors.
- External clients MUST apply resolved trust and proxy policy through protocol-supported settings. HTTP tools MAY use `HTTPS_PROXY`, `NO_PROXY`, or CA variables; SQL and SSH MUST NOT be assumed to honor them. A required policy without a native proxy/tunnel equivalent MUST fail with remediation, never silently bypass it.
- TLS clients MUST verify the original server identity and SSH clients MUST retain strict host-key verification, even when forwarding changes the dial host. Declared data clients MUST be cancellable and MUST NOT become an unrestricted alternate control-plane HTTP path.
- Explicit global `network.proxy` precedes `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`.
- Global `network.ca.certs` and `LANDO_NETWORK_CA_CERTS` add CAs; `network.ca.trustHost: true` uses supported host trust stores.
- `network.ca.injectIntoServices` defaults to `true`; `network.proxy.injectIntoServices` defaults to `false`. They are independent and may be overridden per service (§6.8).
- Setup MUST validate trust before long downloads and provide remediation for interception, authentication, missing CA, and blocked registries. It SHOULD report active CA injection for `type: lando` services.
- Providers receive resolved trust independently of service-injection flags. Project `security.ca:` is additive and MUST NOT replace machine-local `network.ca`.
- Host-global arbitrary Dockerfile/build-context injection is a non-goal.
- Proxy credentials MUST be redacted from logs, telemetry, diagnostics, lockfiles, and cache metadata.
- Offline-capable commands MUST use valid local state without contacting unavailable trust endpoints (§12.6).

#### 10.3.2 Outbound HTTP (Effect `HttpClient`)

Lando's HTTP client is Effect's standard `effect/http` `HttpClient` contract, not a Lando-owned interface (§3.4). `@lando/http-client` is the sole Lando-owned implementation and the single network-egress boundary: it builds the client with `HttpClient.make` over Bun fetch egress and is the only package permitted to call global `fetch` or import Effect's `FetchHttpClient`. Consumers use the standard `HttpClient`, `HttpClientRequest`, and `HttpClientResponse` surface (buffered bodies, byte streams, and request bodies are the contract's own operations); Lando defines no parallel request, response, stream, upload, or capability schemas. Plugins receive the host client through `LandoPluginContext.httpClient` and MUST NOT construct their own transport or trust wiring. `BunSelfRunner` remains the package-manager exception.

- Per-request Lando policy is fiber-scoped through the `RequestPolicy` reference (`@lando/http-client`): `callerId`, `onBehalfOf`, `redactionTokens`, `allowFileSource`, `offline`, and `redirect`. Policy is provided by the requesting fiber, not baked into the client layer.
- Trust resolution follows §10.3.1 and is performed per request from `ConfigService` unless a caller supplies an already-resolved `NetworkTrust` override. On Windows, host trust is merged with resolved CAs. Trust failures surface as `HttpTrustError` (`kind`: `proxy-authentication`, `tls-interception`, `missing-custom-ca`, `blocked-endpoint`) carried as the transport cause inside the standard `HttpClientError`.
- Only `http:` and `https:` are open schemes. `file:` is accepted only when `allowFileSource` is set and is limited to the documented development/CI overrides in §10.3.3; every other scheme fails before connection.
- Response bodies stream; nothing buffers a full body unless the caller asks the standard contract to.
- Credentials, URL userinfo, query values, and supplied redaction tokens MUST be redacted before a URL reaches an event, span attribute, log, or error. Each request is a span named `HttpClient.request` with method and redacted URL attributes; the standard client's own URL-bearing spans are disabled.
- Calls publish `pre-http-call` and `post-http-call` carrying origin, method, redacted caller correlation, duration, status, and redacted failure detail; downloader-originated calls retain download correlation and MUST NOT be double-counted. Events are published once per request, including on failure and interruption.
- Interrupt aborts the connection and scope finalization completes the post-call event; the layer is inert at construction.
- `offline: true` fails before opening a connection.
- Retry/wait policy belongs to bounded `runProbe`; artifact verification belongs to `Downloader`. A caller MAY honor `Retry-After` on `429`/`503` only for safe/idempotent requests or vendor-deduplicated mutations with the same idempotency key. Delay MUST fit the remaining budget; unsafe replay MUST fail or reconcile the original operation handle.
- The client MUST NOT automatically replay every `429`/`503`. Retry and rate-limit headers remain on the standard response/error surface and MUST be sanitized before diagnostics; no parallel `HttpClient` contract is introduced.
- `httpClients:` plugin contributions provide the same `effect/http` `HttpClient` and MUST pass the `@lando/sdk/test` contract suite (`runHttpClientContract`) covering proxy/CA precedence, schemes, streaming, offline behavior, cancellation, events, and redaction. They MUST NOT weaken trust, redaction, scheme policy, or cancellation. `@lando/core/testing` supplies the in-memory test client.

The Lando-owned tagged error is `HttpTrustError`; every other failure is the standard `HttpClientError` family.

#### 10.3.3 Verified downloads (`Downloader`)

`Downloader` consumes `HttpClient` and owns `DownloaderCapabilities`, `DownloadRequest`, `DownloadResult`, `DownloadError`, `ArtifactManifestEntry`, verification, atomic persistence, cache/offline behavior, and progress. All Lando-owned artifact downloads MUST use it.

- Production manifests MUST use HTTPS. `file://` requires explicit `allowFileSource` and is limited to documented development/CI overrides such as `LANDO_RUNTIME_BUNDLE_MANIFEST` (§5.8.1).
- Egress MUST stream through the standard `HttpClient` (§10.3.2); downloader implementations MUST NOT open sockets or duplicate trust resolution.
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

#### 10.3.5 Browser authorization (loopback PKCE and device flow)

`@lando/sdk/oauth` supplies fixed helpers, not a service tag. Sources MUST declare a supported flow (§10.12.3); helpers MUST NOT invent unattended authentication.

- `runLoopbackAuthorization` MUST bind `127.0.0.1` on an ephemeral port before opening the browser, use S256 with fresh verifier/state, validate callback host/path/state, accept one callback, and exchange the authorization code through `HttpClient` at declared trusted endpoints. Completion, timeout, and interruption MUST close the listener.
- `runDeviceAuthorization` MUST use the device authorization grant, not the authorization-code grant or a client-secret substitute. It MUST display the user code and verification URL only on the explicit interactive authorization surface, poll through bounded `runProbe` at the granted interval with `slow_down`, and stop on expiry, completion, or interruption. A user MAY complete it in a browser on another device.
- User codes and verification URLs MUST NOT enter durable events, logs, transcripts, telemetry, or retained results. Device codes, authorization codes, verifiers, tokens, and sensitive callback/browser URLs MUST NOT enter any diagnostics. Opener and HTTP events MUST carry only sanitized correlation, never these values.
- Durable user/refresh grants MUST persist only through §9.5.1; access tokens MUST remain memory/session-only. Non-interactive callers MUST reuse existing authorized references or fail before either helper starts; a remote terminal with an explicit human interaction surface is not unattended auth.
- Events remain sanitized `pre-open-url`/`post-open-url` and `pre-http-call`/`post-http-call` (§3.5). `BrowserAuthorizationError` reasons are `timeout`, `state-mismatch`, `denied`, `listener`, and `expired`.

### 10.4 SSH and host identity

- SSH agent access is forwarded by provider capability, never by copying key files into a service. There is no Landofile `keys` surface: the sidecar loads the default keys under `~/.ssh`, and hardware-backed or 1Password keys use host mode.
- Passphrase-protected keys use an active agent when available.
- Known host identity is injected as `LANDO_HOST_USER`, `LANDO_HOST_UID`, `LANDO_HOST_GID`, and `LANDO_HOST_HOME`; platform/provider limitations MUST be explicit.
- The `lando.ssh-agent` feature (priority 1200, §6.11.4) applies to every `type: lando` service in both modes and sets `SSH_AUTH_SOCK=/run/lando/ssh-agent/agent.sock`. There is no per-service `sshAgent` key.
- `sshAgent` is an object `{ sidecar?: boolean, socket?: string }` accepted at the Landofile top level and in global config (§7.5). Each field resolves Landofile, then global config, then default. The default is `sidecar: true`: the Lando-managed `ssh-agent` global service (§20.4) runs `ssh-agent` and loads `~/.ssh` keys through `ssh-add`; the managed provider hosts it even when the app uses another provider.
- The bundled sidecar MUST acquire its agent and relay tools during the global artifact build, not at container start. With unchanged inputs and complete local artifacts and build cache, later sidecar starts MUST NOT download those packages.
- `sshAgent.sidecar: false` selects host mode: the app forwards a host agent instead of the sidecar, so hardware-backed and third-party agents (1Password, gpg-agent, yubikey-agent, FIDO2 `sk` keys) sign inside the host process. An explicit `sshAgent.socket` MUST be a socket (symlinks are rejected) and fails closed when it is unusable; discovery never falls through past it. Otherwise candidates are tried in this order: `SSH_AUTH_SOCK`, the 1Password agent path for the platform (`~/.1password/agent.sock` on Linux, `~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock` on macOS), `gpgconf --list-dirs agent-ssh-socket`, `$XDG_RUNTIME_DIR/yubikey-agent/yubikey-agent.sock`, then the Windows named pipe `\\.\pipe\openssh-ssh-agent`. The first candidate that accepts a connection and answers an SSH agent identities request wins.
- Delivery is one contract in both modes: a per-app relay owns a stable app-scoped directory that the provider makes visible to the service (§5.4 `agentSocket`, §5.3 `openAgentSocketBridge`), and the container sees `/run/lando/ssh-agent/agent.sock`. The relay is a raw byte stream between the container socket and the upstream (host agent or sidecar socket); it is never the host socket bound directly into a service. Replacing the relay socket MUST NOT recreate the container, because the mount is the directory, not the socket.
- The planner records only the eligible services and the selected mode (plan extension `@lando/core/ssh-agent`, `{ mode: "sidecar" | "host" }`). The upstream path, relay directory, and `SSH_AUTH_SOCK` mount are a start-time overlay applied by the start, restart, and rebuild operations, like the §10.10 host-proxy overlay, and MUST NOT enter the plan cache or the recorded applied plan. The relay, guest bridge, and socket directory are app-owned once acquired and recorded: retained after apply whether or not the start finishes, closed on stop, destroy, or replacement. Only an acquisition that was never recorded or validated (a worker without a completed handshake or ownership record) is acquisition-local and closes with the failed attempt.
- Start and `rebuild -s` reuse a running relay worker instead of replacing it when its owner-only record (§12.4) and an authenticated identify over its loopback control port (control token) agree on the app id and root, the relay kind, the session id, the pid, the worker protocol version, and the configuration digest. The digest covers the app identity, the plan id and provider, the kind, the upstream, the delivery, the socket name, the Lando roots, and the worker entry, so a changed upstream (for example a new `SSH_AUTH_SOCK`) or delivery replaces the relay. Directory delivery also requires an owned socket (not a symlink or regular file) in the relay directory; a guest-bridge endpoint the host cannot see therefore replaces. A dead worker, a changed configuration, a missing endpoint, or an older-protocol worker (identified through its authenticated control port, then terminated by pid) is replaced. Replacement keeps the mounted socket and keyring directories and swaps only the socket inside them, so containers are never left holding a deleted directory. A foreign, corrupt, or non-private record, or a live worker that fails authentication, keeps the existing fail-closed `SshAgentTransportError` (`stage: "worker"`): Lando neither signals that process nor starts a second relay over it. A reused relay keeps its directory, so containers are untouched. Failure-time ownership follows acquisition: a relay that was reused or started and recorded stays owned by the app when the start later fails or is interrupted at any phase (§6.7), and forwarding stays enabled until stop or destroy; a worker that never validated its handshake or wrote its ownership record is closed with the attempt. The control token is registered with `RedactionService` (§3.7).
- Failure policy follows consent. Sidecar setup and doctor repair diagnostics MUST expose a redacted underlying failure reason when available. Sidecar mode (the default) is best-effort. After the `agentSocket` capability check, the start, restart, and rebuild operations MUST check the sidecar's agent at start-time overlay resolution; when it does not answer they MUST start the sidecar through `SshService.setup` and wait a bounded budget of about 30 seconds for readiness before resolving the overlay. An already-ready sidecar incurs no start or wait work. A provider without `agentSocket`, a sidecar that is missing, could not start, or whose agent never answered (all `reason` `sidecar-not-running`), or a relay or bridge failure publishes a warning naming the reason, the redacted underlying cause, and remediation; start continues without the socket overlay, and `lando doctor` reports the `ssh` check degraded. Doctor repair MUST wait for the same readiness after restarting the sidecar before reporting the `ssh` check recovered or failed. Host mode fails closed. In host mode a provider without `agentSocket` is detected at planning time as `CapabilityError` (§5.4) naming the provider and the alternatives; start-time discovery failures are `SshAgentUnavailableError` with `reason` `host-agent-not-found` (no upstream discovered), `socket-missing` (explicit `sshAgent.socket` absent, not a socket, or refusing connections), `sidecar-not-running`, `bridge-failed`, or `capability-missing` (the defensive start-time check when a cached plan predates a provider change). Relay, worker, and bridge faults after readiness are `SshAgentTransportError` with `stage: "broker" | "worker" | "bridge"`. Both carry remediation, and no failure is silent in either mode.
- Detached relay logs MUST be owner-only (`0600` on POSIX; verified private ACL on Windows), reject symlink and non-regular targets, and tighten existing loose permissions before spawn. Lando-created log directories use `0700`. Worker-attributable startup failures (observed exit before readiness, payload delivery failure, readiness timeout, stdout EOF, invalid readiness frame) MUST name the log path; ownership-record write failures and already-tagged transport errors keep their own remediation. Observed exits report exit code and a tail redacted before clipping; a live worker after a bounded wait reports no invented exit code. Readiness decode failures MUST NOT echo the credential-bearing frame. Broker/input and control tokens MUST be registered at acquisition; outer failure output MUST be redacted before writing the log, failing closed if redaction fails.
- Trust boundary: relay sockets are mode `0666` inside a per-user `0700` run directory, so only the owning user reaches them on the host. The Windows guest-bridge loopback TCP broker carries no token; while the app runs, other local accounts on that Windows host can connect to it. That is a documented limitation, not an accident, and `lando doctor` MUST state it on win32.
- Interruption at any phase keeps app-scoped agent relays, bridges, and socket directories owned as after successful start (§6.7); the next start reuses them under the reuse rule above. Temporary probe work MUST finalize. Scratch ownership follows §21.
- `lando doctor` reports the selected mode, upstream availability, bridge readiness, and the security implication: in host mode every opted-in service can request signatures from the host agent for as long as the app runs. It MUST NOT print agent contents, key material, or socket tokens, and MUST NOT claim a hardware key has been moved into the container.
- Alternate feature implementations MAY ship but MUST use the same delivery contract and MUST declare security posture for `lando doctor`.
- Identities: `SshService.identities` lists the public keys the selected mode can sign with as `{ type, fingerprint, comment, source }` with `source` one of `agent`, `host-file`, or `managed`; it never returns private material. `SshService.hostAgentSocket` gives host-process callers (`CodeSync`, remote setup, init acquisition) scoped access to the same agent the sidecar or host mode uses, so authentication that works inside a service works for host `git`; on Windows that is the named-pipe agent, and the `git`/`ssh` client core invokes MUST interoperate with it.
- Certificates: a vendor that authenticates SSH with a CA-issued short-lived certificate supplies it through `RemoteSource.sshCredential(env)` as `SshCredential { kind: "certificate", certificatePath, identity, principals, validBefore }` or `{ kind: "agent" }`. Core passes a certificate to its own `git`, `ssh`, and `rsync` invocations as `IdentityFile`/`CertificateFile` options for that invocation only, never by editing the user's `~/.ssh/config`; it refreshes through the same hook when `validBefore` is within the operation's expected duration, and it treats a certificate as credential material under §3.7. The sidecar never receives vendor certificates; in-service vendor work runs under §10.12.4 with the tool's own certificate handling.
- Managed identity: `SshService.ensureManagedIdentity` generates `<userDataRoot>/keys/lando_ed25519` once, only after explicit consent and only when `identities` is empty or the user chooses it over an existing identity; it is never generated merely because host mode was selected. The sidecar loads it alongside `~/.ssh`; host mode reports remediation to add it to the host agent. Private-key bytes are readable only by the key-loading sidecar and the generating process; no service, plugin, event, or doctor output receives them.
- Host verification stays strict. Core-driven `git`, `ssh`, and `rsync` use the host `known_hosts`, including port-qualified entries such as `[host]:2222`; a `RemoteSource` MAY ship vendor-published host keys in its manifest, which core adds only after showing the fingerprint and recording consent; `StrictHostKeyChecking=no` and equivalent weakening are never used.

#### 10.4.1 gpg-agent forwarding

- `gpgAgent` is an object `{ forward?: boolean, socket?: string }` with the same Landofile, global config, then default precedence. The default is `forward: false`; there is no gpg sidecar.
- `gpgAgent.forward: true` enables the `lando.gpg-agent` feature (priority 1210, §6.11.4) for `type: lando` services. The upstream is the explicit `gpgAgent.socket`, otherwise `gpgconf --list-dirs agent-extra-socket` (the restricted remote socket, never `agent-socket`). Discovery requires host `gpg` and `gpgconf`; their absence is `GpgAgentUnavailableError` (`reason: "gpg-missing"`). Forwarding requires the restricted extra socket: an explicit `gpgAgent.socket` that does not answer Assuan `GETINFO restricted` fails closed with `reason: "unrestricted-socket"`.
- Delivery reuses the §10.4 relay and provider bridge contract with `kind: "gpg"`: the container sees `/run/lando/gpg-agent/S.gpg-agent` and the feature sets `GNUPGHOME=/tmp/lando-gnupg`, which per-start preparation creates as the service user with mode `0700`. Private keys never leave the host.
- `GNUPGHOME` is prepared in each opted-in service right after provider apply on every start, including when the gpg relay is reused (§10.4), independent of the build cache: Lando exports the host public keyring and ownertrust (replacing the relay's exported copy atomically), runs an uncached command as the service's resolved user to import them, and links `S.gpg-agent` into the home so `git commit -S` and `gpg --sign` resolve keys locally and sign through the relay. The service image MUST ship `gpg`. A preparation failure fails the start with `GpgAgentTransportError` (`stage: "worker"`) and keeps the applied app, routes, and relay in place (§6.7); the next start prepares `GNUPGHOME` again.
- gpg forwarding is opt-in and fails closed like SSH host mode: a provider without `agentSocket` is a planning-time `CapabilityError`; `GpgAgentUnavailableError` reasons are `host-agent-not-found`, `socket-missing`, `unrestricted-socket`, `capability-missing` (defensive start-time check), `bridge-failed`, and `gpg-missing`; runtime faults are `GpgAgentTransportError` with the same `stage` values as SSH. Both carry remediation, and doctor reports the gpg relay alongside the SSH relay under the same posture and trust-boundary rules.

### 10.5 Healthchecks and scanner

`HealthcheckRunner`, `CheckRunner`, `DoctorService`, downloader retry, and setup readiness use the shared probe primitive.

#### 10.5.1 Probe primitive (`@lando/sdk/probe`)

`RetryPolicy`, `ProbeSpec`, `ProbeOutcome`, `ProbeResult`, `runProbe`, and `toSchedule` form a pure, non-pluggable SDK contract.

- `runProbe` MUST be deterministic under Effect `TestClock`, stop on `green`, retry `yellow` and `red` by policy, and return the final `ProbeResult` when bounded attempts or deadline are exhausted. Consumers decide whether non-green is fatal.
- The primitive performs no IO, logging, or redaction. Consumers MUST redact `ProbeResult.lastError` through `RedactionService` before events, transcripts, or info output.
- `ProbeError` and `ProbeTimeoutError` are exported from `@lando/sdk/probe`, not the frozen errors barrel.
- Core MUST NOT introduce separate provider- or host-probe retry loops.

Healthchecks accept disabled, string, string-array, and object forms through `HealthcheckInput` (§6.7), including computed `load()` values (§7.3). Canonical object fields are `kind`, `command`, `url`, `port`, `intervalSeconds`, `timeoutSeconds`, `retries`, `startPeriodSeconds`, and `startInterval`, plus `user` and `target` (below). Compose `test`, `disable`, and duration spellings normalize through the same codec; Lando 3 `retry` and `delay` are translated (§7.4).

- Start, restart, rebuild (full or selected), and global-service start MUST pass the readiness barrier before post-start subscribers run (§6.7). Success rows are `ready`, `running`, `completed`, or warning-toned `restarting`; non-instant waits MUST publish per-service progress.
- Unsupervised exited services and exhausted healthchecks MUST fail with `ServiceNotReadyError`, including service, reason, available stopped-container exit code, bounded redacted log tail, and remediation. Applied resources MUST remain available for diagnosis; readiness failures MUST NOT roll them back.
- For non-completion services, `restart: always` and `unless-stopped` permit `restarting` on exit or observed restart; `on-failure` permits it only with an observed non-zero exit code. Exit 0 under `on-failure` remains fatal. Exhausted healthchecks remain fatal regardless of restart policy. Inspection failures use `inspect-failed`, remain fatal, and prescribe `lando doctor`. Warnings include available exit code/log tail and app-kind-specific remediation (§6.7).
- Failure or interruption at any phase (apply, dependency gate, app build, routes, agent preparation, readiness) MUST retain the applied app, including created-but-not-started containers, networks, volumes and their receipts, published routes, agent relays and bridges, host-proxy listeners and sockets, file-sync sessions, and managed scopes under app ownership while propagating the error or interruption. Interruption cancels in-flight probes and build children; temporary probe fibers and capture work MUST finalize. An unfinished accelerated-start journal stays at its phase for the next start to resume (§10.6.3). Scratch apps retain their §21 cleanup policy.
- Completion-intent services skip healthchecks and require verified terminal exit 0 regardless of restart policy. Created, never-started containers MUST NOT count as completed. Other unsupervised services MUST remain running throughout readiness. Engine clock skew MUST NOT extend the host-side settle wait beyond two seconds.
- Readiness verdicts apply only after committed provider apply. Provider apply and dependency gates retain `ServiceStartError` under the same retention; supervision MUST NOT relax healthy or completion gates. Scratch startup runs the same barrier under §21 cleanup and `--keep-on-failure` rather than user-app retention.
- The default `HealthcheckRunner` uses the selected `RuntimeProvider.exec` plus `runProbe`, probing immediately. Start-period failures do not count against retries; the first success completes the check. Subsequent attempts follow the configured retry interval and per-attempt timeout.
- `target` is `service` by default or `host`. Host targets use `ShellRunner`; native plugin runners MAY bypass shell. Unsupported targets fail at planning with `HealthcheckTargetUnsupportedError`.

#### 10.5.2 App checks

Checks report whether the application works once the whole app is up. They are not healthchecks: a healthcheck gates one service's readiness, while a check runs after every service is running and routes are applied, MUST NOT fail start, and exists to say what answered, who owns the result, and what to do next. `CheckRunner` executes the app's `CheckPlan` (§7) after `post-start` and on demand through `app:check` (§8.2.7).

A check is a **kind** plus a target plus declarative **rules**. The kind observes; the rules judge.

| Kind | Observes | Rule fields |
|---|---|---|
| `http` | status, headers, bounded body | `status`, `header`, `body`, `url`, `service` |
| `command` | exit code, bounded stdout/stderr, duration | `exitCode`, `stdout`, `stderr` |
| `tcp` | whether the endpoint accepted a connection | `connected` |
| plugin kinds | the observation fields the kind declares | the declared fields |

- One `http` check is generated per host-facing `http`/`https` URL of a service, covering its routes and published endpoints but not wildcard route hostnames, unless the service sets `checks: false`; `tcp` checks and other kind defaults are contributed by service types (§6.6). Authored checks live under app-level `checks.run` (§7.4). A check runs on the primary service unless it names `tooling:` (inheriting that task's service, user, env, and cwd), `service:`, or `target: host`.
- `CheckKind` is the only code extension point (`checkKinds:`, §4). A kind declares an observation schema; a rule field the kind does not declare fails planning with `CheckPlanError`. Judging is declarative only: core MUST NOT accept classifier code from plugins, recipes, or Landofiles.
- Rules are `{ when, verdict, message?, next?, extract?, retry? }`. `when` matches status codes or ranges, header presence or `contains`, `exitCode`, and `contains`/`startsWith` on bounded text. Regular expressions are not accepted. `extract` names an HTML selector (evaluated by streaming rewrite, never a DOM) or a bounded stdout/stderr slice. Rules evaluate first match wins in §7.4 precedence; a matched rule carries provenance `{source, index}` into events and results.
- Verdicts are `ready`, `expected`, `app-error`, `service-error`, and `lando-error`. `expected` means Lando succeeded and the user has a next step (first run, empty database); renderers MUST present it as its own neutral state, neither warning nor plain success (§8.9.2). Only `lando-error` becomes a `CommandWarning`; `app-error` and `service-error` are result data.
- Lando-owned failures are classified before any rule runs, and no rule may override them: connection failure, DNS failure, TLS trust failure, a router response carrying the router error marker (§10.2), a container that is not running, a provider `exec` failure, and an unresolvable tooling task are `lando-error`; exit `126`/`127` from a `command` check is `service-error`.
- Without a matching rule, an `http` response falls back to its status: 2xx or a listed `okCodes` value is `ready`, an unmarked `502` or `504` is `service-error` (a web server that cannot reach the app runtime), and any other response is `app-error`. A `503` stays app-owned because apps send it for maintenance mode.
- Retry follows the verdict through `runProbe`: `ready`, `expected`, and `app-error` are final on the first observation; `service-error`, `lando-error`, and unclassified observations retry within the check's bounded budget, because a booting service refuses connections and TLS trust can lag route publication; a rule MAY set `retry: true`.
- Bodies and command output are read only when a rule needs them and MUST be capped. Only the extracted snippet, capped and redacted through `RedactionService`, reaches events, results, or renderers; full bodies and output MUST NOT reach telemetry, transcripts, or JSON. `command` checks run without a TTY or stdin, and documentation MUST state they are read-only; core cannot enforce that.
- `checks.profiles` resolve at plan time from `checkProfiles:` contributions (§9.4); an unknown profile is a `CheckPlanError` with remediation. Every check has an id: authored ids are explicit or derived (`<tooling>:<args…>`, or the first command token, with `-N` on collision); profile checks are `<profile>/<id>`; generated `http` checks are `http:<service>:<url>` (the full probed URL, since one service can publish an `http`/`https` pair or a route beside a port). A collision between derived ids fails planning naming both entries. Ids key `--only`, profile overrides, task-tree children, and the `checks[]` result array.
- `CheckRunner` publishes one task tree per run with one child per check; §8.9 renderers paint verdicts without further classification. A cancelled run interrupts start; kind, check, and event-bus failures become `lando-error` results, never start failures.

### 10.6 Files and performance

- Providers expose app root, user home, and config root when supported. `MountPlan` remains provider-neutral; excludes/includes belong to each mount.
- Heavy directories may be excluded from live sync. The engine's exclusion patterns are derived from what is overlaid under the app mount plus VCS metadata (§6.4); `includes` cancels an entry before the engine sees it. Windows/WSL handling is provider setup and documentation, not core logic.
- Bind realization is `passthrough` or `accelerated`, derived from `bindMountPerformance` (§5.4, §6.4), without changing the Landofile.
- `FileSyncEngine` is the pluggable accelerated path. `passthrough` is the no-op default; `@lando/file-sync-mutagen` is bundled for slow-IO providers.

#### 10.6.1 `FileSyncEngine` contract

`FileSyncEngine` exposes identity, capabilities, availability/setup through `FileSyncSetupOptions`, scoped session create/pause/resume/terminate, filtered session listing, and event streaming; failures use `FileSyncError`. `FileSyncEngineCapabilities`, `FileSyncSessionSpec`, `FileSyncSessionRef`, `FileSyncSessionFilter`, `FileSyncSessionInfo`, and `FileSyncEventChunk` are public contracts. One session exists per accelerated `MountPlan` per started app.

- Setup MUST be idempotent; external tools install under `<userDataRoot>/bin/` through verified provisioning. First accelerated start MAY auto-acquire an unavailable engine.
- Sessions MUST be scope-acquired. A start whose planned sessions already exist and are healthy reconciles by observation: a listed session with the exact planned spec that is running is flushed, a paused one is resumed and flushed, and neither is created, terminated, or recreated. App stop drains a durable engine's sessions and terminates a lifecycle-less engine's listed sessions (§10.6.3). A failed or interrupted start at any phase keeps every valid session and prepared target in place under app ownership for the next start to reuse or resume (§6.7, §10.6.3); it MUST NOT drain, pause, or terminate them as compensation. Only a session the attempt began creating that the engine does not report as valid is acquisition-local and is terminated with the attempt; an engine whose sessions cannot outlive the process has nothing to retain. Temporary readiness probes MUST finalize.
- `recoverSession` (optional) re-establishes a session that `listSessions` no longer reports from synchronization history the engine still retains. It returns no session when no history survives and MUST NOT create a session without history. No bundled engine implements it; the Mutagen engine's history lives in the daemon's opaque data directory (§10.6.2) and is not reconstructed by Lando.
- Lifecycle events are `pre-file-sync-create`, `post-file-sync-create`, `pre-file-sync-pause`, `post-file-sync-pause`, `pre-file-sync-resume`, `post-file-sync-resume`, `pre-file-sync-terminate`, `post-file-sync-terminate`, `file-sync-conflict-detected`, and `file-sync-progress`; progress covers at least `initial-scan`, `staging`, `transitioning`, and `watching`.
- Home paths MUST render as `${HOME}/…` outside protected debug logs.
- Network activity MUST honor §10.3.1. Sources outside the app root require `--allow-load-outside-root` or fail with `FileSyncSourceOutsideRootError`.
- Engines MUST use provider ports rather than provider-native APIs and MUST preserve offline pause/resume once tools are cached.

Tagged errors are `FileSyncEngineUnavailableError`, `FileSyncSessionFailedError`, `FileSyncDaemonUnreachableError`, `FileSyncBinaryMissingError`, `FileSyncSourceOutsideRootError`, `FileSyncCapabilityError`, `FileSyncConflictError`, and `FileSyncInternalError`.

#### 10.6.2 Reference engine: `@lando/file-sync-mutagen`

The bundled engine is invisible to Landofiles and uses a Lando-owned Mutagen daemon and generated client, isolated from system Mutagen.

- Host CLI is `<userDataRoot>/bin/mutagen[.exe]`; agents are under `<userDataRoot>/bin/mutagen-agents/`; the daemon endpoint is `<userDataRoot>/run/file-sync/daemon.sock` or `\\.\pipe\lando-file-sync-daemon`; daemon data is the configured `MUTAGEN_DATA_DIRECTORY`, currently `<userCacheRoot>/file-sync/sessions/`.
- The bundled process client stores durable ownership and app drain/disposal receipts in plugin-private `sessions/mutagen.json`, and opaque daemon history in its configured `MUTAGEN_DATA_DIRECTORY` (currently `<userCacheRoot>/file-sync/sessions/`). These are not regenerable plan-cache metadata: stop, rebuild, and plan-cache invalidation MUST preserve them, and verified disposal retires the app's session state (§12.1, §12.4). A pinned `mutagen-versions.json` conforming to `ToolManifest` provisions host and agent binaries through `Downloader`. The plugin MUST NOT use a system `mutagen` on `PATH`; doctor reports conflicts without blocking sync.
- The daemon is lazy and outlives any one Lando process; sessions are engine-owned while target volumes remain provider-owned. Sessions persist across Lando processes (`sessionsPersistAcrossProcesses`), so a missing session after apply intent is lost history, not a fresh start (§10.6.3). An interrupted `sync create` that left a daemon session under a `preparing` receipt is adopted on exact name and config match: the receipt is promoted to committed with the observed identifier. A name match with a config mismatch, or an unowned extra session, fails closed; a receipt with no daemon session, source, or helper endpoint behind it is dropped. That reconciliation runs before the receipt-phase checks of drain, dispose, disposal-phase, and drain invalidation, so an interrupted create never wedges start, stop, or destroy.
- Agent deployment uses provider execution ports. Runtime dependency on system code generators or native gRPC addons is forbidden.
- Upgrades replace incompatible pinned tools and recreate sessions. Proxy/CA policy and redaction remain mandatory.
- Capabilities include all four sync modes, automatic agent deployment, exclusions, conflicts, and progress; default mode is `two-way-safe`.
- Port forwarding is outside the `FileSyncEngine` contract; the engine moves files only.

#### 10.6.3 Accelerated-start journal and resume

An accelerated start is journaled so that a failed or interrupted attempt is finished by the next start rather than redone. The journal lives in the `accelerated-starts` namespace under user data, one JSON document per app root keyed by `sha256(appRootIdentityKey)`, version 2, mode `0600`, advisory-locked, fail-closed on corruption (§12.4, §12.7.2). It records `attemptId`, `appId`, `appRoot`, `providerId`, `engineId`, `mountPlanDigest`, `phase`, planned targets, and planned sessions. Version 1 documents are migrated when read: the `retained` phase becomes `apply-intent` (the failure point is unknown, so app writers are assumed to have run), the recovery marker is dropped, and the attempt id is kept. The version 2 representation is persisted on the next journal mutation. Any other version fails closed.

Phases advance forward only, `preparing` → `sessions-ready` → `apply-intent` → `completed`, and each phase guarantees exactly this:

| Phase | Guarantee |
|---|---|
| `preparing` | Written before provider target preparation. Targets and sessions may be partial. |
| `sessions-ready` | Every planned session was flushed. No app writer of this attempt has started. |
| `apply-intent` | Provider apply may have started app writers on the sync targets. |
| `completed` | Tombstone. Written immediately after `provider.apply` succeeds, or by destroy after disposal. |

Phases never certify readiness. Completion follows provider apply, not app build, routes, the readiness barrier, or post-start: once apply has succeeded, the provider's applied plan records the accelerated mounts and `inspectAppliedFileSync` plus engine session ownership prove ownership, so the journal has nothing left to say. Advancing to a phase at or before the current one is an idempotent no-op; that is how a resumed attempt replays its remaining steps. Every advance re-checks that the record still carries this attempt id and identity.

**Begin or resume.** Under the bucket lock, a start with an unfinished journal compares the recorded identity (`appId`, canonical `appRoot`, `providerId`, `engineId`, `mountPlanDigest`, and digests of the planned targets and sessions) with the plan it is about to apply. Equal: resume, keeping the attempt id and phase. Different: fail closed with `FileSyncStartError`, remediation naming the recorded provider, engine, and mount settings to restore and `lando start` to finish the attempt, plus the journal path. No record or a `completed` record: a new attempt at `preparing`. Remediation MUST NOT suggest deleting the journal.

**Resume verification** runs under the app mutation lock in two stages and fails closed on anything unknown, corrupt, or foreign. Before init hooks, resume verifies journal identity, provider ownership, session identity and uniqueness (every listed session must equal a planned session's full spec, with no duplicate service/mount or ref), prior applied state, and prepared targets; drain invalidation follows successful target verification. This preflight may reconcile exactly owned `preparing` receipts and perform idempotent target preparation, but MUST NOT mutate unknown or foreign resources. Binding and session reconciliation run after init hooks and build, before provider apply. Providers expose no read-only inspection of every target, so a target refusal can follow the idempotent preparation of an earlier owned target; that target belongs to the attempt and stays for the next resume.

Preflight, before init hooks, in this order:

1. Identity as above. The recorded provider MUST be the selected provider, selectable, and implement `prepareFileSyncTargets` and `inspectAppliedFileSync`.
2. Ownership manifest (§12.4.2) for the recorded provider and root: a corrupt or unknown-version manifest fails closed; a present manifest whose provider differs or whose `appIds` lacks the recorded app is foreign ownership and fails closed; an absent manifest is accepted, because apply may not have written it yet.
3. Engine: the selected engine id MUST equal the recorded one, and every session the engine lists for the app MUST equal a planned session's full spec, with no duplicate service/mount pair or session ref. An unknown, mismatched, or duplicate session fails closed and is left untouched.
4. Prior applied state: `unknown`, `missing`, and `ordinary` are accepted with an unfinished journal (the journal explains the labeled sync volumes). `accelerated` requires the same engine id and, for a durable engine, exact session coverage.
5. Targets: `prepareFileSyncTargets(plan)` runs again (it is idempotent and re-verifies helper and volume ownership live), then `verifyPreparedFileSyncTargets`, then the prepared volume names MUST equal the recorded target names. A mismatch fails closed without touching sessions.
6. Durable engine, once targets verify: `appLifecycle.invalidateDrain(app)`, because a prior explicit stop or an attempt from an older version may have drained. Failed or interrupted starts under the current policy MUST NOT drain sessions.

After init hooks and build, before provider apply:

7. Bind through `bindPreparedTargets` when the engine has it, including the bound-app check.
8. Sessions: a matching existing session is reused (paused → resumed, running → kept) and flushed. Resume never terminates, duplicates, or reseeds a session; there is no `one-way-replica` replay. A missing session is recreated from the planned spec and flushed unless its history is required. History is required when the resumed phase is `apply-intent` and the engine's sessions persist across processes; then `recoverSession` MUST return a session to flush, or the start fails closed with `FileSyncStartError` naming the service and mount key, stating that the target may hold app writes whose synchronization history cannot be recovered, and directing the user to restore the session's synchronization history in the file-sync engine, then run `lando start`. The remediation MUST NOT offer `lando destroy`: destroy refuses while an existing target may hold app writes with no matching session. `lando stop` still stops app writers. Engines whose sessions do not persist across processes reuse valid sessions while their owning runtime and managed scope remain alive; after process or scope closure, missing sessions are created under the rules above and are never treated as lost history.

After verification the normal start continues: `sessions-ready`, `apply-intent`, apply, `completed`.

**No rollback of targets.** A failure or interrupt anywhere in preparation, binding, session start, or apply propagates and leaves the journal at its phase; prepared targets outlive a failed start. Lando MUST NOT roll back prepared targets or reseed a target at recovery time, and resume MUST NOT terminate recorded sessions. Session ownership after a failed attempt follows §10.6.1: valid sessions stay running under app ownership, with no drain, pause, or termination as compensation. The app side is retained too (§6.7): containers, networks, volumes, routes, and managed scopes established before the failure stay in place beside the prepared targets and the journal, and the next start MUST reuse every established matching session without re-creation, termination, or reseeding, create or recover only missing sessions under step 8, then converge the retained app resources.

**Restart and rebuild** (bare or selected) read the unfinished journal first and, when present, run the start path under the same lock: pending-aware preflight, transaction check, init events, and the resumed start. The normal restart or rebuild then continues without a second init-event run. A failed resume fails the command.

**Stop** works from every unfinished phase, subject to the ownership checks below, and leaves the attempt unfinished so the next start resumes it. Preflight checks identity (mismatch fails closed), accepts `unknown` applied state, and requires every listed session to be a recorded one, not exact coverage. The full plan stop then runs: provider teardown without removing state stops any writer, a durable engine drains the app, an engine without lifecycle terminates its listed sessions, and the owned-resource cleanup of §5.3.1 follows.

**Destroy** disposes from every unfinished phase, subject to the ownership and data-preservation checks here, then writes `completed`. Identity mismatch fails closed. When the attempt was never applied, every listed session MUST be a recorded one; a prepared volume with no session is allowed only at `preparing` or `sessions-ready`, and fails closed at `apply-intent` because it could hold the only copy of app writes. That refusal is not a dead end: restoring the session's synchronization history in the engine and running `lando start` finishes the attempt, after which ordinary destroy applies. A durable engine drains, disposes, has the provider dispose the targets, completes disposal, then provider destroy runs. An engine without lifecycle terminates listed sessions, the provider disposes targets when it can, then destroys. Applied, orphan, owned, and absent evidence with an unfinished journal routes to the desired target as §5.3.1 describes.

Doctor reports an unfinished attempt as a warning carrying app id, root, phase, attempt id, provider, engine, journal path, sessions, and volumes, with the same remediation: run `lando start` (or restart or rebuild) in the app root to finish it; `lando stop` and `lando destroy` also work from any phase, subject to the ownership and data-preservation checks above rather than as a guarantee in every resource state.

#### 10.6.4 Doctor checks and replaceability

On slow providers, `lando doctor` MUST verify selected engine availability, binary fingerprints, daemon compatibility, and cached-session decodability; `--fix` runs `setup` with transcript capture. Native providers report that no engine is required.

Alternative air-gapped, audited, recording, or different-engine plugins MAY replace the default by §4.3. They MUST pass the contract suite and MUST NOT weaken event, redaction, security, or determinism requirements. `TestFileSyncEngine` is the testing implementation.

### 10.7 SQL helpers

SQL helpers are plugin-only. Core ships none; bundled `@lando/sql` is the reference implementation.

- Database plugins expose discovery metadata and contribute import/export commands; gzip is supported when declared; replacement imports require confirmation by default.
- `@lando/sql` contributes `db:import`, `db:export`, `db:snapshot`, `db:snapshots`, `db:snapshots:prune`, `db:restore`, `db:reset`, and `db:seed` for supported credential-bearing databases. It MUST use `DataMover`, provider data-plane ports, renderer progress, machine output, `RedactionService`, and unambiguous service selection.
- `db:restore <snapshot>` and `db:seed --snapshot <snapshot>` resolve the reference through `DataMover.resolveSnapshot` scoped to the current app, owner, and target store (§10.11.1). Resolution never bypasses physical compatibility.
- `db:seed --from-app <id>` and `db:seed --from-path <dir>` copy a running app's database logically: the source is one of the provider's applied plans (by id, or by canonical root), its database service is `--from-service`, else the target service's name, else its sole SQL service, and it MUST be running and share the target's family. The copy is one `DataMover.transfer` from the source `serviceCmd` dump to the target `serviceCmd` load with credentials in environment only. File-based families (`mssql`) fail with remediation naming export and import. The target keeps every seed gate (Lando-created, fresh, empty, claimed under the physical-volume lock). Logical app seeding is limited to the selected provider and MAY cross Git repository boundaries; snapshot listing by `--from-app` stays restricted to the current repository group, and `--from-path` selects a canonical source root. A provider without `appliedPlans` fails app seeding with a typed error that names the dump-file path.
- Physical restore and snapshot seed require matching family, observed version, immutable image identity, owner key, service, and source root; only restore also requires the same physical volume generation. Seed targets only a Lando-created, fresh, empty volume claimed under the physical-volume lock. Cross-root movement uses logical app seeding, or logical export and `db:seed <file>`.
- Engine apply callers MUST record creation evidence through `ApplyOptions.onVolumeCreated` (§5.3), not after whole-apply success. The receipt persist step MUST be uninterruptible against cooperative cancellation. A later service failure does not erase verified creation evidence, so a retry can seed the retained generation if it remains fresh and empty. Adoption, ownership labels, and a hard kill between creation and receipt MUST NOT manufacture seed eligibility; missing evidence remains unknown and fails closed.
- Before import, reset, or restore mutates a database, SQL MUST capture an automatic recovery snapshot. Only after success, it MUST prune that database's automatic bucket to three snapshots, always retaining the just-captured undo point. Retention MUST stay within the app, canonical source root/owner, database store, and service, and MUST NOT prune on operation failure. Retention failures MUST warn without failing the completed operation. Manual snapshots remain user-pruned through `db:snapshots:prune`, whose default keep count is also three.

### 10.8 Setup and host integration

`lando setup` supports `--yes`/`-y`, `--provider`, `--skip-provider`, `--no-interactive`, `--skip-proxy`, `--skip-install-ca`, `--skip-shell-integration`, and `--skip-file-sync`. The default installs the managed runtime; `docker` and `podman` select existing system runtimes.

- Plugins add setup flags through `setup.flags`; elevation uses `PrivilegeService`.
- Provider setup MUST follow non-mutating inspect/plan, core-owned consent through `InteractionService`, then apply. Apply MUST NOT discover new mutations.
- Linux managed-provider prerequisite provisioning is limited to missing `newuidmap`/`newgidmap` on exactly Ubuntu 26.04, after consent, using only `/usr/bin/apt-get update` and `/usr/bin/apt-get install --yes --no-install-recommends uidmap` through `PrivilegeService`, followed by re-probing. Every other missing prerequisite fails closed. App lifecycle commands MUST NOT provision host packages.
- Setup task children settle explicitly on failure. `SUDO_ASKPASS` is set when available.
- All setup egress honors §10.3.1.
- `lando shellenv` emits profile configuration for `<userDataRoot>/bin`.
- Slow providers run active file-sync setup unless `--skip-file-sync`; native providers do not.
- SSH sidecar setup MUST observe agent readiness on the Lando-managed provider, with the §10.4 bounded readiness budget, before recording `shell` as `satisfied`. A reachable empty agent counts as ready (`ssh-add -l` exits 0 or 1). A sidecar that fails to start, stops, or never answers within the budget MUST warn with reason and remediation, record `shell` as `unavailable`, and continue remaining setup steps. It MUST NOT by itself make setup exit non-zero; shell-profile integration failures remain fatal.
- An unavailable SSH sidecar makes the persisted readiness summary `failed`, independently of setup's exit status. Doctor MUST report that setup observation as a warning until a later setup run refreshes it; successful doctor repair does not rewrite the setup observation.

### 10.9 Logs and diagnostics

- Core logs live under `<userCacheRoot>/logs/`; app logs are discoverable by app id and root.
- `RuntimeProvider.logs` streams service output. Declared service log sources (§6.14) use redirect or provider file-follow capability, are labeled by `LogChunk.source`, and MUST NOT disappear silently.
- Debug logs include provider operation names and redacted inputs; structured logger annotations preserve `traceId`.
- Normal diagnosis MUST NOT require provider-native commands.

`lando doctor` combines core checks with `provides.doctorChecks`. Every finding has severity, context, and automatic or manual remediation; `--fix` runs only declared automatic actions.

- `DoctorCheckContext` exposes bounded app/provider identity, resource inspection, and path-only executable lookup. It MUST NOT execute candidates, read executable contents or state, or import `@lando/container-runtime`.
- Bundled `@lando/lando3` contributes read-only `lando3-leftovers` and `lando3-shadow` checks. They MUST NOT mutate or read Lando 3 user state; `LegacyProxyContainerDetected` solely owns legacy proxy detection.
- With `--app`, the config section runs the same validation as `app:config:lint` and reports its `ConfigLintResult`; uncaught failures stay isolated under §10.9.1.
- Core covers discovery, removed wrappers, plugin metadata, provider availability, and legacy proxy conflicts. A conflict raises `LegacyProxyContainerConflictError`. Plugin metadata failures become attributed self checks rather than aborting the report.
- Core `orphaned-volume-snapshots` warns about eligible unindexed provider images and prescribes `lando snapshots:gc --prune`; unavailable providers pass with a skip note and MUST NOT be started.
- Shell-shaped checks and fixes SHOULD use `ShellRunner`; transcripts persist at `<userCacheRoot>/logs/doctor/<run-id>.transcript`. `lando doctor --transcript-only` prints that transcript.
- Core contributes a `filesystem-watch` check for the CLI host on Linux and WSL only. It creates one unique temporary directory, allocates one non-recursive watch on it, closes the watch and removes the directory, and reads the configured inotify watch, instance, and queued-event limits where readable; unreadable limits are reported as unavailable, and unsupported or restricted observations are explicit.
- It is a point-in-time allocation, not a capacity, headroom, or event-delivery guarantee. The current implementation observes only the local host; any observation MUST be labeled with the host it describes, and local limits MUST NOT be presented as runtime-host limits. Incomplete or duplicated per-process observations MUST NOT be presented as exact user-wide consumption: shared descriptors, user namespaces, and process visibility limit those observations, and rootless containers may share an ancestor user's budget with host tooling. Allocation success does not assert absence of pressure. Classification is by stage: `ENOSPC` on watch allocation is the inotify watch budget or a related kernel resource and is not evidence of disk exhaustion; `ENOSPC` creating the directory is storage (blocks or inodes); watch-stage `EMFILE` is ambiguous between process descriptors and inotify instances, while directory-creation `EMFILE` is a process descriptor limit. `ENFILE`, `EACCES`/`EPERM`, and unsupported are distinct; anything else stays unknown.
- Remediation is manual and stage-appropriate: for watch-resource failures, reduce unnecessary watchers first, then consider administrator-directed limit changes on the affected host or VM. Neither this check nor `--fix` writes sysctl config, raises limits, or kills processes, and a successful probe MUST NOT clear the persisted `router-file-watcher` record (§10.2), which describes the provider runtime host.
- The `host-proxy` DNS check probes `lando-doctor-probe.<domain>` for the configured `proxy.defaultDomain` and expects a loopback answer. Its remediation is manual: `lando setup` does not configure host DNS.

#### 10.9.1 Self-resilience

- Doctor MUST emit a structured report for every host state except user interrupt. Provider, subsystem, global-app, MCP, version, deprecation, and config sections run in isolation.
- Failure, defect, or deadline in a section adds a redacted `doctor-self` entry to `self.checks`, appears in every output format, and makes exit non-zero.
- Section deadlines are bounded and configurable by `LANDO_DOCTOR_SECTION_BUDGET_MS`; checks remain interruptible Effect programs.
- Provider failures degrade to a non-pass `selected-provider` check with setup remediation.
- Each plugin check is isolated, attributed, strictly decoded as `PluginDoctorReport`, and bounded. This is cooperative isolation, not a hostile-code sandbox.
- `meta:doctor` declares base bootstrap `none`, constructs the provider runtime once inside its own scope, and degrades provider-bootstrap failure without suppressing independent sections. It still uses native dispatch, Effect, and `Renderer`; `notify.commands` MUST NOT promote it.

### 10.10 Host proxy

`HostProxyService` is the opt-in, per-app container-to-host RPC port installed by `lando.host-proxy` for `type: lando` services. It opens host URLs, reveals app paths in the host file manager, and re-enters approved Lando or Bun operations. It is not a persistent agent, which is a non-goal (§14.2).

#### 10.10.1 Architecture and protocol

- The host dispatcher binds `<userDataRoot>/run/<app-id>-<root-hash>/host-proxy.sock` (§12.4), mounted read-only at `/run/lando/host-proxy.sock`, and injects `LANDO_HOST_PROXY_SOCKET`, `LANDO_HOST_PROXY_TOKEN`, and `LANDO_HOST_PROXY_DEPTH` when provider reachability permits.
- The dispatcher runs in a detached per-app worker that outlives the CLI process. The worker and its credentials (session id, bearer token, and control token) live from the start that acquires and records them until stop, destroy, uninstall, or replacement, whether or not that start finished. One retained `LandoRuntime` serves `runLando` through `@lando/core/cli`.
- Ensure or reuse. `lando start` reuses a running worker when its owner-only record (§12.4) and an authenticated control handshake agree on the app id and root, the provider, the worker protocol version, and the configuration digest. Reuse sends the control token with the session id and bearer token, and every credential supplied MUST match; recovery identify and shutdown may authenticate with the control token alone. The identity the worker returns names its app id and root and its provider. The digest covers the worker's non-plan inputs: the app identity, the provider, the Lando roots, the shim artifact and container target, the host-gateway name, and the worker entry. A unix-socket worker is reusable only while its socket is an owner-only socket. After the handshake, start sends the current app plan (before agent and host-proxy overlays) over the authenticated control channel and the worker serves it in place, so a Landofile change never replaces the worker. A reused worker hands the same socket and credentials to services, so running containers keep working. Anything else (a dead or unresponsive worker, a foreign, corrupt, or non-private record, any mismatch, or a failed handshake or plan update) replaces the worker: a worker that authenticates on the control channel is shut down, a worker whose record Lando cannot trust or authenticate is never contacted or signalled, and the run directory is recreated.
- Session recreation. Each eligible container carries `dev.lando.host-proxy-session`, a truncated digest of its session id and never the id or a token. The label is excluded from the create-config fingerprint (§5.3.2). When a start replaces the worker, bring-up recreates every eligible service whose label no longer matches the new session, keeping volumes, because a running container cannot pick up new credentials or a replaced socket in place.
- Scoped rebuild. `rebuild -s` applies the overlay to the rebuilt services from the running app's worker, whatever its configuration digest, after the same ownership, handshake, and plan-update checks. The rebuilt container gets the current socket and credentials, and services left running keep theirs. The scoped rebuild does not own that worker and never closes it. When no healthy worker exists it starts one through the normal path with the full-app digest; it owns that worker as start would, and a later start reuses it and recreates eligible services that still hold an older session. Selected restart is in place and keeps each container's existing overlay.
- The worker record holds the session id, bearer token, and control token so a later start can hand them to services. Lando registers them with `RedactionService` (§3.7) as soon as they are known; they MUST NOT appear in logs, events, transcripts, traces, errors, or machine output. Later app-scoped output commands register these credentials and ssh/gpg relay control tokens from matching owner-only records before output, without locking or contacting workers. App id, canonical root, and recorded provider/kind MUST match; missing, foreign, or non-private records contribute nothing.
- `HostProxyRequest` tags are `openUrl`, `openPath`, `runLando`, and `runBun`; `HostProxyResponse` tags are `ok` and `error`, classified by `HostProxyErrorCode`. Requests require bearer-token authentication. `runLando` streams NDJSON stdout, stderr, exit, or error frames.
- Container-initiated notification and clipboard relay are outside the `HostProxyRequest` union; adding one is a protocol-schema change, not a plugin extension.
- Default `openUrl` schemes are `http`, `https`, `mailto`, `tel`, `vscode`, `vscode-insiders`, `cursor`, `phpstorm`, `idea`, `webstorm`, `goland`, `pycharm`, `rubymine`, `clion`, `fleet`, and `zed`. `file:` is always forbidden, case-insensitively. Extensions use the service layer; global `hostProxy.allowedSchemes` remains planned, not an accepted config key.
- `openPath` requires an existing absolute container path inside the app mount. The host remaps it through that mount, resolves the host root and target canonically, and rejects lexical or symlink escapes instead of using the `runLando` cwd fallback. Unrelated bind mounts and container-only paths are not eligible. Host opening is argv-precise through `ProcessRunner`, never shell interpolation.
- `runLando` uses the generated `host-proxy-allowlist`. Lifecycle commands, `app:remote:tether`, `meta:bun`, and `meta:x` MUST NOT be allowed; violations fail with `HostProxyAllowlistConflictError`. Allowed remote operations MUST still enforce §10.12.8; the proxy MUST NOT synthesize typed confirmation.
- `runBun` uses the non-plugin-extensible `host-proxy-bun-verb-allowlist`: `audit`, `outdated`, `pm`, `info`, and `why`. Mutating verbs fail with `HostProxyBunVerbNotAllowedError`.
- Recursive re-entry is bounded by `LANDO_HOST_PROXY_DEPTH` and fails with `HostProxyRecursionLimitError`. Per-app concurrency is bounded by global `hostProxy.maxConcurrent` and fails with `HostProxyBackpressureError`.

#### 10.10.2 In-container shim and required behavior

One static client is installed as `xdg-open`, `open`, and `lando`; optional `lando.host-proxy.bun: true` installs `bun` only when it does not shadow an existing Bun. It dispatches by invocation name, filters forwarded environment, remaps cwd through `AppMountInfo`, never forwards `BUN_BE_BUN`, and prints deterministic fallback errors when proxy env is absent. It is a signed wire client, not the host `lando` binary.

The opener roles bind the session copy read-only at `/usr/local/bin/xdg-open` and `/usr/local/bin/open`, intentionally shadowing image openers when `/usr/local/bin` precedes `/usr/bin`. They accept exactly one nonempty argument and no flags (including `--`); unsupported arguments exit 64. A leading RFC-style scheme (`[A-Za-z][A-Za-z0-9+.-]*:`) selects `openUrl`; everything else becomes an absolute path relative to the container cwd for `openPath`. Neither request forwards environment. These binds are session-only: plan persistence and create fingerprints exclude them.

`openPath` MUST reveal the canonical target in the host file manager, never launch it. The app mount is writable from the container: default file openers can execute scripts, application bundles, executables, or desktop entries supplied there, bypassing the host-command restrictions. Linux runs `xdg-open <directory>` with the canonical target for directories and its parent for files. macOS runs `open -R <target>` for both files and directories, including `.app` bundles. Windows runs argv `["explorer.exe", "/select," + target]`; Explorer's exit code is not a success signal, so a nonzero exit does not fail a reveal, while process-launch errors still do. Only `openUrl` reaches the URL opener (`xdg-open`, `open`, or `rundll32.exe url.dll,FileProtocolHandler`) after scheme validation. This does not change the existing host `lando open` shell launcher.

The client is the in-container helper (§17.3), a statically linked executable with no libc or runtime dependency, so it runs in glibc, musl (Alpine), distroless, and scratch images without detecting the image's libc. Having no dynamic loader, it is unaffected by the image's `LD_PRELOAD` and `LD_LIBRARY_PATH`. The start-time overlay copies it into the session directory and bind-mounts that file read-only, so replacing the session directory never alters a running container's copy.

- The `HostProxyService` implementation layer MUST construct lazily and do nothing for apps without the feature.
- Every request, including rejection, publishes redacted `pre-host-proxy-call` and `post-host-proxy-call`.
- Tokens MUST be cryptographically random. Socket creation MUST be atomic and private; stale sockets fail with `HostProxySocketStaleError`.
- Ownership follows acquisition, not the phase at which a start stops. A worker that completed its handshake and wrote its ownership record is app-owned: a failed or interrupted start at any phase keeps its listener, socket, and credentials as after successful start (§6.7), and the next start reuses it under the §10.10.1 rule. A worker that never validated its handshake or never wrote its record is acquisition-local: the failed attempt closes its listener, finalizes requests, and unlinks its socket. Temporary readiness work MUST finalize. Unsupported provider reachability plans a visible no-op rather than runtime failure.
- Detached worker logs MUST be owner-only (`0600` on POSIX; verified private ACL on Windows), opened without following symlinks, regular, and owned by the current user. Existing loose files MUST be tightened before spawn; Lando-created log directories use `0700`. Outer failure output MUST be redacted, with a fixed safe diagnostic if redaction fails.
- Worker-attributable startup failures (observed exit before readiness, payload delivery failure, readiness timeout, stdout EOF, invalid readiness frame) MUST name the log path; ownership-record write failures and already-tagged transport errors keep their own remediation. A startup payload write that fails because the worker already exited reports the worker's exit code, output tail redacted before clipping, and log path, not the pipe error. A worker still alive after a bounded wait reports no invented exit code; startup MUST NOT wait indefinitely for exit. Readiness decode errors MUST NOT echo the credential-bearing frame.
- Doctor checks socket privacy, reachability, token round-trip, and allowlist freshness.
- Plugin replacements for CI, audit, remote transport, or testing MUST pass the contract suite, retain allowlists and authentication, and MUST NOT weaken security.

Other tagged errors are `HostProxyOpenUrlSchemeError`, `HostProxyCommandNotAllowedError`, and the response error codes registered by the public protocol schema.

### 10.11 Data movement and volumes

`DataMover` is the fixed core chokepoint for local, volume, service, stream, and artifact bytes. It is neither `FileSyncEngine` nor remote transport, and is host/test-overridable but not plugin-contributed. `ManagedFileService` owns user-visible managed project files.

#### 10.11.1 `DataEndpoint` and `DataMover`

`DataEndpoint` tags are `hostPath`, `hostArchive`, `stream`, `volume`, `servicePath`, `serviceCmd`, `artifact`, and `network`; `ArchiveFormat` covers supported archive forms.

- `network` carries `scheme`, `host`, `port`, optional `path`, `tls` (`required`, `optional`, or `none`), `auth` (`{ credentialRef }` or `{ ssh: true }` under §10.4), and optional `alternates`. It MUST retain the original TLS server identity separately from a changed dial host; tunnel use MUST NOT disable identity verification.
- `RemoteSource.resolve` or `openTunnel` produces a binding-scoped endpoint for a declared client operation. `DataMover` MUST NOT transfer a network endpoint as bytes. Read/capture access MUST NOT imply permission to send/import remotely (§10.12).
- Each alternate MUST identify the same exact unit and preserve the requested operation, consistency, format, permissions, TLS, exposure, and freshness semantics. Reachability probing MAY use bounded `runProbe`; switching MUST NOT silently weaken security, use a semantically different pooler, or create a fresh side effect. A non-equivalent alternative MUST be re-resolved and separately approved.

`DataMover` exposes scoped `transfer`, `transferStream`, `snapshot`, `restore`, `listSnapshots`, `resolveSnapshot`, `removeSnapshot`, `pruneSnapshots`, `findOrphanedSnapshots`, and `removeOrphanedSnapshot` over `DataTransferSpec`, `DataTransferResult`, `DataTransferProgress`, `VolumeRef`, `SnapshotOptions`, `SnapshotRestoreOptions`, `SnapshotHandle`, `SnapshotId`, `SnapshotInfo`, `SnapshotFilter`, `PrunePolicy`, and `VolumeSnapshotArtifact`; failures use `DataMoverError`. `restore` defaults to `mode: restore`, which requires the snapshot's recorded physical volume generation. `mode: seed` MAY cross generations only with verified snapshot metadata, the snapshot's own app, store, and canonical owner root, and an in-progress initialization claim on the target volume. `resolveSnapshot(reference, scope)` returns the snapshot whose id equals the reference, else the one snapshot in `scope` whose label equals it; labels are not unique, so several matches fail with `SnapshotAmbiguousError` carrying the candidate ids newest first, and no match fails with `SnapshotNotFoundError`.

- Native provider data-plane capability wins; otherwise a generic helper path is used; otherwise `DataEndpointUnsupportedError` fails with remediation. Capability honesty is mandatory.
- Helper artifacts are pinned, verified, cached, and reusable offline.
- All movement is streaming and scope-bound; interrupt reaps underlying processes.
- Archive and snapshot writes record SHA-256 and restores verify it. There is no skip-verification flag.
- Redaction uses `RedactionService`; credentials use environment, never argv.
- Events are `pre-data-transfer`, `data-transfer-progress`, `post-data-transfer`, `pre-volume-snapshot`, and `post-volume-snapshot`.
- Host endpoints MUST remain within the app root or explicit base. A caller MAY mark an explicitly selected `hostPath` source trusted to read outside that boundary; trust never extends to destinations. Destructive restore/import requires `overwrite: true`.

#### 10.11.2 Snapshot store and errors

Snapshot image listing MUST NOT invoke runtime startup or repair, and GC removes images only on providers it found running. `removeVolumeSnapshot` may start a stopped runtime, because `destroy --purge` removes snapshots before app teardown. A failed orphan eligibility recheck MUST fail with `DataMoverError`, not return a successful removal receipt; GC MUST NOT count a refused deletion as removed. A provider whose inspection or removal fails is reported `failed` without hiding other providers' results; `meta:snapshots:gc` then exits with `DataTransferError`, while doctor warns.

Native snapshot images MUST carry `dev.lando.volume-snapshot=TRUE`, `dev.lando.snapshot-id`, `dev.lando.app`, `dev.lando.store`, `dev.lando.provider`, and caller-supplied labels. DataMover MUST add `dev.lando.snapshot-store`, the SHA-256 digest of the canonical `PathsService.snapshotsDir`, and `dev.lando.app-root` from `metadata.sourceRoot` when present. Images MUST NOT carry volume ownership or selector labels. `VolumeSnapshotArtifact` contains `ref`, UTC `createdAt`, and `labels`. An artifact is orphaned only when no index across this snapshot store references its `(provider, id)`, it belongs to this store (matching store identity, or legacy image without the snapshot marker), and it is at least one hour old. Discovery MUST use the call-time provider. Removal MUST recheck these conditions before deleting the provider artifact. `meta:snapshots:gc` reports per-provider availability, orphan details, total count, bytes, and removed count; it removes only with `--prune` and MUST NOT start stopped runtimes.

Snapshots live under `<userDataRoot>/snapshots/<app-id>/<store>/` through `PathsService` and are indexed by `StateStore`. DataMover persists a provider snapshot reference when the provider declares native snapshot support; otherwise DataMover itself persists a host archive and metadata. Explicit `volumeSnapshot: "copy"` selects the host archive even on native-capable providers; forcing `"native"` on an unsupported provider fails before action. Providers do not offer copy snapshots. Plain destroy, `--volumes`, and `--purge-caches` keep snapshots. `lando destroy --purge` removes the snapshots whose `metadata.sourceRoot` is the app's canonical root, provider artifacts included, before it tears down app resources, and does so even when no runtime resources remain. App id alone MUST NOT select snapshots for removal, because apps with the same name in different roots (git worktrees) share `<app-id>`; snapshots without a recorded source root are kept. `removeSnapshot` removes the provider artifact before the index entry and sidecar, so a failed removal stays listed and retryable; a provider that cannot remove a provider-backed snapshot fails without changing the store. `DestroyAppResult.snapshotsRemoved` counts the snapshots that purge removed. Destructive teardown MAY take a safety snapshot unless opted out.

Retention has two independent buckets: manual snapshots (`recoveryReason` manual or absent) and automatic recovery snapshots (import, reset, restore, or seed). `PrunePolicy.recovery` defaults to false for the manual bucket; true selects only the automatic bucket. Each bucket keeps its newest `keepLatest` matching snapshots; omitted `keepLatest` removes nothing. Optional `retainSnapshotIds` reserve places in that budget for the listed snapshots even under timestamp ties or clock rollback; SQL retains the new undo point and, for `db:restore`, the snapshot just restored from. SQL applies automatic keep-three retention after successful recovery-protected database operations; it never uses the manual bucket for that cleanup.

Tagged errors are `DataTransferError`, `DataEndpointUnsupportedError`, `DataChecksumMismatchError`, `DataSourceOutsideRootError`, `DataTargetExistsError`, `SnapshotNotFoundError`, `SnapshotAmbiguousError`, `SnapshotOwnershipError`, `VolumeNotFoundError`, and `ArchiveFormatError`; provider causes may include `VolumeOperationError`, `ServiceCopyError`, and `ArtifactTransferError` (§5.7). `TestDataMover` supports contract testing.

### 10.12 Remote data sync (`RemoteSource` + `Dataset` + `CodeSync`)

Core owns generic orchestration, `CodeSync`, setup, and tool execution. Vendor APIs, environment models, and credential formats MUST remain plugin-owned. The bundled `dotenv` config `Dataset` is a plugin, not hoster logic in core. No bundled `RemoteSource` is assumed; missing implementations MUST fail with installation remediation (§4.3). These are authored contracts, not a claim of shipped implementation; sequencing belongs to `ROADMAP.md`.

**Contracts and selection**

- `RemoteSource` exposes identity, config schema, environment listing, `resolve(cfg, locator, operation)`, scoped `fetch`/`send`, and optional `resolveCode`, `sshCredential`, `openTunnel`, `operations`, `metadata`, `refreshCredential`, `setup`, and `test`. `test` returns `RemoteTestResult`.
- `RemoteCapabilities` retains `environments`, `push`, `datasets`, `code`, `tool`, `auth`, `requiredScopes`, and `protectedByDefault`. Optional `openTunnel` and the `operations` catalog express support without duplicate capability booleans. The `tool` descriptor owns execution mode (§10.12.4). Manifest validation MUST validate these shapes and their implementation correspondence, not infer per-resource permission.
- `Dataset` exposes identity, `DatasetKind`, `DatasetCapabilities`, `DatasetArtifactFormat`, scoped `capture`/`apply` through `DatasetContext`, their option/result contracts, and local-store resolution. `DatasetKind` is `database`, `files`, `config`, or `blob`; a `Dataset` MUST NOT move application code. `files` means a filesystem tree; `blob` means keyed object bytes and metadata, with the preservation format declared by the implementation.
- `RemoteCapabilities.datasets` MUST advertise supported `access` modes per kind and a `preferred` mode when both are supported. `fetch` returns an artifact; `network` supplies a live endpoint for `Dataset.capture`. A binding MAY explicitly select supported `access`; otherwise the source preference applies. Core MUST NOT impose network-first selection. A kind with neither mode is not pull-capable.
- Remote selection is explicit `<remote>@<env>` or `--remote`, then the sole configured remote, then the sole installed source. Pull MAY use a unique declared default environment, but MUST NOT choose the first list entry. Push and destructive operations MUST explicitly identify the environment and every target resource (§10.12.8).
- `RemoteEnvironment` carries `name`, `type`, optional `branch`, `ephemeral`, `protected`, `automated`, `default`, `branchScoped`, and `units`. `type` is `production`, `staging`, `development`, `preview`, or `unknown`, based on vendor evidence, never a name heuristic. `--branch` narrows branch-scoped locators; other sources MUST reject it.
- `units` lists `{ name, label, kind }` for each database, file tree, config set, or object collection. `sync.<kind>[].from` selects a unit. Pull MAY infer the sole unit of a kind; multiple or missing matches MUST fail with `DatasetBindingError` reason `unit`. Push MUST NOT infer a target unit.
- Each binding selects its `Dataset` by explicit `dataset`, service-type default, then sole implementation for that kind. Without `sync:`, pull MAY infer bindings only when each unit has one unambiguous compatible local target; otherwise it MUST request explicit bindings. `--only` selects kinds or `<kind>:<binding>` names and MUST reject unknown names.

**Resolve, approve, transfer**

- At operation time, `resolve` MUST validate the exact environment, branch, unit, and requested operation. The resolved locator MUST carry actual resource identity, classification/protection evidence, and operation authorization (§10.12.8). Catalog support is not resource authorization. Marketplace endpoints follow the same checks as vendor-owned resources.
- Before preparation, capture, checkout, or apply, core MUST resolve all currently selected bindings, local targets, formats, access modes, credential sources, and code intent. Approval MUST name those identities, exposure, snapshot policy, artifact freshness, and side effects. Code changes require the additional two-phase validation in §10.12.1.
- Pull MUST use `RemoteSource.fetch -> Dataset.apply` for artifacts, or `Dataset.capture(network) -> Dataset.apply` for live reads. Local landing MUST use `Dataset`/`DataMover`; a source MUST NOT perform local database import or extraction.
- Push MUST require both declared `push` and successful per-unit push resolution, then run `Dataset.capture -> RemoteSource.send`. `send` MAY implement a vendor-supported network import. Core MUST NOT infer remote writes from a read endpoint, network access, or successful pull.
- Producers and consumers MUST share an enclosing `Scope`; endpoints and credentials MUST remain valid until apply/send finishes. Control-plane HTTP MUST use §10.3.2; declared data clients and vendor tools MUST follow §10.3.1 and §10.12.4.
- Pull MUST snapshot local stores before apply unless `--no-snapshot` or that binding's `snapshot: false` explicitly skips capture. If `localStore` is `null` or snapshotting is unsupported, approval MUST disclose it and require either opt-out. A failed requested snapshot MUST abort before apply, not silently downgrade.
- Local service targets MUST be running and healthy before apply; ordinary sync MUST fail with `lando start` remediation rather than start them implicitly. File-only config targets do not require a running service.
- A reused artifact MUST report `capturedAt` (or explicitly unknown age); approval and receipt MUST show freshness. `--fresh` MUST resolve an on-demand capture or fail with `RemoteDatasetUnsupportedError` reason `fresh`. Live network capture satisfies fresh capture, but MUST NOT promise application-consistent snapshots beyond the Dataset's declared semantics. Expired artifact URLs MUST be re-resolved and reapproved if semantics change, or fail with `RemoteError` reason `expired`.
- Order is code, database, files, config, blob, then post-processing. `SyncResult` MUST retain each binding's `applied`, `skipped`, or `failed` state, snapshot handle, and recovery references. Failures MUST preserve partial-completion receipts and MUST NOT claim rollback; the failed binding's error is the primary, sibling binding failures carry role `peer`, and none of them change the primary's exit status (§8.11.1).
- Durable nonsecret state MUST use `StateStore`, paths MUST use `PathsService`, and waits MUST use `runProbe`. Secrets MUST NOT enter logs, events, receipts, journals, telemetry, or caches; approved credential backends and private data payload files have the distinct rules in §9.5.1 and §10.12.7.
- Machine output MUST follow §8.11, with `StreamFrame` for streaming. Core MUST publish the §3.5 sync events around source/dataset calls; plugins MUST NOT gain arbitrary event-publish authority. Commands remain the §8.2 pull, push, and remote command entries.

**Preparation**

- `resolve` MUST declare each `prepare` step's label, duration estimate, targets, exposure, and expected side effects before approval. Core MUST start each mutation once, then poll its returned handle with `runProbe`; retries MUST NOT repeat create/wake/backup mutations unless the vendor guarantees deduplication with the same idempotency key.
- A reversible step MUST provide `undo`; core MUST attempt compensation on success, error, and interruption. Cleanup failures MUST remain visible in the outcome/receipt with affected resource ids and recovery instructions. Engine compensation helpers MUST annotate role `rollback` (undo of failed partial work) or `cleanup` (release and bookkeeping), and use the standard §8.11.1 projection rather than a sync-specific error list. A sole cleanup failure becomes the primary failure; with an existing primary it is an additional error and MUST NOT replace that primary's exit status. Compensation is best-effort, never a rollback guarantee.
- Exposure widening MUST require explicit approval, `--allow-exposure` for non-interactive general consent, a narrow additive rule, vendor-enforced expiry, and compensation. A scoped expiring allowlist addition MAY qualify; disabling existing restrictions, production mode, locks, or protection MUST NOT qualify. Missing expiry or cleanup support MUST fail resolution.
- `--allow-exposure` MUST NOT bypass target eligibility, permission checks, or protected-target confirmation. Preparation affecting protected resources MUST follow §10.12.8 even when the requested transfer is a pull.

#### 10.12.1 Code sync (`CodeSync`)

`CodeSync` is a core service (§3.4), not a contribution surface. Host `git` MUST run through scoped `ProcessRunner` with §10.4 identity and strict host verification, including init acquisition.

- `resolveCode(cfg, env)` returns `CodeAvailability`: `{ available: true, locator, origin }`, where `origin` is `vendor` or `external`, or `{ available: false, reason, remediation }`, with reason `deploy-only`, `write-locked`, or `none`. Missing code support MUST fail with `CodeSyncUnavailableError`; core MUST NOT guess refs from environment names.
- `CodeLocator` retains `kind: "git"`, `url`, exact `ref`, `refKind: branch | tag`, optional `remoteName` (default `lando-<remote>`), `protocol`, `sshCredential`, and `artifact: { builtFrom? }`. Source/artifact alternatives MUST be explicitly resolved and shown in consent with origin, exact ref, and commit. Core MUST NOT silently prefer a branch by its name or reinterpret a build-output ref as source.
- The repository root MUST equal the app root. Missing remotes MAY be added and MUST appear in the side-effect receipt. A conflicting URL MUST fail with `CodeSyncRemoteMismatchError`; unfinished merge, rebase, cherry-pick, or bisect MUST fail with `CodeSyncInProgressError`.
- `app:pull --code` MUST fast-forward the current branch tracking the exact resolved branch, then follow the shared code-sync sequence below before any dataset transfer. A tag, wrong upstream, or non-fast-forward MUST fail with `CodeSyncDivergedError` and switch remediation. Core MUST NOT merge, rebase, reset, or push code automatically.
- `app:remote:switch <remote>@<env>` MUST check out the exact branch tracking the resolved ref (creating it if absent), fast-forward only, or the exact tag detached. Approval and receipt MUST distinguish detached tags from branches.
- Both `app:pull --code` and `app:remote:switch` MUST validate code safety and discovered data intent against the target tree before changing the working tree. Fetch needed for bounded inert inspection is a declared preparatory side effect.
- After the successful fast-forward or checkout phase, both commands MUST invalidate old plans/handles, refresh target translation entries under §7.4.2, reload, and replan before running `post-code-sync` steps from that refreshed context. This shared sequence also applies when the resolved ref is already current. Only this initial explicit code-sync refresh MAY fetch remote metadata.
- If hook steps changed inputs or config, core MUST refresh using local snapshots only, reload, and replan; it MUST then re-resolve every selected binding against the final tree before data transfer. No hook may use the pre-update plan or generated prelude. The post-hook refresh MUST NOT fetch metadata again; a mismatched metadata identity MUST fail with `ConfigRefreshError` reason `metadata-identity`, requiring explicit reapproval before a new acquisition phase. Changed targets or risks MUST require renewed approval before data mutation.
- `--no-pull` MUST skip transfers, not reload, plan invalidation, translation validation, or the post-checkout hook sequence. Any later failure MUST report the completed checkout and commit ids; it MUST NOT restore the old tree or conceal the side effect. No previously resolved data handle may be reused after checkout.
- Dirty paths MUST block code sync except the preservation set: `.lando.local.yml`, `.lando.user.yml`, `.lando/`, and already ignored paths. Core MUST preflight file/directory collisions against the target tree, including ignored files that Git could overwrite, and refuse any loss of preserved or untracked content.
- `--force` MAY permit non-overwritten tracked edits outside that set only with explicit typed confirmation; it MUST NOT discard edits or bypass collision checks. Receipts MUST name preserved paths. Versioned Landofiles, includes, and lockfiles follow the branch; core MUST NOT copy the prior Landofile over tracked content.
- Core MUST publish `pre-code-sync`/`post-code-sync` with remote, environment, redacted URL, exact ref, and before/after commit ids, never credentials or agent material.

Tagged errors are `CodeSyncError`, `CodeSyncUnavailableError`, `CodeSyncNotRepositoryError`, `CodeSyncRemoteMismatchError`, `CodeSyncDirtyTreeError`, `CodeSyncDivergedError`, and `CodeSyncInProgressError`. `TestCodeSync` supports contract testing.

#### 10.12.2 Post-processing

Post-processing (hostname replacement, cache rebuild, salt regeneration) MUST be declared, not hidden inside `Dataset.apply`.

- Landofile `events:` MAY supply the four reserved hooks registered by §8.5.7: `post-pull`, `post-push`, `post-switch`, and `post-code-sync`. Recipes and translators MUST declare these visibly. `post-code-sync` steps run once per successful code phase in the shared §10.12.1 sequence for pull-with-code and switch: after initial target refresh/reload/replan and before final validation or data transfer.
- `ServiceTypeResolution.sync.postApply` MAY declare tasks per dataset kind. After all selected local applies succeed, core MUST group service-bound bindings by `(local service identity, kind)` and execute each group's task list exactly once. Groups MUST run serially in database/files/config/blob order, then ascending service-id order within a kind; tasks keep declaration order. Two database bindings on one service form one group; file-only targets without a local service have no service-type postApply group.
- All service-type postApply groups MUST finish before the user's `post-pull` steps run once. A switch that includes a pull MUST run that complete pull sequence, including `post-pull`, before `post-switch` runs once; `--no-pull` skips postApply and `post-pull`, but still runs `post-switch` after the successful code sequence. Push MUST run `post-push` once after all sends succeed and MUST NOT run local postApply tasks. Any required failure MUST prevent later groups and success hooks.
- Group tasks MUST use that service's execution context and §6.9 scoped overrides, not event-carried credentials. Failed or skipped required applies MUST prevent post-apply tasks.
- A required hook or post-apply failure MUST return a failed outcome/nonzero exit, the failing step, remediation, and a receipt of work actually completed. A `post-code-sync` failure before data transfer MUST report `code updated, post-code-sync failed`, not claim that data applied. A required failure after data apply MUST report `data applied, post-processing failed` with the retained applied-data receipt. Neither failure may trigger automatic snapshot restore or claim rollback.

#### 10.12.3 Setup and credentials

`RemoteSource.setup(cfg, ctx)` is optional and idempotent. `app:remote:setup` and init source-auth (§8.8.13) MUST share it.

- `ctx` grants `InteractionService`, the plugin credential view (§9.5.1), `SshService`, and `HttpClient`. Setup MUST NOT plan, start services, or move app data. Explicit consent MAY import a vendor CLI credential from declared paths; it MUST NOT import Lando 3 state.
- Setup MUST persist durable user grants (API/machine tokens, client credentials, basic credentials, and OAuth refresh grants) through the credential view and return `${secret:lando://<namespace>/<id>}` references. Raw values MUST NOT enter config, answers, events, or receipts.
- Access tokens and per-resource credentials MUST remain in memory or the owning `lando-session` store, referenced as `${secret:lando-session://<session>/<id>}`. They MUST NOT overwrite a durable grant or persist in `lando`. They MUST be redactor-registered before use and discarded at scope closure.
- The source MUST renew/re-exchange expiring access credentials before requests throughout long operations, with a declared clock-skew margin. An expired credential MUST NOT be sent merely to provoke renewal. Unrefreshable expiry MUST fail with `RemoteAuthError` reason `expired` and setup remediation.
- Optional `refreshCredential(ref)` rotates a durable grant, not an access-token cache. Grant refresh MUST be serialized per reference across callers, recheck the current grant under lock, and atomically replace the grant/metadata together. Uncertain vendor rotation or failed persistence MUST fail visibly with reauthorization remediation, not replay an invalidated refresh grant.
- `describe` metadata MAY record `kind`, `expiresAt`, `issuer`, and `scopes`; user-entered scope claims MUST NOT prove permission. Nonrefreshable credentials within 14 days of expiry SHOULD produce an expiring-credential diagnostic in test/doctor with rotation remediation.
- `auth` lists supported methods in setup order: `none`, `api-token`, `client-credentials`, `oauth` (`loopback` or `device`), `basic`, `ssh`, `ssh-certificate`, or `custom`. OAuth MUST NOT be assumed; custom browser handoffs MUST obey §10.3.5 interaction, egress, and redaction policy.
- For `ssh`, setup MUST let the user select a usable identity or explicitly consent to generating one, and register public keys idempotently by fingerprint. For `ssh-certificate`, `sshCredential(env)` MUST issue/renew certificates on demand; static key registration MAY be an explicitly supported alternative, never an automatic fallback. Unavailable signing MUST fail without weakening host verification.
- `requiredScopes` MUST declare least-privilege requirements per operation. `test` and per-unit resolution MUST use vendor introspection or a read-only permission probe to establish effective access. Proven missing permission MUST fail with reason `scope`; unavailable evidence MUST report reason `permission-unknown`, not invent missing scopes or accept user metadata as proof.
- Vendor secret-store references MAY resolve individual values through their contributed `SecretStore`; bulk export via pull MUST NOT be supported. Selected readable application config uses the separate §10.12.7 data contract.
- Non-interactive setup MUST reuse an existing authorized reference or fail before browser/listener activity; `--force` re-runs setup but MUST NOT bypass interaction or protection. Stored grants and registered keys MUST appear as nonsecret side effects in the receipt, without rollback promises.

Events are `pre-remote-setup` and `post-remote-setup`.

#### 10.12.4 Vendor tool execution

`RemoteCapabilities.tool` is one descriptor containing execution mode, provisioning identity, and unsupported subcommands.

- `execution: host` MUST use §10.3.4 provisioning and scoped `ProcessRunner`.
- `execution: service` MUST name the tool-bearing service type, user, and cwd, with pinned build provenance (§6.3). Core MUST resolve the running healthy service from its applied plan and selected provider, and use streaming `execStream`. Credentials MUST use invocation-only per-key overrides (§6.9), never argv.
- Both modes MUST honor protocol-specific policy (§10.3.1), strict server identity, cancellation, and redaction. Unsupported network policy MUST fail with `RemoteToolMissingError` reason `network-policy`.
- Tools MUST NOT receive a runtime socket or start nested containers. `tool.unsupported` MUST identify subcommands requiring that access; invocation MUST fail with reason `container-runtime` and supported Dataset/client remediation. Ordinary vendor tools MUST NOT start services implicitly.

#### 10.12.5 Service tunnels and tethered sessions

Optional `openTunnel(cfg, env, unit)` returns a scoped `network` endpoint. Capture through it MUST obey ordinary pull resolution, mode selection, approval, and producer/consumer lifetime; it does not authorize remote writes.

- Tether MUST exist only as foreground `app:remote:tether <remote>@<env>` with explicit repeatable `--unit`. It MUST NOT have a top-level alias, persisted opt-in, detached form, Landofile mode, or recipe/translator output. MCP, host proxy, programmatic CLI/library calls, recipe commands, and tooling dispatch MUST reject entry to tether.
- Tether MUST reject production, staging, unknown, unlisted, or effectively protected environments and actual resources (§10.12.8). A development environment referencing a production database MUST be rejected. No `--yes`, `--force`, or `--allow-exposure` may override eligibility.
- Tether MUST require interactive typed confirmation of the exact remote/environment and every selected unit, explaining that application writes affect the remote and local snapshots do not protect it. Its `yes` declaration MUST follow §8.3.1, but a true `--yes`/`-y`, `--no-interactive`, or generic approval MUST fail with `RemoteProtectedEnvError` reason `tether-requires-interactive`, including on a TTY.
- The app MUST initially be stopped. Before start, core MUST verify provider reachability, original TLS/SSH identity, session ownership, and revocation capability. Host loopback MUST NOT be assumed reachable as container loopback; any bridge MUST be restricted to session consumers.
- Every consumer MUST connect through session-owned revocable forwarding, even when the source supplies a directly reachable endpoint. Core MUST NOT deliver reusable remote credentials or a bypassable raw remote address to consumers. If protocol/provider constraints cannot enforce this, tether MUST fail before start with `RemoteTunnelError` reason `session-revocation`.
- The foreground scope MUST own forwarding, per-service per-key overrides (§6.9), and all runtime consumers it starts. Crash handling MUST disconnect access through process-bound forwarding or a verified supervisor/vendor-enforced lease; provider restart policy MUST NOT restore access. Unsupported crash revocation MUST be refused, not solved by inventing a persistent daemon.
- Normal close, error, interrupt, or `app:stop` MUST disconnect forwarding first, stop/remove session consumers next, and close session secrets last. Cleanup failures MUST be visibly recorded with recovery instructions and projected with role `cleanup` through §8.11.1, as the primary when no other failure exists or as an additional error otherwise. Deleting an environment map is not revocation; local volumes MUST NOT be purged.
- `app:info`, renderer status, lifecycle payloads, and tooling status MUST show nonsecret `tethered: { remote, env, units }`. Concurrent start, restart, rebuild, pull, push, and switch MUST be blocked under the session's lifecycle ownership. Tooling MAY execute inside the existing session but MUST NOT create detached consumers or initiate another tether.

Events remain `pre-tunnel-open`, `post-tunnel-open`, `pre-tunnel-close`, `post-tunnel-close`, `pre-tether`, and `post-tether` (§3.5). Errors are `RemoteTunnelError` and `RemoteProtectedEnvError`, with explicit eligibility, interaction, reachability, and revocation reasons.

#### 10.12.6 Environment operations

Environment workflows (wake, pause/resume, cache clear, clone content, deploy, create/merge/delete branch environments) MUST remain plugin-owned, not disguised as datasets or code sync.

- Optional `RemoteSource.operations` lists `RemoteOperation { id, summary, scope: environment | project, destructive, inputs }`, with schema-defined inputs and `run(cfg, env, inputs)` returning `RemoteOperationResult` or `RemoteWorkflowHandle`.
- Core MUST validate all source/destination resources, enforce §10.12.8, invoke `run` once, and poll the handle with bounded `runProbe`. Only vendor-deduplicated replay with the same key MAY repeat a mutation.
- Plugins MUST project operations in their own `cspace`, not `app:remote:*`. Core dispatch MUST publish `pre-remote-operation`/`post-remote-operation` with redacted inputs and result/handle under §3.5 and §8.11.
- Pull prerequisites MUST use declared `prepare` steps rather than require manual prerequisite commands.

#### 10.12.7 Config datasets

The bundled `dotenv` plugin implements the `config` Dataset; other document formats MAY use other Dataset plugins. Config payloads are app data, not control-plane credential storage.

- Ordinary pull MUST land in one app-root-contained, untracked, gitignored, owner-private file. The plugin MAY default to `.env.local` or `.env.<env>`; overrides MUST retain containment and reject symlink escapes. A tracked or unignored target MUST fail with `DatasetBindingError` reason `tracked-target`; there is no tracked-target bypass.
- Before mutation, core MUST validate secret-bearing stages, backups, and snapshots as well as the target: owner-only file access, owner-controlled repository parents without group/world write access, ignored paths within the repository, and exclusion from exports/support bundles. An ordinary `0755` checkout MAY contain a `0600` config file; Lando-owned secret-storage directories MUST remain private. Windows MUST enforce equivalent ACL protections. A sibling `*.bak` MUST NOT inherit an ignore assumption from the target. Unsafe auxiliary storage MUST abort before any secret is written (§12.4.1).
- Apply MUST merge only selected readable keys, preserve local-only keys, ordering, and comments, and record changed key names without values. Values MUST enter the redactor before write. POSIX files MUST use mode 0600; Windows MUST enforce equivalent owner-only ACLs.
- Merge MUST obey §10.13 ownership and conflict rules. Pre-existing/user-adopted files MUST be skipped or conflict; remediation MUST offer a new target or explicit reconciliation through the existing conflict policy. `adopt` relinquishes management, not permission to overwrite. Changes since the owned digest MUST conflict; approved merges MUST preserve local-only content and establish the new managed digest.
- `readable: false` keys MUST be reported as unavailable. `unreadable: keep-local` (default) MAY preserve an existing local value; `omit` MUST omit the incoming key. Neither policy may synthesize a sendable value or silently delete a local key. A diagnostic comment MAY mark missing data but MUST NOT become a config value.
- Vendor connection strings, resource credentials, and topology variables MUST be omitted with diagnostics or explicitly mapped by the plugin to LOCAL provider endpoints. Ordinary config pull MUST NOT wire an app to a remote database/storage resource. Vendor secret-store bulk export MUST remain disallowed.
- Outbound config push MUST require an explicit key allowlist and successful per-unit push resolution. Local-only keys MUST NOT be included automatically. Absent, unavailable, or placeholder values MUST be rejected or excluded with diagnostics, never sent as literals; absence MUST NOT imply deletion. An explicit local value for a vendor write-only key MAY be sent when allowlisted.
- Standalone pull MUST NOT promise an overlay for a later process's start. Same-scope consumers such as tether or a vendor tool MAY receive ephemeral named overrides under §6.9; no file or persisted opt-in may retain them for a future invocation.
- Temporary transfer payloads MUST be scope-owned and removed on closure; the approved config target and safety backups/snapshots MAY persist under their private-storage rules. This exception MUST NOT permit access tokens or control-plane grants in config files, caches, or journals.

#### 10.12.8 Effective protection and approval

- Core MUST compute effective protection for every actual target from environment classification, vendor resource classification/protection, and source `protectedByDefault`. Production, staging, unknown, vendor-protected, or source-protected targets MUST be protected; caller flags, config, and weaker parent-environment labels MUST NOT downgrade them.
- Unknown classification MUST remain unknown and MUST block tether and remote writes until evidence establishes eligibility. Known protected writes MUST fail closed until permission evidence and required confirmation permit the exact action; vendor locks and explicit vendor prohibitions MUST never be disabled or bypassed.
- Read-only pull from an exactly resolved, authorized target MAY proceed when classification is unknown, under ordinary sync consent that prominently discloses the unknown classification. This permission MUST NOT authorize mutating preparation, remote writes, or tether; local snapshot and overwrite safeguards still apply.
- Push and destructive operations MUST explicitly select the environment and all target resources, including clone destinations and project-wide effects. List order, a default environment, and a read endpoint MUST NOT supply mutation authorization. Unresolved or unbounded target sets MUST fail before mutation.
- General sync consent MUST name remote, environment, bindings, and planned side effects. `--yes` MAY supply ordinary consent; `--no-interactive` without it MUST fail. Remote commands MUST declare `yes` where §8.3.1 requires it; remote orchestration consumes the CLI-decoded flag and MUST NOT redeclare, reparse, or widen it, so `--yes` never adds code, exposure, or protected-target scope. Protected writes and protected preparation additionally MUST require `--force` plus interactive typed confirmation of the exact `<remote>@<env>` and displayed resource set; generic yes/elicitation MUST NOT substitute.
- CLI, library, MCP, host proxy, plugin operation dispatch, and recipe/tooling entry points MUST enforce the same central policy. Non-interactive callers MUST reject actions needing typed confirmation; caller-controlled input MUST NOT assert that confirmation occurred. Tether has the stricter entry-point and target exclusions in §10.12.5.
- Approval MUST bind to resolved identities and semantics. Changes to target, access, format, exposure, freshness, or side effects MUST invalidate approval. Alternate endpoints MAY reuse approval only under the equivalence rules in §10.11.1.

Tagged errors are `RemoteError`, `RemoteUnreachableError`, `RemoteAuthError`, `RemoteEnvNotFoundError`, `RemoteDatasetUnsupportedError`, `RemoteProtectedEnvError`, `RemoteToolMissingError`, `RemoteTunnelError`, `RemoteOperationError`, `DatasetError`, `DatasetCaptureError`, `DatasetApplyError`, `DatasetBindingError`, and the §10.12.1 `CodeSync*` family. `TestRemoteSource`, a local-filesystem source fixture, `TestDataset`, and `TestCodeSync` support contract testing; the fixture is test-only, not a bundled source.

### 10.13 Managed files

`ManagedFileService` is the fixed core chokepoint for marked, rendered files in the user's working tree. Plugins use the pre-namespaced `LandoPluginContext.managedFiles`; there is no plugin contribution surface.

#### 10.13.1 Contract and ownership

`ManagedFile` names `id`, `owner`, relative `path`, ownership `mode`, `format`, `content`, optional marker, permissions, conflict policy, and base. `ContentSource` tags are `text`, `structured`, `template`, and `inline`. Modes are whole `file`, fenced `block`, and reserved structured `keys`; `landofile` and YAML use the canonical serializer.

`ManagedFileService` exposes `ManagedFilePlan` through `plan`, scoped `apply` with `ApplyOptions` and `ManagedFileResult`, `remove` through `ManagedFileSelector`, `status` as `ManagedFileInfo`, `adopt`, and `release`.

- The `ManagedFileService` layer (`@lando/managed-file/service`) is lazy at bootstrap level `minimal` and inert at construction.
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

- The server runs on `effect/ai` `McpServer.layerStdio` and negotiates MCP protocol versions 2025-06-18, 2025-03-26, and 2024-11-05. `@lando/renderer` implements Effect's `Stdio` contract over Bun stdin and stdout, so it stays the only terminal writer. Inbound frames over 1 MiB end the session with `McpTransportError` before parsing.
- Tools derive from `LandoCommandSpec`, `FlagSpec`, and `ArgSpec`; results use `CommandResultEnvelope` and `encodeCommandResult`; streams use progress notifications and a final result envelope. Each tool declares an `outputSchema` derived from its command result schema, and each result carries the redacted, bounded envelope as `structuredContent` plus a JSON text fallback.
- Optional tooling projection uses `mcp.tooling` or `--tooling` and `runTooling`. Notifications replay redacted bounded `EventService` history.
- Resources are `lando://app/config`, `lando://app/info`, `lando://apps`, `lando://doctor`, and the template `lando://schemas/{name}` with name completion from the public schema registry. Payloads reuse the resolved config, deep info, apps list, doctor, and public schema result schemas, and are redacted and bounded. App-scoped resources resolve through `resolveApp`/`AppSelector` and fail with the existing tagged errors.
- The transport is stdio. Streamable HTTP is not part of this contract; any future outbound HTTP MUST use the standard `HttpClient` (§10.3.2).
- `serve` retains one `LandoRuntime`; app resolution uses `resolveApp`/`AppSelector` (§16.3).
- Effective tools are generated `mcp-allowlist` plus `mcp.allow`/`--allow`, minus `mcp.deny`/`--deny`; deny wins. Destructive commands are never default-allowed, and `app:remote:tether` (§10.12.5) is never allowed: it is absent from the generated allowlist and `--allow` rejects it.
- Dispatch is non-interactive; prompt-requiring commands fail rather than hang, and confirmations require an explicit input. That input is `yes: true` or, when the client advertises elicitation, an accepted `{ confirm: boolean }` elicitation whose message names the app and the consequence. Decline, cancel, or no answer within 120 seconds fails with `CommandConfirmationError` reason `declined`; clients without elicitation get reason `non-interactive`. Elicitation never lifts a deny, and destructive commands stay excluded from the default allowlist.
- Remote dispatch MUST enforce §10.12.8. Generic confirmation/elicitation MUST NOT satisfy protected-target typed confirmation; such calls MUST fail non-interactively, even when explicitly allowlisted.
- Calls are bounded, cancellable fibers; transport close interrupts the serve scope.
- Every result, resource, notification, and JSON-RPC frame MUST be redacted and schema-bounded before retention; oversized serialization fails with `McpTransportError` without invoking application getters or `toJSON` hooks.
- Only effective-allowlist tools are registered with the server, so a call naming any other tool gets the protocol's unknown-tool error. Every call that reaches dispatch, including one rejected for input, capacity, or cancellation, publishes `pre-mcp-call` and `post-mcp-call`; dispatch-level rejections return a tool result with `isError: true` carrying the redacted tagged error.
- `meta:mcp` MUST NOT be host-proxied or recipe-scaffolded. Doctor validates allowlist freshness, catalog generation, and a canary round trip.

Tagged errors are `McpToolNotAllowedError`, `McpToolInputError`, `McpTransportError`, and `McpAllowlistConflictError`; command failures remain inside unsuccessful result envelopes. `McpService` is core-owned and not plugin-replaceable; there is no `mcpServers:` contribution surface.

---
