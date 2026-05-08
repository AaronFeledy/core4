# Lando v4 — Pluggability Catalog

> **Part 4 of 16** · [Index](./README.md)
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
| **Tooling execution** | `ToolingEngine` | Translate a compiled Lando task graph from `tooling:` into provider or host operations | Built-in `ProviderExecToolingEngine` (uses `RuntimeProvider.exec`) | Plugin contributes `toolingEngines:`. Selected per command step, task, defaults, Landofile, or global config. |
| **Template rendering** | `TemplateEngine` | Render a string or whole-file template with the published `TemplateRenderContext` (§7.3.2) into text | Built-in `lando` engine (the §7.3.1 expression language) — always available, the only engine permitted for Landofile string-value interpolation. `@lando/template-handlebars` and `@lando/template-mustache` are bundled as optional whole-file engines. | Plugin contributes `templateEngines:`. Selected per render site by explicit `engine:` field, file extension, Landofile `defaultTemplateEngine:`, or global config (§4.3, §7.3.2). |
| **Console logging** | `Logger` | Structured log events with annotations | Effect `Logger.pretty` for TTY, `Logger.json` for non-TTY | Plugin contributes `loggers:`. Selected by global `logger:` config or `--logger=` flag. |
| **Output rendering** | `Renderer` | Render task progress, tables, banners, errors | Built-in default renderer | Plugin contributes `renderers:`. Selected by `--renderer=` flag, `LANDO_RENDERER`, or TTY/CI detection. |
| **Schema validation** | `SchemaValidator` | Validate Landofile/manifest data | Effect Schema | **Reserved (v4.0 not user-swappable).** Effect Schema is the only validator on the hot path; the service tag is reserved so a future major can introduce an alternate validator (e.g., for plugin authors who want a different library *internally*) without re-opening the catalog. Listed here so the catalog enumerates every reserved abstraction; do not implement plugin-side overrides for it in v4.0. |
| **Config translation** | `ConfigTranslator` | Translate external config files into Landofile fragments for preview or application | None bundled by default | Plugin contributes `configTranslators:`. Invoked explicitly through `lando app config translate`; never runs during normal app startup. |
| **CLI framework** | `CommandFramework` | Argv parsing, manifest, help, plugin install commands, namespace-to-topic mapping, top-level alias registration (§8.1.1, §8.1.2) | OCLIF | Replaceable but not recommended. Core ships only the OCLIF adapter. Building a `@effect/cli` adapter is documented. |
| **Filesystem** | `FileSystem` | Read, write, watch, glob | `Bun.file`/`Bun.write` | Replaceable for sandboxing or remote-FS use cases. |
| **Process execution** | `ProcessRunner` | Argv-precise subprocess spawn (no shell parsing) | `Bun.spawn` | Replaceable for telemetry, sandboxing, dry-run modes. Used for provider exec, signing tools, and other "exact binary, exact arguments" calls (§3.4 ProcessRunner-vs-ShellRunner table). |
| **Shell execution** | `ShellRunner` | Cross-platform shell-shaped execution: pipes, redirection, globs, built-in `rm`/`mkdir`/`cat`/`mv`/`which`, command substitution, `.bun.sh` script files | `Bun.$` (Bun Shell) | Replaceable for audited / dry-run / sandboxed shell. Backs the `host` ToolingEngine (§8.6), tooling `vars.<name>.sh:` for `service: :host` (§8.5.3), `.bun.sh` script-backed tasks (§8.5.9), the `lando shell` REPL (§8.2.3), host-target healthchecks/scanners (§10.5), recipe `bunScript:` post-init (§8.8.8), and `lando doctor` transcripts (§10.9). Complementary to `ProcessRunner`, not redundant; core code MUST NOT use one to imitate the other (§3.4). |
| **Privilege escalation** | `PrivilegeService` | Run a host command as root/admin | Platform-specific (`sudo`, `pkexec`, UAC) | Replaceable to support `polkit`, `doas`, custom credential prompts. |
| **CA / certificates** | `CertificateAuthority` | Generate/store dev CA, issue leaf certs | `@lando/ca-mkcert` | Plugin contributes `certificateAuthorities:`. |
| **Proxy / routing** | `ProxyService` | Realize `RoutePlan`s into running ingress | `@lando/proxy-traefik` | Plugin contributes `proxyServices:`. |
| **Healthcheck runner** | `HealthcheckRunner` | Execute a `HealthcheckPlan` and report status | Built-in via `RuntimeProvider.exec` | Plugin contributes `healthcheckRunners:` for native or external probes. |
| **URL scanner** | `UrlScanner` | Probe URLs after start | Built-in `fetch`-based scanner | Plugin contributes `urlScanners:`. |
| **Doctor diagnostics** | `DoctorService` | Run host/app/provider diagnostics and expose automated or manual remediations | Built-in core checks for app config and selected-provider basics | Plugin contributes `doctorChecks:` for additional issue coverage. |
| **Host proxy** | `HostProxyService` | Per-app container→host RPC dispatch: open URLs in the host browser, route in-container `lando` shim calls back into the host runtime, host clipboard/notification dispatch (§10.10) | Built-in `HostProxyServiceLive` (Bun-served HTTP/JSON over a per-app Unix socket) | Plugin contributes `hostProxyServices:`. Replaceable for headless CI builds (swallow URL opens), audited builds (mandatory transcript), or remote-host transports. Selection follows §4.3. |
| **Plugin source** | `PluginSource` | Resolve and fetch a plugin spec | Built-in: registry (Bun), git, local, tarball | Plugin contributes `pluginSources:` for private registries, GitLab, etc. |
| **Init source** | `InitSource` | Provide source materials for `lando apps init` | Plugin-only | Plugin contributes `initSources:`. |
| **Service type** | `ServiceType` | Resolve `type: <name>` into normalized config + features | Bundled catalog from `@lando/service-lando` and `@lando/service-*` (PHP, Node, Python, Ruby, Go, common databases, caches, mail, search, queues, static, plus `lando` and `l337` bases) — see §6.11 | Plugin contributes `serviceTypes:` to add or replace. |
| **Service feature** | `ServiceFeature` | Mutate a service plan with a composable feature | Plugin-only | Plugin contributes `features:`. |
| **Route filter** | `RouteFilter` | Provider-neutral request/response transforms | Built-ins: `requestHeader`, `responseHeader`, `redirect`, `rewritePath`, `stripPrefix`, `addPrefix` | Plugin contributes `routeFilters:`. |
| **Telemetry** | `Telemetry` | Core usage stats with redaction and disablement controls | Core telemetry collector, enabled by default | Plugins MAY contribute telemetry sinks only through the telemetry service; plugins MUST NOT bypass user/global disablement. |
| **Update channel** | `UpdateService` | Check/apply updates to core and plugins | Built-in registry-channel updater | Replaceable for air-gapped or vendor-managed distributions. |
| **Secret store** | `SecretStore` | Resolve `${secret:...}` references in Landofiles | Built-in env-var store | Plugin replaces with Vault, 1Password CLI, AWS SM, etc. |

`EmbeddedAssetService` is intentionally absent from this plugin catalog. It is a core service (§3.4) that can be overridden by tests or embedding hosts, but plugins cannot replace it because it mediates access to embedded binary/package assets.

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
