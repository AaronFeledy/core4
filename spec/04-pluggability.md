# Lando v4 — Pluggability Catalog

> **Part 4 of 18** · [Index](./README.md)
> **Read next:** [05 Runtime Providers](./05-runtime-providers.md)

This part is the contract index for the entire system. Every replaceable abstraction in v4 is listed here with its Effect Service tag, its responsibility, the default implementation, and the swap mechanism. It also covers the pluggability principles, the selection precedence rules when multiple plugins implement the same abstraction, the manifest contribution shape, and the mandatory guarantees every abstraction interface must satisfy (Effect-typed, Schema-defined, tagged errors, capability-declared, resource-safe, idempotent).

This is the master reference for "what is plug-everything." Subsequent parts deep-dive into the most important plug points (providers, services, plugins, subsystems).

---

## 4. Pluggability Catalog

This section is the contract index. Every replaceable abstraction in v4 is listed here with its Effect Service tag, its responsibility, the default implementation, and the swap mechanism.

### 4.1 Pluggability principles

1. **Service tag = contract.** A service tag plus its interface (defined as Effect Schemas where data crosses the boundary) is the *only* way core consumes a capability.
2. **Layer = implementation.** Implementations are Effect Layers. The composed `LandoRuntimeLive` is built at the imperative shell.
3. **Manifest = registration.** Plugins declare which abstractions they implement in their manifest. Core wires the corresponding Layer into the runtime.
4. **Selection is config-driven.** When more than one plugin implements the same abstraction, selection is determined by global config, Landofile config, or capability matching — never by import order or filesystem position.
5. **No partial swaps.** A plugin replaces an abstraction in full. There is no "partial override" mechanism. Cross-cutting concerns are handled by composing Layers explicitly.

### 4.2 The catalog

| Abstraction | Service tag | Responsibility | Default | Pluggable mechanism |
|---|---|---|---|---|
| **Containerization** | `RuntimeProvider` | Apply app plans, exec, logs, build artifacts, manage instances | `@lando/provider-lando` (Lando-managed runtime) | Plugin contributes `providers:` in manifest. User selects with `provider:` in Landofile or `defaultProvider` global. Multiple providers may be installed; one is selected per app. |
| **File sync** | `FileSyncEngine` | Realize accelerated bind mounts when the active `RuntimeProvider` declares `bindMountPerformance: "slow"` (§5.4): create, pause, resume, terminate sync sessions; surface conflict and progress streams as `file-sync-*` lifecycle events (§3.5). Engines are session-stateful (a session per accelerated mount, lifetime bound to `app:start` … `app:stop`) and pluggable per the standard §4.3 selection rules. Engines MUST NOT speak to provider runtimes directly; they observe `MountPlan`s the planner has marked `realization: "accelerated"` and read/write through the provider's storage capabilities | Built-in `passthrough` engine (no-op; the provider's native bind mount realizes the `MountPlan` directly) — registered eagerly at level `plugins`. **Bundled default for `bindMountPerformance: "slow"`:** `@lando/file-sync-mutagen` (Mutagen-backed; bundled per §1.4). Library consumers receive only `passthrough` unless they opt into the bundled set | Plugin contributes `fileSyncEngines:`. Selected per app by `bindMountPerformance` (provider) → `defaultFor.bindMountPerformance` matchers (plugin) → global `defaultFileSyncEngine:` → sole-installed-implementation, per §4.3. The user-facing Landofile MUST NOT carry an engine-id field by default; the planner picks the engine without explicit user input. Per-mount `accelerate: false` and global `defaultFileSyncEngine: passthrough` are escape hatches for advanced users and are not surfaced in canonical recipes or generated tutorials. |
| **Tooling execution** | `ToolingEngine` | Translate a compiled Lando task graph from `tooling:` into provider or host operations | Two engines ship **built into core** (not as plugins): `providerExec` (default; `RuntimeProvider.exec`-backed; in-service work) and `host` (`ShellRunner` / `Bun.$`-backed; powers `service: :host`, `.bun.sh` scripts, `vars.<name>.sh:`, the `lando shell` REPL, recipe `bun: { verb: script }`, host-target healthchecks/scanners; §1.4, §8.6). Both are present at level `tooling` and selected per call. | Plugin contributes `toolingEngines:`. Selected per command step, task, defaults, Landofile, or global config (§8.6 selection precedence). The `host` and `providerExec` engine ids are reserved by core and may NOT be replaced by a plugin in v4.0; plugins MAY contribute additional engines (e.g., `processExec`, `remote`, `dryRun`). |
| **Template rendering** | `TemplateEngine` | Render a string or whole-file template with the published `TemplateRenderContext` (§7.3.2) into text | Built-in `lando` engine (the §7.3.1 expression language) — always available, the only engine permitted for Landofile string-value interpolation. `@lando/template-handlebars` and `@lando/template-mustache` are bundled as optional whole-file engines. | Plugin contributes `templateEngines:`. Selected per render site by explicit `engine:` field, file extension, Landofile `defaultTemplateEngine:`, or global config (§4.3, §7.3.2). |
| **Console logging** | `Logger` | Structured log events with annotations | Effect `Logger.pretty` for TTY, `Logger.json` for non-TTY | Plugin contributes `loggers:`. Selected by global `logger:` config or `--logger=` flag. |
| **Output rendering** | `Renderer` | Render task progress, tables, banners, errors | Built-in default renderer | Plugin contributes `renderers:`. Selected by `--renderer=` flag, `LANDO_RENDERER`, or TTY/CI detection. |
| **Schema validation** | `SchemaValidator` | Validate Landofile/manifest data | Effect Schema | **Reserved (v4.0 not user-swappable).** Effect Schema is the only validator on the hot path; the service tag is reserved so a future major can introduce an alternate validator (e.g., for plugin authors who want a different library *internally*) without re-opening the catalog. Listed here so the catalog enumerates every reserved abstraction; do not implement plugin-side overrides for it in v4.0. |
| **Config translation** | `ConfigTranslator` | Translate external config files into Landofile fragments for preview or application | None bundled by default | Plugin contributes `configTranslators:`. Invoked explicitly through `lando app config translate`; never runs during normal app startup. |
| **CLI framework** | `CommandFramework` | Argv parsing, manifest, help, plugin install commands, namespace-to-topic mapping, top-level alias registration (§8.1.1, §8.1.2) | OCLIF | Replaceable but not recommended. Core ships only the OCLIF adapter. Building a `@effect/cli` adapter is documented. |
| **Filesystem** | `FileSystem` | Read, write, watch, glob | `Bun.file`/`Bun.write` | Replaceable for sandboxing or remote-FS use cases. |
| **Process execution** | `ProcessRunner` | Argv-precise subprocess spawn (no shell parsing) | `Bun.spawn` | Replaceable for telemetry, sandboxing, dry-run modes. Used for provider exec, signing tools, and other "exact binary, exact arguments" calls (§3.4 ProcessRunner-vs-ShellRunner table). |
| **Shell execution** | `ShellRunner` | Cross-platform shell-shaped execution: pipes, redirection, globs, built-in `rm`/`mkdir`/`cat`/`mv`/`which`, command substitution, `.bun.sh` script files | `Bun.$` (Bun Shell) | Replaceable for audited / dry-run / sandboxed shell. Backs the `host` ToolingEngine (§8.6), tooling `vars.<name>.sh:` for `service: :host` (§8.5.3), `.bun.sh` script-backed tasks (§8.5.9), the `lando shell` REPL (§8.2.3), host-target healthchecks/scanners (§10.5), recipe `bun: { verb: script }` post-init (§8.8.8), and `lando doctor` transcripts (§10.9). Complementary to `ProcessRunner`, not redundant; core code MUST NOT use one to imitate the other (§3.4). |
| **Bun self-execution** | `BunSelfRunner` | Self-spawn the compiled binary with `BUN_BE_BUN=1` so it acts as the upstream `bun` CLI (§2.1, §3.4). Drives plugin install/update (§9.6), `lando bun` / `lando x` (§8.2.4), recipe `bun:` post-init action verbs `install` / `add` / `create` / `run` / `x` (§8.8.8), `npm:` / `registry:` `includes:` materialization (§7.7), and the plugin authoring toolkit (§9.10) | The compiled `lando` binary, self-spawned with `BUN_BE_BUN=1`; library-mode fallback to a system `bun` on PATH | Replaceable for audited / dry-run / sandboxed / mirror-aware Bun dispatch, headless CI variants that swallow `x` calls, and air-gapped variants that refuse uncached registry reads. Plugins MUST honor the verb-shape contract from §3.4 (`install`, `add`, `remove`, `x`, `create`, `runScript`, `buildLib`, `publishPkg`) and MUST NOT weaken the §3.4 redaction or recursion-guard contracts. |
| **Outbound HTTP** | `HttpClient` | The single outbound-egress chokepoint for all Lando-owned network access (§10.3.2): resolve proxy/CA trust through the canonical resolver, perform streaming request/response and upload, redact credentials, publish `pre-/post-http-call` events, honor cancellation and offline policy. Consumed by `Downloader`, hosting push/pull, telemetry delivery, the update-manifest fetch, plugin-registry queries, tunnel/share control planes, the in-process MCP surface, and the `UrlScanner` | Built-in `HttpClientLive` using Bun `fetch` and the canonical network-trust resolver | Plugin contributes `httpClients:`. Replaceable for audited distributions, mirror-aware, air-gapped, sandboxed library hosts, and corporate egress gateways. Selection follows §4.3; implementations MUST NOT weaken proxy/CA honoring, redaction, scheme policy, or cancellation finalization. |
| **Verified downloads** | `Downloader` | Verified-artifact specialization layered over `HttpClient`: fetch bytes via `HttpClient.stream`, verify SHA-256 and optional size, stream to memory or an atomic destination, enforce `https://` by default with explicit `file://` override gates for local CI/dev artifacts, emit `download-progress`, and cooperate with offline/cache policy (§10.3.3). Tool provisioning (§10.3.4) installs pinned host binaries over it | Built-in `DownloaderLive` over `HttpClient`, `CacheService`, and `FileSystem` | Plugin contributes `downloaders:`. Replaceable for mirror-aware or artifact-cache behavior; contributed implementations MUST route every byte of egress through the resolved `HttpClient` and MUST NOT open their own sockets. Selection follows §4.3; implementations MUST NOT weaken checksum verification, path containment, redaction, or atomic-write guarantees. |
| **Privilege escalation** | `PrivilegeService` | Run a host command as root/admin | Platform-specific (`sudo`, `pkexec`, UAC) | Replaceable to support `polkit`, `doas`, custom credential prompts. |
| **CA / certificates** | `CertificateAuthority` | Generate/store dev CA, issue leaf certs | `@lando/ca-mkcert` | Plugin contributes `certificateAuthorities:`. |
| **Proxy / routing** | `ProxyService` | Realize `RoutePlan`s into running ingress | `@lando/proxy-traefik` | Plugin contributes `proxyServices:`. |
| **Public tunnels / sharing** | `TunnelService` | Expose a running app route or service endpoint through a public, provider-managed tunnel for `lando share` and embedding-host share flows (§10.2.2): resolve a tunnel target from the app's `RoutePlan`/service endpoint, perform provider control-plane calls through `HttpClient`, provision any required connector binary through the tool-provisioning helper over `Downloader`, supervise the connector through `ProcessRunner`, persist detached sessions through `StateStore`, publish tunnel lifecycle events, and redact public URLs/tokens consistently | No always-on default in v4.0. The bundled quick-share implementation that ships with `lando share` is selected when installed (e.g. a Cloudflare/ngrok-backed plugin) | Plugin contributes `tunnelServices:`. Selected by explicit `--provider`, Landofile/global default, then sole installed implementation per §4.3. Implementations MUST pass the TunnelService contract suite (§13.1), MUST route control-plane egress through `HttpClient`, MUST NOT move local/volume bytes (use `DataMover` only in features that also transfer data), and MUST NOT weaken redaction, cancellation, detached-state, or scope-finalization guarantees. |
| **Remote data sync** | `RemoteSource` | Move named datasets (DB, user files, config) between a running local Lando app and a *remote* — pull (remote→local) and push (local→remote) — for `lando pull`/`push` and embedding-host sync flows (§10.12). A *remote* is any place that holds app datasets across one or more environments: a hosting platform (Pantheon/Acquia/Platform.sh/Lagoon), a generic transport (rsync/ssh/s3/url/local), or a future peer/CI-artifact source. The `RemoteSource` performs control-plane + byte-fetch through `HttpClient`, provisions any vendor CLI through the tool-provisioning helper over `Downloader`, persists remote/lock state through `StateStore`, and produces/consumes a portable artifact that a `Dataset` lands locally. "Hosting" is the marquee category, not the contract name. | No always-on default in v4.0. Generic `rsync`/`ssh`/`url`/`local`/`s3` remotes ship bundled with the 4.1 `lando pull`/`push` feature; hoster remotes ship as plugins | Plugin contributes `remoteSources:`. Selected by `<remote>[@<env>]` / `--remote`, Landofile `remotes.<name>.source`, then sole installed implementation per §4.3. Implementations MUST pass the RemoteSource contract suite (§13.1), MUST route egress through `HttpClient`, MUST NOT re-implement the local landing half (delegate to the resolved `Dataset` + `DataMover`), MUST default `push` off for protected environments, and MUST NOT weaken redaction, scheme/containment, or scope-finalization guarantees. |
| **Dataset** | `Dataset` | A typed, named slice of syncable app state (`database` \| `files` \| `config` \| `blob`) with a portable serialization and local `capture` (local→portable artifact) / `apply` (portable artifact→local) operations (§10.12). Decouples *what* moves from *where* it lives so the local landing half is reusable across every `RemoteSource`: a `database` dataset lands identically whether pulled from Pantheon, rsync, or S3. `capture`/`apply` run through `DataMover` (`serviceCmd`/`stream`/`hostPath` endpoints) and read DB connection details from `creds:` (§6.12.4). Typically contributed by a service-type (`database`) or app-feature (`files`). | None bundled by default; the `files` dataset ships with the 4.1 feature, the `database` dataset ships in the bundled `@lando/sql` plugin (engine-specific dump/import stays out of core, §10.7) | Plugin contributes `datasets:`. A resolved app plan exposes its `datasets`; the `pull`/`push` orchestrator binds each to its target service. Implementations MUST pass the Dataset contract suite (§13.1), MUST move bytes only through `DataMover`, MUST pass DB creds via env (never argv), and MUST be idempotent/replay-safe. |
| **Healthcheck runner** | `HealthcheckRunner` | Execute a `HealthcheckPlan` and report status | Built-in via `RuntimeProvider.exec` | Plugin contributes `healthcheckRunners:` for native or external probes. |
| **URL scanner** | `UrlScanner` | Probe URLs after start | Built-in scanner probing through `HttpClient` (§10.3.2) | Plugin contributes `urlScanners:`. |
| **Doctor diagnostics** | `DoctorService` | Run host/app/provider diagnostics and expose automated or manual remediations | Built-in core checks for app config and selected-provider basics | Plugin contributes `doctorChecks:` for additional issue coverage. |
| **Host proxy** | `HostProxyService` | Per-app container→host RPC dispatch: open URLs in the host browser, route in-container `lando` shim calls back into the host runtime, host clipboard/notification dispatch (§10.10) | Built-in `HostProxyServiceLive` (Bun-served HTTP/JSON over a per-app Unix socket) | Plugin contributes `hostProxyServices:`. Replaceable for headless CI builds (swallow URL opens), audited builds (mandatory transcript), or remote-host transports. Selection follows §4.3. |
| **Plugin source** | `PluginSource` | Resolve and fetch a plugin spec | Built-in: registry (Bun), git, local, tarball | Plugin contributes `pluginSources:` for private registries, GitLab, etc. |
| **Init source** | `InitSource` | Provide source materials for `lando apps init` | Plugin-only | Plugin contributes `initSources:`. |
| **Service type** | `ServiceType` | Resolve `type: <name>` into normalized config + features | Bundled catalog from `@lando/service-lando` and `@lando/service-*` (PHP, Node, Python, Ruby, Go, common databases, caches, mail, search, queues, static, plus `lando` and `l337` bases) — see §6.11 | Plugin contributes `serviceTypes:` to add or replace. |
| **Service feature** | `ServiceFeature` | Mutate a service plan with a composable feature | Plugin-only | Plugin contributes `features:`. |
| **App feature** | `AppFeature` | Mutate selected services across the app plan when a triggering service is present (e.g., a Mailpit service injecting SMTP env into PHP siblings). Selector-driven, idempotent, app-scoped — §6.11.4. | Plugin-only | Plugin contributes `appFeatures:`. |
| **Global service** | (no service tag — manifest-driven contribution surface) | Contribute a service to the host-level **global app** (§20). The contribution module returns a `ServiceConfig`; the global app's `dist` Landofile layer is regenerated from every enabled contribution at level `plugins`. Plugins typically pair this with an `AppFeature` (§6.11.4) that injects discovery env (`MAIL_HOST=mailpit.global.internal`) into matching user-app services so users get the service for free without Landofile changes. | Plugin-only | Plugin contributes `globalServices:`. Default enablement is `enabledByDefault: true\|false` per contribution; user override lives in `<userConfRoot>/global.config.yml` (§20.3.1) and is toggled by `meta:global:install <plugin>` / `meta:global:uninstall <plugin>`. |
| **Route filter** | `RouteFilter` | Provider-neutral request/response transforms | Built-ins: `requestHeader`, `responseHeader`, `redirect`, `rewritePath`, `stripPrefix`, `addPrefix` | Plugin contributes `routeFilters:`. |
| **Telemetry** | `Telemetry` | Core usage stats with redaction and disablement controls | Core telemetry collector, enabled by default | Plugins MAY contribute telemetry sinks only through the telemetry service; plugins MUST NOT bypass user/global disablement. |
| **Update channel** | `UpdateService` | Check/apply updates to core and plugins | Built-in registry-channel updater | Replaceable for air-gapped or vendor-managed distributions. |
| **Secret store** | `SecretStore` | Resolve `${secret:...}` references in Landofiles | Built-in env-var store | Plugin replaces with Vault, 1Password CLI, AWS SM, etc. |
| **Interaction / prompts** | `InteractionService` | Resolve typed `PromptSpec`s and batches against the active answer source (explicit answer → default → interactive prompt → fail), own interactivity-mode resolution and `secret` redaction, and drive dynamic `choicesFrom` (§8.10). The single input peer of `Renderer` | Built-in `InteractionServiceLive` (stdio/TTY-backed; `auto` mode in CLI, `non-interactive` in library mode) | Plugin contributes `interactionServices:`. Replaceable for headless/CI (fail-fast non-interactive), recording/test runs, and GUI/host transports (an IDE extension or dashboard that pops native dialogs). Selection follows §4.3; implementations MUST NOT weaken the `secret`-redaction, answer-precedence, or non-interactive-fail-fast guarantees, and MUST pass the §13.1 interaction contract suite. |

`EmbeddedAssetService` is intentionally absent from this plugin catalog. It is a core service (§3.4) that can be overridden by tests or embedding hosts, but plugins cannot replace it because it mediates access to embedded binary/package assets.

`StateStore` is also intentionally absent. Durable on-disk state (§12.7) — atomic, schema-validated, versioned, optionally cross-process-locked document storage — is a state-integrity invariant: there is exactly one implementation, owned by core and constructed eagerly at level `minimal`. Plugins do not contribute alternate stores and there is no `stateStores:` contribution surface; instead, plugins receive a pre-namespaced `StateBucket` factory through `LandoPluginContext` (§9.8) and embedding hosts/tests override the core service. Audited or sandboxed variants of the surfaces that *emit* state still flow their writes through the canonical store.

`PathsService` is likewise intentionally absent. It is a core service (§3.4, §7.5.1) whose roots are overridable by tests and embedding hosts through `RootOverrides` (the `makeLandoRuntime` `config:` option, §16.5), but plugins cannot replace it: the resolution order and platform-default matrix in §7.5 are a fixed contract, and a plugin that relocated Lando's roots out from under other plugins would break the filesystem layout every other contribution assumes.

`RedactionService` is also intentionally absent. Secret/PII redaction (§3.7) is a non-replaceable security invariant: there is exactly one redaction implementation, owned by `@lando/sdk/secrets` and surfaced through the core `RedactionService` (§3.4). Plugins do not contribute redactors and there is no `redactors:` contribution surface. Audited, sandboxed, mirror-aware, or air-gapped variants of the surfaces that *emit* potentially-sensitive output — `ShellRunner`, `BunSelfRunner`, `HostProxyService`, `FileSyncEngine`, `HttpClient`, `Downloader`, `TunnelService`, `DataMover` — MUST compose the canonical redactor and MUST NOT weaken its sentinel, value-set, or pattern coverage; the relevant contract suites (§13.1) enforce this.

The **probe primitive** (`@lando/sdk/probe`, §10.5.1) is likewise intentionally absent. It is neither a service tag nor a pluggable abstraction: it is a pure `RetryPolicy` plus the `runProbe` / `toSchedule` runner that the `HealthcheckRunner`, `UrlScanner`, `DoctorService`, `HttpClient` / `Downloader`, and `lando setup` readiness paths consume to share one deterministic retry/backoff/timeout vocabulary and one green/yellow/red verdict shape. Plugins that implement those abstractions reuse the primitive (they get the shared schedule semantics for free); they do not replace it, and there is no `probes:` contribution surface.

`DataMover` is also intentionally absent. Local/volume byte movement (§10.11) is the on-host counterpart to the `HttpClient` egress chokepoint and is a data-integrity invariant: there is exactly one implementation, owned by core. Plugins do not contribute alternate movers and there is no `dataMovers:` contribution surface. The pluggable seam lives one layer down, in the `RuntimeProvider` data plane (§5.3/§5.4) — a provider plugin implements `snapshotVolume`/`copyToService`/`exportArtifact`/… and declares the matching capabilities, and `DataMover` dispatches to it. This mirrors the `Downloader`→`HttpClient` split: override the substrate (provider data plane / `HttpClient`), not the verified orchestrator. `DataMover` composes the canonical `RedactionService` and MUST NOT weaken its checksum-verification, path-containment, or redaction guarantees.

`ManagedFileService` is also intentionally absent. Managed working-tree writes (§10.13) are a working-tree-integrity invariant: there is exactly one implementation, owned by core, that applies ownership markers, records the `StateStore` ledger, detects conflicts/adoption, and writes atomically. Plugins do not contribute alternate managed-file writers and there is no `managedFiles:` contribution surface; plugins write managed files only through the pre-namespaced `LandoPluginContext.managedFiles` accessor (§9.8). `ManagedFileService` composes the canonical `RedactionService`, the Paths primitive, the `StateStore` ledger, and the shared containment/atomic-write helpers and MUST NOT weaken marker, conflict, path-containment, or redaction guarantees.

### 4.3 Selection precedence

When multiple plugins implement the same abstraction, the selection rule is:

```text
1. Explicit per-context choice (e.g. tooling.<name>.engine, services.<name>.provider override)
2. Landofile global (e.g. provider: docker)
3. Global config (e.g. `<userConfRoot>/config.yml`: defaultProvider: podman)
4. Plugin manifest defaultFor matchers (e.g. default provider plugin with defaultFor: {platform: [darwin]})
5. Sole installed implementation
6. Error: "No <abstraction> plugin selected — install <suggested-plugin>"
```

### 4.4 Manifest contributions

Every contribution surface is declared in a plugin manifest under `provides:`. The manifest schema is in §9.4. A plugin contributes a single Effect Layer per abstraction it provides; the layer is loaded lazily when the abstraction is first requested. Every `module:` path is resolved to an absolute `file://` URL after manifest validation and MUST remain inside the plugin package root after realpath resolution (§9.7).

```yaml
# Excerpt from a plugin manifest
provides:
  providers:
    - id: lando
      module: ./src/provider.ts
      defaultFor:
        platform: [darwin, linux, win32, wsl]
  proxyServices:
    - id: traefik
      module: ./src/proxy.ts
  routeFilters:
    - id: requestHeader
      module: ./src/filters/request-header.ts
  configTranslators:
    - id: terraform
      module: ./src/config/terraform-translator.ts
      inputKinds: [terraform]
  doctorChecks:
    - id: example
      module: ./src/doctor/example.ts
      tags: [example]
  hostProxyServices:
    - id: headless-ci
      module: ./src/host-proxy/headless.ts
  loggers:
    - id: pretty
      module: ./src/logger.ts
  renderers:
    - id: lando
      module: ./src/renderer.ts
  shellRunners:
    - id: audited
      module: ./src/shell/audited-runner.ts
  bunSelfRunners:
    - id: airgapped
      module: ./src/bun-self/airgapped.ts
      capabilities:
        verbs: [install, add, remove, runScript, buildLib]   # explicitly omits `x`, `create`, `publishPkg`
        offlineOnly: true                                    # refuses any registry read that misses the local cache
  httpClients:
    - id: corporate-egress-gateway
      module: ./src/http/gateway.ts
      capabilities:
        streaming: true                                      # exposes a streaming response body (required by Downloader)
        upload: true                                         # supports PUT/POST/multipart bodies (push)
        offlinePolicy: true
  downloaders:
    - id: corporate-mirror
      module: ./src/downloader/mirror.ts
      capabilities:
        schemes: [https, file]
        atomicFileWrites: true
        checksumAlgorithms: [sha256]
        offlineCache: true
        progressEvents: true                                 # routes egress through the resolved HttpClient (§10.3.3)
  fileSyncEngines:
    - id: mutagen
      module: ./src/file-sync/engine.ts
      defaultFor:
        bindMountPerformance: ["slow"]                       # auto-select on slow-IO providers (Docker Desktop, Podman Desktop)
      capabilities:
        modes: [two-way-safe, two-way-resolved, one-way-safe, one-way-replica]
        remoteAgentDeployment: auto                          # engine deploys its own agent into containers
        exclusionPatterns: true                              # honors excludes at the engine level (no volume-shadow fallback)
        conflictReporting: true
        progressReporting: true
  templateEngines:
    - id: handlebars
      module: ./src/engines/handlebars.ts
      extensions: [".hbs", ".handlebars"]
      capabilities:
        wholeFile: true
        stringInterpolation: false
        partials: true
        unsafe: false
```

### 4.5 Mandatory abstraction guarantees

Every abstraction interface MUST satisfy these guarantees:

- **Effect-typed.** Every method returns `Effect.Effect<A, E, R>` or `Stream<A, E, R>`. Synchronous methods are forbidden on plugin-facing interfaces (use `Effect.sync` if needed internally).
- **Schema-defined data.** Every input/output that crosses the trust boundary is an `Schema.Schema<A>`. Plain types are allowed only for values that don't leave a single TypeScript module.
- **Tagged errors.** Errors are `Schema.TaggedError` subclasses defined alongside the interface.
- **Capability-declared.** If the abstraction has multiple feature dimensions (containerization, certs, proxy), capabilities are reported via a typed `capabilities` field, and consumers validate capabilities before invoking optional methods.
- **Resource-safe.** Methods that acquire resources accept or produce a `Scope`. Long-running operations expose cancellation through `Effect.interrupt`.
- **Idempotent where possible.** Apply, register, install, setup methods must be safe to call repeatedly with the same input.
- **Deprecable.** Every public abstraction member supports a `DeprecationNotice` either via schema annotation (data shapes) or a `deprecated?:` field (contract shapes), per the surface deprecation matrix in §18.5. Removing a deprecated member is a release-pipeline-gated event (§18.7).

---
