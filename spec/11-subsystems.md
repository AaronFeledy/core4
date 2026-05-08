# Lando v4 — Subsystems

> **Part 11 of 16** · [Index](./README.md)
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
- Whether a `sshAgent.sidecar: false` opt-out is permitted (reverting to the v3-era direct-mount behavior) remains an open decision (§14.2). Until that decision lands, the spec treats `false` as reserved: setting it MAY produce a warning today and MAY be rejected at GA.
- Plugins MAY provide alternate SSH-agent implementations via the `features` contribution surface. Alternate implementations MUST declare their security posture in the feature manifest so `lando doctor` can surface non-default agent forwarding.

### 10.5 Healthchecks and scanner

**Healthcheck behaviors:**

- Healthchecks support `false`/`disabled`, string, string-array, object, and `!load`/`!import` forms.
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
            [--skip-shell-integration]
```

By default, `lando setup` installs the Lando-managed runtime without requiring any pre-existing Docker or Podman installation. Users who prefer a system runtime pass `--provider=docker` or `--provider=podman`; those providers assume the corresponding system installation already exists.

Rules:

- Provider plugins declare additional setup flags via the `setup.flags` manifest field.
- Platform-specific elevation runs through `PrivilegeService`.
- Linux commands that may prompt for sudo set `SUDO_ASKPASS` when an askpass helper is available.
- Setup honors corporate proxy and custom CA configuration for every Lando-owned download or registry call (§10.3.1).
- `lando shellenv` prints shell-profile snippets to add `<userDataRoot>/bin` to `PATH`.

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

**`runLando` allowlist.** The dispatcher consults the `host-proxy-allowlist` cache (§12.1), which is generated from every `LandoCommandSpec` with `hostProxyAllowed: true` (§8.3), every plugin command with the same flag, and every tooling task with `hostProxyAllowed: true` (§8.5). Requests for canonical ids outside the allowlist are rejected with `HostProxyCommandNotAllowedError`. Lifecycle commands (`app:start`, `app:stop`, `app:restart`, `app:rebuild`, `app:destroy`, `apps:poweroff`) MUST NOT be on the allowlist; the spec rejects any plugin or tooling task that attempts to add them with `HostProxyAllowlistConflictError` at registration.

**Recursion guard.** Every dispatched `runLando` invocation increments `LANDO_HOST_PROXY_DEPTH` in the env passed into the host re-entry. If the inbound request already carries `LANDO_HOST_PROXY_DEPTH >= 3`, the dispatcher refuses with `HostProxyRecursionLimitError`. This bounds runaway loops in a misbehaving container without preventing legitimate two-hop scenarios.

**Concurrency cap.** The dispatcher caps in-flight requests at 16 per app (configurable via global `hostProxy.maxConcurrent:`); excess requests get HTTP 429 with `HostProxyBackpressureError`. This stops a runaway container from DoS-ing the host runtime.

#### 10.10.3 In-container shim

The `lando.host-proxy` feature ships **one** Bun-compiled static binary at `/usr/local/lib/lando/host-proxy-client` inside `type: lando` services and symlinks it as:

- `/usr/local/bin/xdg-open`
- `/usr/local/bin/open`
- `/usr/local/bin/lando`

The binary dispatches on `argv[0]` (host-spawn pattern):

| `argv[0]` | Wire request | Notes |
|---|---|---|
| `xdg-open` / `open` | `{ "_tag": "openUrl", url: argv[1] }` | The shim refuses extra arguments to keep `xdg-open <single-url>` semantics intact. Multiple URLs require multiple invocations. |
| `lando` | `{ "_tag": "runLando", argv: argv.slice(1), cwd: process.cwd(), tty: isatty(0), env: <filtered> }` | `cwd` is the container path; the host dispatcher remaps it to the host app root using the active `AppMountInfo` (§6.4). The shim filters env to a small allowlist (`LANDO_*`, `LC_*`, `LANG`, `TERM`) before forwarding so container-leaked env never poisons the host program. |

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
