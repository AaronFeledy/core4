# Lando v4 — Implementation Specification (Index)

> **Status:** Draft for build kickoff.
> **Audience:** Lando Core maintainers, plugin authors, contributors building v4 from a clean slate, and embedding hosts integrating `@lando/core` as a library.

The specification lives entirely in this directory as **sixteen focused parts**. Files are the canonical source; there is no separate master document. The original `SPEC.md` was split (see "History" below) and the splits have since been edited independently. **Cross-references use a `§N` notation** where `N` is a stable section number that is *independent* of the file number, so links like "see §4.2" or "(§14)" continue to resolve correctly even when files are added or reordered. Use the topic lookup below to find which file a given `§N` lives in.

The split is *almost* one-section-per-file, with a few principled merges and three principled additions:

- **§1 (Mission and Tenets)** is paired with **§14 (Non-Goals and Open Decisions)** because they answer the same question from opposite sides.
- **§3 (Architecture)** is paired with **§11 (Lifecycle and Events)** because the lifecycle event bus is part of the runtime architecture and §3.5 already introduces the event taxonomy that §11 specifies in full.
- **§16 (Embedding and Library Use)** is a new section that wasn't in the original SPEC. It is filed at part 09 (between CLI and Plugins) because it specifies the second imperative shell — the library — which is a peer to the CLI.
- **§17 (Binary Build and Release Engineering)** is a new section that wasn't in the original SPEC. It is filed at part 15 (after Appendices) because it is the operational counterpart to §13 — covering the build pipeline, codegen, asset embedding, signing, supply-chain artifacts, self-update, installation, and the CI release workflow that §13.5 and §13.7 only sketch.
- **§18 (Deprecation and Surface Evolution)** is a new section that wasn't in the original SPEC. It is filed at part 16 (after Binary Build and Release Engineering) because it is a cross-cutting governance contract — every other part references §18 for *how* a surface is deprecated, while §18 owns the *what*.

---

## Read in this order

| # | File | `§N` | Theme |
|---|---|---|---|
| 01 | [`01-mission-and-tenets.md`](./01-mission-and-tenets.md) | §1 + §14 | Mission, architectural tenets (CLI-and-library is one of them), core boundaries, default distribution (compiled binary and library package). Plus non-goals and open decisions. |
| 02 | [`02-toolchain.md`](./02-toolchain.md) | §2 | Bun policies, single-binary build, performance budgets. TypeScript strict settings. OCLIF integration rationale. Effect runtime model and reference patterns. Effect Schema as the single contract language, including schema annotations, JSON Schema output, and generated reference docs. The Starlight docs toolchain. Forbidden runtime dependencies. The `@lando/core` package surface and entry-point catalog. |
| 03 | [`03-architecture.md`](./03-architecture.md) | §3 + §11 | The four concentric layers (imperative shell → Effect runtime → ports → adapters), bootstrap flow with declared `BootstrapLevel`s, source layout, the catalog of core Effect services, lifecycle event scopes, and the imperative-shell catalog (CLI plus embedding hosts). Plus the `EventService` deep dive: payload schemas, subscriber priority bands, the standard cold-start sequence, the hot-path tooling subset, and subscriber failure handling. |
| 04 | [`04-pluggability.md`](./04-pluggability.md) | §4 | The master pluggability catalog: every replaceable abstraction with its Effect Service tag, default implementation, and swap mechanism, including config translators for explicit external-config imports. Selection precedence rules, manifest contribution shape, and mandatory abstraction guarantees. |
| 05 | [`05-runtime-providers.md`](./05-runtime-providers.md) | §5 | The `RuntimeProvider` deep dive: terminology, design principles, the Effect service interface, the `ProviderCapabilities` matrix, the provider-neutral `AppPlan` and `ServicePlan` schemas, supported Compose input at the provider boundary, namespaced provider extensions, the typed error model, the bundled providers (Lando-managed runtime as default, system Docker and system Podman as opt-in), and the deferred multi-provider design. |
| 06 | [`06-services.md`](./06-services.md) | §6 | The v4 service model: `l337` and `lando` bases, the common service schema with supported Compose service keys, the group-weighted artifact build, app mounts and mounts (with excludes/includes semantics), storage scopes and auto-naming, endpoints/hostnames/routes with provider-neutral filters, healthchecks, certs and additional CA injection, the `LANDO_*` environment contract, the `ServiceInfo` schema, the `ServiceType` + `ServiceFeature` contracts (with the built-in feature priority list), and the canonical service-type catalog shipped in core (PHP, Node, Python, Ruby, Go, common databases, caches, search, mail, queues, static, raw Compose passthrough). |
| 07 | [`07-landofile-and-config.md`](./07-landofile-and-config.md) | §7 | Landofile discovery and bounds, the six-file merge order with array identity keys, the `!load` / `!import` YAML extensions, the config-wide expression language (`{{ … }}` interpolation, filter-and-call helpers, native `${VAR}` shell-parameter-expansion, AST + staged bootstrap-level-aware resolution), the pluggable `TemplateEngine` abstraction with the bundled `lando` / `handlebars` / `mustache` engines, the top-level Landofile keys, the supported Compose subset, explicit config translation into Landofile fragments, the explicitly forbidden wrapper keys (`compose:`, `recipe:`, `recipes:`), the global config schema, env-var override naming, the `includes:` composition primitive with its source schemes (local/git/npm/registry) and lockfile, and schema / generated-doc publication. |
| 08 | [`08-cli-and-tooling.md`](./08-cli-and-tooling.md) | §8 | Command kinds (built-in, plugin, tooling, management). Three first-class command namespaces (`app`, `apps`, `meta`) with plugin-owned topics. Top-level alias mechanism and conflict rules. Built-in command list with behavioral requirements, including dedicated `app config`, `meta config`, and `meta recipes:*` commands. The `LandoCommandSpec` contract (with `namespace` and `topLevelAlias` fields) and `CommandInput` shape. OCLIF integration policies (manifest-first, hooks bridging to Effect, `SIGINT` → `Effect.interrupt`, flexible taxonomy, namespace-to-topic mapping). Taskfile-inspired tooling schema with dynamic service resolution, expressions, dependencies, includes, and up-to-date checks. The `ToolingEngine` abstraction and its hot-path cache. `lando apps init` and the v4 recipe model — Yeoman-style init-time scaffolds with Q&A prompts (text/select/multiselect/confirm/number/secret/path/editor), file manifests, and post-init actions, replacing the v3 recipe-as-plugin model. The `Renderer` service and selection precedence. |
| 09 | [`09-embedding.md`](./09-embedding.md) | §16 | Embedding `@lando/core` in another Bun program: use cases, the public API surface (Effect-native; no Promise facade), the `makeLandoRuntime` factory and its options, host-controlled plugin discovery (opt-in to system/user/app sources), bootstrap and lifecycle in library mode, scope/resource ownership, programmatic CLI invocation via `@lando/core/cli`, the `@lando/core/testing` API, version compatibility, and embedding non-goals. |
| 10 | [`10-plugins.md`](./10-plugins.md) | §9 | Plugin identity (manifest locations, distribution forms via `PluginSource` adapters), runtime rules, discovery order across bundled/system/user/app-local sources (CLI default; library mode in §16.4), the full manifest schema (with command-namespace and top-level-alias rules), the contribution surfaces table, the install/update flow for `meta:plugin:add` / `meta:plugin:remove` / `meta:update` (and their top-level aliases), plugin loading rules, and the constrained `LandoPluginContext`. |
| 11 | [`11-subsystems.md`](./11-subsystems.md) | §10 | Networking intent, `ProxyService` and `RoutePlan` (with the route-filter abstraction), `CertificateAuthority`, corporate proxy/custom CA handling for Lando-owned network access, SSH and host identity (with the new sidecar-by-default SSH-agent design), `HealthcheckRunner` and `UrlScanner`, files and performance, SQL helpers (plugin-only), `lando setup` and host integration, and logs/diagnostics. |
| 12 | [`12-caches-and-persistence.md`](./12-caches-and-persistence.md) | §12 | The cache catalog (command, plugin, app-plugin, app-plan, service-info, provider, oclif-manifest, update) with locations and invalidation triggers. Encoding choices. Atomicity rules. The full list of persistent on-disk artifacts. Hot-path read budgets. Disconnectable local-dev state after app build. |
| 13 | [`13-testing-and-distribution.md`](./13-testing-and-distribution.md) | §13 | The nine test layers (unit, Effect service, CLI, library API, provider contract, plugin SDK contract, scenario, recipe, end-to-end), Effect testing patterns, the mandatory provider contract suite, the library API contract suite, the recipe suite that exercises every canonical recipe, the scenario / recipe / end-to-end conventions that replace the Lando 3 Leia format, schema and docs gates, type gates, PR merge requirements, the two distribution forms (compiled binary and library package whose `package.json#bin` doubles as a CLI install path) plus bundled-plugin and bundled-recipe generation, the docs site build, the per-PR/nightly/weekly CI matrices, and the release flow with channels. |
| 14 | [`14-appendices.md`](./14-appendices.md) | §15 | Provider-neutral language reference. Forbidden core dependencies. The source-derived acceptance checklist (with embedding criteria). The OCLIF-vs-`@effect/cli` decision rationale. The glossary. |
| 15 | [`15-binary-build-and-release.md`](./15-binary-build-and-release.md) | §17 | The build pipeline and its single orchestrator. The codegen catalog (every generator, its inputs, outputs, and staleness gate). Asset embedding policy (hybrid: static JSON imports for small data, `Bun.embeddedFiles` for large data). Per-platform signing and notarization (macOS Developer ID + notarytool, Windows Authenticode + cosign, Linux GPG-signed checksum manifests). Supply-chain artifacts (CycloneDX SBOM, SLSA v1.0 provenance, cosign signatures). The self-update protocol (manifest schema, channel resolution, signature verification, atomic replace, Windows rename, rollback). The v4.0.0 install surface (GitHub Releases + curl-pipe installer; Homebrew/scoop/winget/distro deferred). The CI release workflow on GitHub Actions and the binary-shipping acceptance criteria that augment §15.C. |
| 16 | [`16-deprecation-and-surface-evolution.md`](./16-deprecation-and-surface-evolution.md) | §18 | The cross-cutting deprecation contract: principles, the canonical `DeprecationNotice` schema, the `DeprecationService` and its hot-path rules, the `deprecation-used` lifecycle event, the surface deprecation matrix that maps every public surface to its declaration mechanism (schema annotation, contract field, manifest field, TSDoc tag), the renderer's once-per-process warning behavior and `--no-deprecation-warnings` opt-out, the semver-bound removal policy and the release-pipeline `removeIn` enforcement gate, and the test/lint gates. |

---

## Topic lookup

If you are looking for…

| Topic | Part | Section |
|---|---|---|
| Architectural tenets table | 01 | §1.2 |
| Performance-is-a-feature tenet | 01 | §1.2 |
| CLI-and-library tenet | 01 | §1.2 |
| Default plugin bundle | 01 | §1.4 |
| Distribution forms (binary, library) | 01 | §1.4 |
| Non-goals | 01 | §14.1 |
| Open decisions before GA | 01 | §14.2 |
| Persistent agent / daemon (deferred post-v4.0) | 01 | §14.2 |
| Bun policies, single-binary build | 02 | §2.1 |
| Performance budgets (cold/hot starts) | 02 | §2.1 |
| Perceived-performance / first-paint budget | 02 | §2.1 |
| `--bytecode` requirement | 02 | §2.1 |
| Top-level module work budget | 02 | §2.4 |
| AOT bootstrap layers (rule) | 02 | §2.4 |
| Lazy / `Layer.suspend` services rule | 02 | §2.4 |
| Telemetry fire-and-forget rule | 02 | §2.4 |
| Intra-level concurrency rule | 03 | §3.2 |
| TypeScript `tsconfig` requirements | 02 | §2.2 |
| OCLIF integration rationale (overview) | 02 | §2.3 |
| Effect patterns (`Context.Service`, Layers, scoped resources) | 02 | §2.4 |
| Documentation toolchain (Starlight, generated reference) | 02 | §2.4 |
| Why Effect Schema is the only schema lib in core | 02 | §2.5 |
| Forbidden runtime dependencies | 02 | §2.6 |
| Package surface (entry points, exports) | 02 | §2.7 |
| The four layers | 03 | §3.1 |
| Bootstrap flow + bootstrap levels | 03 | §3.2 |
| Level-`none` (pre-OCLIF fast path) | 03 | §3.2 |
| Service membership per bootstrap level | 03 | §3.4 |
| Source layout (`core/` tree) | 03 | §3.3 |
| Core Effect services table | 03 | §3.4 |
| `ShellRunner` core service (Bun Shell wrapper) | 03 | §3.4 |
| `ProcessRunner` vs `ShellRunner` (when to use which) | 03 | §3.4 |
| Lifecycle event scopes overview | 03 | §3.5 |
| `pre-shell-exec` / `post-shell-exec` events | 03 | §3.5 |
| Imperative shells (CLI vs embedding host) | 03 | §3.6 |
| `EventService` interface | 03 | §11.1 |
| EventService zero-subscriber short-circuit | 03 | §11.1 |
| Event payload schemas | 03 | §11.2 |
| Subscriber priority bands | 03 | §11.3 |
| Standard cold-start event sequence | 03 | §11.4 |
| Hot-path event subset (tooling fast path) | 03 | §11.5 |
| Subscriber failure handling | 03 | §11.6 |
| Pluggability principles | 04 | §4.1 |
| The pluggability catalog (master table) | 04 | §4.2 |
| `ShellRunner` pluggability (audited / dry-run / sandboxed shell) | 04 | §4.2 |
| Config translator abstraction | 04 | §4.2 |
| Selection precedence | 04 | §4.3 |
| Manifest contribution shape | 04 | §4.4 |
| Mandatory abstraction guarantees | 04 | §4.5 |
| `RuntimeProvider` interface | 05 | §5.3 |
| `ProviderCapabilities` schema | 05 | §5.4 |
| `AppPlan` / `ServicePlan` schemas | 05 | §5.5 |
| Provider extensions (non-portable opt-in) | 05 | §5.6 |
| Provider error model | 05 | §5.7 |
| Bundled providers (Lando-managed runtime, system Docker, system Podman) | 05 | §5.8 |
| Multi-provider apps (deferred) | 05 | §5.9 |
| `l337` vs `lando` service bases | 06 | §6.1 |
| Common service schema | 06 | §6.2 |
| Group-weighted artifact build model | 06 | §6.3 |
| Mounts, excludes/includes semantics | 06 | §6.4 |
| Storage scopes and auto-naming | 06 | §6.5 |
| Endpoints, hostnames, routes, route filters | 06 | §6.6 |
| Healthchecks | 06 | §6.7 |
| Certificates and `security.ca:` | 06 | §6.8 |
| `LANDO_*` environment variable contract | 06 | §6.9 |
| `ServiceInfo` schema | 06 | §6.10 |
| `ServiceType` and `ServiceFeature` contracts (built-in features list) | 06 | §6.11 |
| Canonical service-type catalog (PHP, Node, Python, Ruby, Go, databases, caches, search, mail, queues, static, compose passthrough) | 06 | §6.12 |
| Landofile discovery + merge order (six files) | 07 | §7.1–7.2 |
| `!load` / `!import` YAML extensions | 07 | §7.3 |
| Top-level Landofile keys, Compose subset compatibility, config translation, and forbidden wrappers (`compose:`, `recipe:`, `recipes:`) | 07 | §7.4 |
| `commandAliases:` Landofile key (per-app override) | 07 | §7.4 |
| Global config keys and user root defaults | 07 | §7.5 |
| `commandAliases:` global config key | 07 | §7.5 |
| Env-var override rules | 07 | §7.6 |
| `includes:` and fragments (local/git/npm/registry sources, lockfile, merge semantics) | 07 | §7.7 |
| Schema and generated-doc publication | 07 | §7.8 |
| Command kinds (built-in, plugin, tooling, management) | 08 | §8.1 |
| Command namespaces (`app`, `apps`, `meta`) | 08 | §8.1.1 |
| Top-level command aliases | 08 | §8.1.2 |
| Built-in commands list and behavior | 08 | §8.2 |
| `lando app cache refresh` command | 08 | §8.2 |
| `lando app config` command | 08 | §8.2.1 |
| `lando app config translate` command | 08 | §8.2.1 |
| `lando events --follow` command | 08 | §8.2 |
| `lando meta config` command | 08 | §8.2.2 |
| `lando app shell` command (interactive Bun Shell REPL) | 08 | §8.2.3 |
| `lando uninstall` command | 08 + 15 | §8.2 + §17.7 |
| `LandoCommandSpec` shape (with `namespace` and `topLevelAlias`) | 08 | §8.3 |
| OCLIF integration policies (hooks, SIGINT, manifest, topic mapping) | 08 | §8.4 |
| Config expressions | 07 | §7.3.1 |
| Template engines (pluggable; `lando` default + bundled handlebars/mustache) | 07 | §7.3.2 |
| Configuration-expression syntax (paths, filters, helpers, `${VAR}` envsubst) | 07 | §7.3.1 |
| Staged, bootstrap-level-aware expression resolution (scope-to-level table) | 07 | §7.3.1 |
| `TemplateEngine` pluggable abstraction | 04 | §4.2 |
| `templateEngines:` plugin contribution surface | 10 | §9.5 |
| `mounts: type: template` mount type | 06 | §6.4 |
| `template-compile` and `template-render` caches | 12 | §12.1 |
| Template engine contract test suite | 13 | §13.1 |
| `TemplateEngineRegistry` and `TemplateRenderer` core services | 03 | §3.4 |
| Taskfile-inspired tooling schema + dynamic service resolution | 08 | §8.5 |
| Tooling task `namespace` and `topLevelAlias` | 08 | §8.5.1 |
| `command:` step (invoke another canonical command) | 08 | §8.5.2.1 |
| Wrapping a built-in (worked example) | 08 | §8.5.2.2 |
| Tooling `vars.<name>.sh:` via `ShellRunner` | 08 | §8.5.3 |
| Events as tasks (and `command:` steps in events) | 08 | §8.5.7 |
| `.bun.sh` script-backed tooling tasks | 08 | §8.5.9 |
| `ToolingEngine` abstraction | 08 | §8.6 |
| `host` ToolingEngine (Bun-Shell-backed) | 08 | §8.6 |
| Tooling compilation pipeline + hot path | 08 | §8.7 |
| `lando apps init` and the v4 recipe model (Yeoman-style scaffolds) | 08 | §8.8 |
| `recipe.yml` schema (prompts, files, postInit) | 08 | §8.8.3 |
| Recipe sources (built-in/local/git/npm/registry) | 08 | §8.8.4 |
| Prompt types (text, select, multiselect, confirm, number, secret, path, editor) | 08 | §8.8.5 |
| Recipe expressions and control flow | 08 | §8.8.6 |
| Recipe `postInit.bunScript:` action | 08 | §8.8.8 |
| Canonical recipes shipped in core | 08 | §8.8.10 |
| Renderers and messages | 08 | §8.9 |
| Renderer first-paint contract | 08 | §8.9.1 |
| Embedding concept and use cases | 09 | §16.1 |
| Public API surface (entry points, stability) | 09 | §16.2 |
| `makeLandoRuntime` factory | 09 | §16.3 |
| Runtime reuse for performance (long-lived hosts) | 09 | §16.3, §16.6 |
| Plugin behavior in library mode | 09 | §16.4 |
| Configuration in library mode | 09 | §16.5 |
| Lifecycle and scopes for embedding hosts | 09 | §16.6 |
| Programmatic CLI invocation (`@lando/core/cli`) | 09 | §16.7 |
| Testing API (`@lando/core/testing`) | 09 | §16.8 |
| Library versioning and compatibility | 09 | §16.9 |
| Embedding non-goals | 09 | §16.10 |
| Plugin identity and distribution forms | 10 | §9.1 |
| Plugin runtime rules | 10 | §9.2 |
| Plugin discovery order (CLI vs library) | 10 | §9.3 |
| Plugin manifest schema | 10 | §9.4 |
| Contribution surfaces table | 10 | §9.5 |
| Plugin-contributed config translators | 10 | §9.5 |
| Plugin install/update flow | 10 | §9.6 |
| Plugin loading rules | 10 | §9.7 |
| `LandoPluginContext` | 10 | §9.8 |
| Networking intent (no shared bridge in core) | 11 | §10.1 |
| Proxy/routing service | 11 | §10.2 |
| Certificate authority service | 11 | §10.3 |
| Corporate proxies and outbound trust | 11 | §10.3.1 |
| SSH and host identity (sidecar-by-default agent) | 11 | §10.4 |
| Host proxy (container→host RPC: `xdg-open` shim, in-container `lando` shim) | 11 | §10.10 |
| Host-proxy wire protocol (`openUrl`, `runLando`, NDJSON streaming) | 11 | §10.10.2 |
| In-container shim binary (argv[0] dispatch on `xdg-open` / `open` / `lando`) | 11 | §10.10.3 |
| `lando.host-proxy` built-in service feature | 06 | §6.11 |
| `LANDO_HOST_PROXY_SOCKET` / `LANDO_HOST_PROXY_TOKEN` / `LANDO_HOST_PROXY_DEPTH` env | 06 | §6.9 |
| `HostProxyService` core service | 03 | §3.4 |
| `HostProxyService` pluggability (headless CI, audited builds, recording) | 04 + 11 | §4.2 + §10.10.5 |
| `pre-host-proxy-call` / `post-host-proxy-call` lifecycle events | 03 | §3.5 + §11.2 |
| `hostProxyAllowed` field on `LandoCommandSpec` and tooling tasks | 08 | §8.3 + §8.5.1 |
| `host-proxy-allowlist` cache | 12 | §12.1 |
| Per-app `host-proxy.sock` persistent artifact | 12 | §12.4 |
| Host-proxy contract suite (mandatory) | 13 | §13.1 |
| Healthcheck runner + URL scanner | 11 | §10.5 |
| Host-target healthchecks (`ShellRunner`-backed) | 11 | §10.5 |
| Files and performance | 11 | §10.6 |
| SQL helpers (plugin-only) | 11 | §10.7 |
| `lando setup` | 11 | §10.8 |
| Logs and diagnostics | 11 | §10.9 |
| `lando doctor` diagnostics | 11 | §10.9 |
| Doctor diagnostic transcripts (via `ShellRunner`) | 11 | §10.9 |
| Cache catalog | 12 | §12.1 |
| `cwd-app-map` cache | 12 | §12.1 |
| Cache encoding choices (binary on hot path) | 12 | §12.2 |
| Atomic cache writes | 12 | §12.3 |
| Persistent on-disk artifacts | 12 | §12.4 |
| Hot-path read budgets | 12 | §12.5 |
| Disconnectable local-dev state | 12 | §12.6 |
| Test layers + Effect testing patterns | 13 | §13.1 |
| Library API contract suite | 13 | §13.1 |
| Perf-budget test suite | 13 | §13.1 |
| Schema gates | 13 | §13.2 |
| Documentation build gates | 13 | §13.2–13.5 |
| Type gates | 13 | §13.3 |
| PR merge requirements | 13 | §13.4 |
| Distribution (single-binary, library) | 13 | §13.5 |
| CI matrix | 13 | §13.6 |
| Release flow + channels | 13 | §13.7 |
| Provider-neutral language reference | 14 | §15.A |
| Forbidden core dependencies (full list) | 14 | §15.B |
| Acceptance checklist | 14 | §15.C |
| OCLIF-vs-`@effect/cli` decision rationale | 14 | §15.D |
| Glossary | 14 | §15.E |
| Build pipeline (ordered stages, single orchestrator) | 15 | §17.1 |
| Release orchestrator `Bun.$` vs `Bun.spawn` policy | 15 | §17.1 |
| Codegen catalog (every generator, inputs, outputs, staleness gate) | 15 | §17.2 |
| AOT bootstrap layers codegen entry | 15 | §17.2 |
| Asset embedding (static JSON imports vs `Bun.embeddedFiles`) | 15 | §17.3 |
| `EmbeddedAssetService` interface | 03 + 15 | §3.4 + §17.3 |
| Code signing and notarization (macOS, Windows, Linux) | 15 | §17.4 |
| SBOM, SLSA provenance, cosign signatures | 15 | §17.5 |
| Self-update flow (manifest, verification, atomic replace, rollback) | 15 | §17.6 |
| Update manifest schema and channel URLs | 15 | §17.6.1 |
| Windows running-`.exe` rename strategy | 15 | §17.6.2 |
| Update permission handling (no silent sudo/UAC) | 15 | §17.6.2 |
| v4.0.0 install surface (GitHub Releases + curl-pipe) | 15 | §17.7 |
| Deferred install channels (Homebrew, scoop, winget, distro packages) | 15 | §17.7 |
| First-run UX and uninstall | 15 | §17.7 |
| CI release workflow (GitHub Actions, channel-to-tag mapping, matrix) | 15 | §17.8 |
| Binary-shipping acceptance criteria | 15 | §17.9 |
| Deprecation policy and surface evolution | 16 | §18 |
| `DeprecationNotice` schema | 16 | §18.2 |
| `DeprecationService` interface | 16 | §18.3 |
| `deprecation-used` lifecycle event | 16 | §18.4 |
| Surface deprecation matrix | 16 | §18.5 |
| Renderer deprecation warnings (`--no-deprecation-warnings`) | 16 | §18.6 |
| `removeIn` release-time enforcement | 16 + 15 | §18.7 + §17.1 |
| Deprecation test/lint gates | 16 + 13 | §18.8 + §13.4 |

---

## Conventions

- Cross-references in any part use stable `§N` section numbers (e.g., "see §4.2"), not file numbers. Use the topic lookup above to find which file a given section lives in.
- Effect Schema definitions in any part are illustrative; the canonical schemas are published from `@lando/sdk` and re-exported by `@lando/core/schema` (§7.8).
- Code blocks marked TypeScript (`ts`) reflect the implementation language; YAML blocks reflect Landofile / manifest / config surfaces.
- Where the spec says **MUST**, **MUST NOT**, **SHOULD**, **MAY**, the words carry RFC 2119 weight.

## Canonical Surface Governance

Public surfaces MUST have one canonical registry. Narrative sections may explain a surface, but they must not introduce commands, service tags, schemas, events, exports, recipe actions, or plugin contribution surfaces that are absent from the relevant canonical registry.

Canonical owners:

- Built-in commands, aliases, flags, args, bootstrap levels, recipe post-init eligibility, and command docs metadata: `LandoCommandSpec` registry (§8.2/§8.3).
- Public schemas, event payload schemas, tagged errors, and plugin-facing contract metadata: `@lando/sdk` schema/error/event registries (§7.8, §13.2).
- Core service tags and public service exports: §3.4 plus `@lando/core/services` (§16.2).
- Package entry points and public library exports: `package.json#exports` plus the API report gate (§2.7, §16.2, §13.4).
- Recipe action types and `postInit.command` allowlist: generated from command metadata (§8.8.8).
- Acceptance checklist items: stable checklist ids mapped to tests and public surfaces (§15.C, §17.9).
- Deprecation notices for every public surface: registered through schema annotations, contract fields, manifest fields, or TSDoc tags per §18.5; published as the merged `DeprecationService` registry (§18.3) and as `dist/schemas/deprecation-notice.json` (§18.2).

Surface change checklist:

- Add or update the canonical registry entry first.
- Update generated docs/codegen inputs and the topic lookup when the surface is user-visible.
- Add or update schema/API/command/event/service drift gates in §13.4 when the change creates a new class of surface.
- Add a library/API test for public exports and a CLI/e2e test for user-visible commands.
- Update the acceptance checklist when the surface affects release readiness.

When the spec changes, edit the relevant part(s) directly and update the topic lookup above. There is no re-split step.
