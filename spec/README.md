# Lando v4 — Implementation Specification (Index)

> **Status:** Living document — the compatibility contract for the v4 build (currently in Beta 1; see [`ROADMAP.md`](./ROADMAP.md)). When code and this spec disagree, the spec wins.
> **Audience:** Lando Core maintainers, plugin authors, contributors building v4 from a clean slate, and embedding hosts integrating `@lando/core` as a library.

The specification lives entirely in this directory as **nineteen focused parts**. Files are the canonical source; there is no separate master document. The original `SPEC.md` was split (see "History" below) and the splits have since been edited independently. **Cross-references use a `§N` notation** where `N` is a stable section number that is *independent* of the file number, so links like "see §4.2" or "(§14)" continue to resolve correctly even when files are added or reordered. Use the topic lookup below to find which file a given `§N` lives in.

The split is *almost* one-section-per-file, with a few principled merges and six principled additions:

- **§1 (Mission and Tenets)** is paired with **§14 (Non-Goals and Open Decisions)** because they answer the same question from opposite sides.
- **§3 (Architecture)** is paired with **§11 (Lifecycle and Events)** because the lifecycle event bus is part of the runtime architecture and §3.5 already introduces the event taxonomy that §11 specifies in full.
- **§16 (Embedding and Library Use)** is a new section that wasn't in the original SPEC. It is filed at part 09 (between CLI and Plugins) because it specifies the second imperative shell — the library — which is a peer to the CLI.
- **§17 (Binary Build and Release Engineering)** is a new section that wasn't in the original SPEC. It is filed at part 15 (after Appendices) because it is the operational counterpart to §13 — covering the build pipeline, codegen, asset embedding, signing, supply-chain artifacts, self-update, installation, and the CI release workflow that §13.5 and §13.7 only sketch.
- **§18 (Deprecation and Surface Evolution)** is a new section that wasn't in the original SPEC. It is filed at part 16 (after Binary Build and Release Engineering) because it is a cross-cutting governance contract — every other part references §18 for *how* a surface is deprecated, while §18 owns the *what*.
- **§19 (Executable Guides and Scenarios)** is a new section that wasn't in the original SPEC. It is filed at part 17 (after Deprecation) because it is the canonical mechanism by which authored user docs (Diátaxis tutorials and how-tos, plus recipe READMEs) double as end-to-end test sources via MDX with typed JSX components and an MDX→generated scenario TypeScript codegen, replacing the need for a Lando 3 Leia-style markdown-as-test surface.
- **§20 (The Global App)** is a new section that wasn't in the original SPEC. It is filed at part 18 (after Executable Guides and Scenarios) because it specifies a cross-cutting architectural concept — a reserved, host-level Lando app for cross-cutting services like the proxy and Mailpit — and every other part references §20 for *how* the global app interacts with their surface, while §20 owns the *what*.
- **§21 (Scratch Apps)** is a new section that wasn't in the original SPEC. It is filed at part 19 (after The Global App) because it specifies a peer architectural concept — short-lived Lando apps whose lifetime is bounded by an Effect `Scope` and whose state is purged at scope close — and every part that references identity, storage, routing, caches, or the library API points at §21 for *how* scratch-kind apps differ from user and global apps, while §21 owns the *what*.

---

## Read in this order

| # | File | `§N` | Theme |
|---|---|---|---|
| 01 | [`01-mission-and-tenets.md`](./01-mission-and-tenets.md) | §1 + §14 | Mission, architectural tenets (CLI-and-library is one of them), core boundaries, default distribution (compiled binary and library package). Plus non-goals and open decisions. |
| 02 | [`02-toolchain.md`](./02-toolchain.md) | §2 | Bun policies, single-binary build, performance budgets. TypeScript strict settings. OCLIF integration rationale. Effect runtime model and reference patterns. Effect Schema as the single contract language, including schema annotations, JSON Schema output, and generated reference docs. The Starlight docs toolchain. Forbidden runtime dependencies. The `@lando/core` package surface and entry-point catalog. |
| 03 | [`03-architecture.md`](./03-architecture.md) | §3 + §11 | The four concentric layers (imperative shell → Effect runtime → ports → adapters), bootstrap flow with declared `BootstrapLevel`s, source layout, the catalog of core Effect services, lifecycle event scopes, and the imperative-shell catalog (CLI plus embedding hosts). Plus the `EventService` deep dive: payload schemas, subscriber priority bands, the standard cold-start sequence, the hot-path tooling subset, and subscriber failure handling. |
| 04 | [`04-pluggability.md`](./04-pluggability.md) | §4 | The master pluggability catalog: every replaceable abstraction with its Effect Service tag, default implementation, and swap mechanism, including config translators for explicit external-config imports. Selection precedence rules, manifest contribution shape, and mandatory abstraction guarantees. |
| 05 | [`05-runtime-providers.md`](./05-runtime-providers.md) | §5 | The `RuntimeProvider` deep dive: terminology, design principles, the Effect service interface (including the streaming `execStream` primitive that powers long-running build output), the `ProviderCapabilities` matrix, the provider-neutral `AppPlan` and `ServicePlan` schemas, supported Compose input at the provider boundary, namespaced provider extensions, the typed error model, the bundled providers (Lando-managed runtime as default, system Docker and system Podman as opt-in), and the deferred multi-provider design. |
| 06 | [`06-services.md`](./06-services.md) | §6 | The v4 service model: `l337` and `lando` bases, the common service schema with supported Compose service keys, the group-weighted artifact build, app mounts and mounts (with excludes/includes semantics), storage scopes and auto-naming, endpoints/hostnames/routes with provider-neutral filters, healthchecks, certs and additional CA injection, the `LANDO_*` environment contract, the `ServiceInfo` schema, the `ServiceType` + `ServiceFeature` contracts (with the built-in feature priority list), the canonical service-type catalog shipped in core (PHP, Node, Python, Ruby, Go, common databases, caches, search, mail, queues, static, raw Compose passthrough), and the build orchestration model (parallel per-service artifact and app-build phases via `BuildOrchestrator`, the `BuildPlan` DAG with per-phase concurrency caps and failure policies, the content-hashed `buildKey` up-to-date check, and per-step transcript artifacts). |
| 07 | [`07-landofile-and-config.md`](./07-landofile-and-config.md) | §7 | Landofile discovery and bounds, the six-file merge order with array identity keys, the `load()` / `import()` file-IO expression helpers (with `FileRef` / `ImportRef<T>` value shapes and pipe-decoder pipeline), the config-wide expression language (`{{ … }}` interpolation, filter-and-call helpers, native `${VAR}` shell-parameter-expansion, AST + staged bootstrap-level-aware resolution), the pluggable `TemplateEngine` abstraction with the bundled `lando` / `handlebars` / `mustache` engines, the top-level Landofile keys, the supported Compose subset, explicit config translation into Landofile fragments, the explicitly forbidden wrapper keys (`compose:`, `recipe:`, `recipes:`), the global config schema, env-var override naming, the `includes:` composition primitive with its source schemes (local/git/npm/registry) and lockfile, and schema / generated-doc publication. |
| 08 | [`08-cli-and-tooling.md`](./08-cli-and-tooling.md) | §8 | Command kinds (built-in, plugin, tooling, management). Three first-class command namespaces (`app`, `apps`, `meta`) with plugin-owned topics. Top-level alias mechanism and conflict rules. Built-in command list with behavioral requirements, including dedicated `app config`, `meta config`, and `meta recipes:*` commands. The `LandoCommandSpec` contract (with `namespace` and `topLevelAlias` fields) and `CommandInput` shape. OCLIF integration policies (manifest-first, hooks bridging to Effect, `SIGINT` → `Effect.interrupt`, flexible taxonomy, namespace-to-topic mapping). Taskfile-inspired tooling schema with dynamic service resolution, expressions, dependencies, includes, and up-to-date checks. The `ToolingEngine` abstraction and its hot-path cache. `lando apps init` and the v4 recipe model — Yeoman-style init-time scaffolds with Q&A prompts (text/select/multiselect/confirm/number/secret/path/editor), file manifests, and post-init actions, replacing the v3 recipe-as-plugin model. The `Renderer` service and selection precedence, the first-paint contract, and the concurrent task tree contract that drives the multi-task build UI (per-task tail panels, alt-screen full-tail expand). The `InteractionService` — the input peer of `Renderer` — that owns the published prompt vocabulary (`PromptSpec`), answer-source precedence, interactivity-mode resolution, and `secret` redaction for every prompting surface (recipes, plugin authoring, setup, doctor), and is pluggable for headless/CI, recording/test, and GUI/host transports. |
| 09 | [`09-embedding.md`](./09-embedding.md) | §16 | Embedding `@lando/core` in another Bun program: use cases, the public API surface (Effect-native; no Promise facade), the `makeLandoRuntime` Layer factory, the `openLandoRuntime` object wrapper, stable `App` handles via `resolveApp`/`runtime.app`, host-controlled plugin discovery (opt-in to system/user/app sources), bootstrap and lifecycle in library mode, scope/resource ownership, programmatic CLI invocation via `@lando/core/cli`, the `@lando/core/testing` API, version compatibility, and embedding non-goals. |
| 10 | [`10-plugins.md`](./10-plugins.md) | §9 | Plugin identity (manifest locations, distribution forms via `PluginSource` adapters), runtime rules, discovery order across bundled/system/user/app-local sources (CLI default; library mode in §16.4), the full manifest schema (with command-namespace and top-level-alias rules), the contribution surfaces table, the install/update flow for `meta:plugin:add` / `meta:plugin:remove` / `meta:update` (and their top-level aliases), plugin loading rules, and the constrained `LandoPluginContext`. |
| 11 | [`11-subsystems.md`](./11-subsystems.md) | §10 | Networking intent, `ProxyService` and `RoutePlan` (with the route-filter abstraction), `CertificateAuthority`, corporate proxy/custom CA handling for Lando-owned network access, the `HttpClient` outbound-egress chokepoint and the `Downloader` verified artifact-acquisition primitive (plus the tool-provisioning helper that installs pinned host binaries over it), SSH and host identity (with the new sidecar-by-default SSH-agent design), `HealthcheckRunner` and `UrlScanner`, files and performance (with the `FileSyncEngine` pluggable abstraction and the bundled `@lando/file-sync-mutagen` reference engine that transparently accelerates bind mounts on Docker-Desktop-class providers), SQL helpers (plugin-only), `lando setup` and host integration, logs/diagnostics, and the `DataMover` local/volume byte-movement chokepoint (§10.11) with its snapshot/restore store. |
| 12 | [`12-caches-and-persistence.md`](./12-caches-and-persistence.md) | §12 | The cache catalog (command, plugin, app-plugin, app-plan, service-info, provider, oclif-manifest, update) with locations and invalidation triggers. Encoding choices. Atomicity rules. The full list of persistent on-disk artifacts. Hot-path read budgets. Disconnectable local-dev state after app build. |
| 13 | [`13-testing-and-distribution.md`](./13-testing-and-distribution.md) | §13 | The fourteen test layers (unit, Effect service, CLI, library API, provider contract, template engine contract, host proxy contract, plugin SDK contract, scenario, recipe, executable guides and generated scenarios, deprecation, perf budget, end-to-end), Effect testing patterns, the mandatory provider contract suite, the library API contract suite, the recipe suite that exercises every canonical recipe, the scenario / recipe / end-to-end conventions that replace the Lando 3 Leia format, schema and docs gates, type gates, PR merge requirements, the two distribution forms (compiled binary and library package whose `package.json#bin` doubles as a CLI install path) plus bundled-plugin and bundled-recipe generation, the docs site build, the per-PR/nightly/weekly CI matrices, and the release flow with channels. |
| 14 | [`14-appendices.md`](./14-appendices.md) | §15 | Provider-neutral language reference. Forbidden core dependencies. The source-derived acceptance checklist (with embedding criteria). The OCLIF-vs-`@effect/cli` decision rationale. The glossary. |
| 15 | [`15-binary-build-and-release.md`](./15-binary-build-and-release.md) | §17 | The build pipeline and its single orchestrator. The codegen catalog (every generator, its inputs, outputs, and staleness gate). Asset embedding policy (hybrid: static JSON imports for small data, `Bun.embeddedFiles` for large data). Per-platform signing and notarization (macOS Developer ID + notarytool, Windows Authenticode + cosign, Linux GPG-signed checksum manifests). Supply-chain artifacts (CycloneDX SBOM, SLSA v1.0 provenance, cosign signatures). The self-update protocol (manifest schema, channel resolution, signature verification, atomic replace, Windows rename, rollback). The v4.0.0 install surface (GitHub Releases + curl-pipe installer; Homebrew/scoop/winget/distro deferred). The CI release workflow on GitHub Actions and the binary-shipping acceptance criteria that augment §15.C. |
| 16 | [`16-deprecation-and-surface-evolution.md`](./16-deprecation-and-surface-evolution.md) | §18 | The cross-cutting deprecation contract: principles, the canonical `DeprecationNotice` schema, the `DeprecationService` and its hot-path rules, the `deprecation-used` lifecycle event, the surface deprecation matrix that maps every public surface to its declaration mechanism (schema annotation, contract field, manifest field, TSDoc tag), the renderer's once-per-process warning behavior and `--no-deprecation-warnings` opt-out, the semver-bound removal policy and the release-pipeline `removeIn` enforcement gate, and the test/lint gates. |
| 17 | [`17-executable-tutorials.md`](./17-executable-tutorials.md) | §19 | The canonical mechanism for keeping authored user docs and end-to-end tests in lock-step. An *executable guide* is an MDX file (under `docs/src/content/docs/guides/**`, `docs/src/content/docs/tutorials/**`, `docs/src/content/docs/how-to/**`, or `recipes/<id>/README.mdx`) whose typed JSX components — `<Guide>`, `<Scenario>`, `<Step>`, `<Run>`, `<Verify>`, `<Inspect>`, `<Hidden>`, `<Cleanup>`, `<Variable>`, `<Skip>`, `<Inline>`, `<UseFixture>` — render reader scenarios in the Starlight site and compile guide scenarios via `scripts/build-guide-scenarios.ts` into generated TypeScript tests under `test/scenarios/generated/**` (gitignored, regenerated). Covers: the `GuideFrontmatter` schema, scenario props, the component prop schemas and `MatcherSchema` assertion vocabulary, the `ScenarioContext` runtime, dual display-vs-execute binding, public/internal transcript capture and redaction, source-location preservation via `@source` headers and the scenario source-mapper reporter, hidden/test-only scenario rules, the test layer that joins the §13.1 matrix, the §17.2 codegen entry, the recipe-README strip-and-flatten policy, library-mode guides targeting `@lando/core` API surfaces, and the v4.0 GA acceptance criteria. |
| 18 | [`18-global-app.md`](./18-global-app.md) | §20 | The global Lando app: a reserved, host-level app at `<userDataRoot>/global/` whose Landofile and services are contributed by plugins through the `globalServices:` manifest surface. Covers identity (reserved id `global`, slug reservation), the Lando-owned Landofile and its plugin enablement map, the `globalServices:` contribution surface, the `GlobalAppService` core service and its `Layer.suspend`-wrapped lazy construction, the new `global` bootstrap level, the `Global` lifecycle event scope (`pre-/post-global-start` etc.), the `meta:global:*` CLI namespace and its default `global:` top-level alias prefix, auto-start integration via `AppFeature.requires.globalServices`, `<service>.global.internal` networking, the `LANDO_GLOBAL_*` env-var family, storage scope semantics inside global services, the `apps:poweroff --keep-global` flag, the refactor of the default `ProxyService` Live Layer to realize routes through a `traefik` service in the global app, the bundled `@lando/service-mailpit` reference plugin, and the v4.0 non-goals (multi-host, user-relocatable path, explicit Landofile `dependsOn`, plugin-extensible `meta:global:*`). |
| 19 | [`19-scratch-apps.md`](./19-scratch-apps.md) | §21 | Scratch apps: short-lived Lando apps whose lifetime is bounded by an Effect `Scope` and whose state — containers, volumes, materialized app root, transcripts, host-proxy socket — is purged at scope close. Covers identity (separate identifier namespace via `AppRef.kind`, no slug reservation), the Lando-managed scratch root under `<userCacheRoot>/scratch/<id>/`, the two source kinds (fork mode copies a source app root, scratch mode renders a recipe), the `ScratchAppService` core service, the new `scratch` bootstrap level, the `Scratch` lifecycle event scope, the `apps:scratch:*` CLI namespace and its default `scratch:` top-level alias prefix (plus the bare `scratch` shortcut), the `--isolate=full|baked|cwd` mount-isolation knob with `--mount-cwd` sugar, the plan-time rewrite of `scope: global` storage to `scope: app` (with `--share-global-storage` opt-out), the `ScratchHostnameSuffix` route filter that auto-suffixes hostnames at plan time, the scratch registry plus provider-label-driven `apps:scratch:gc`, the `apps:poweroff --keep-scratch` flag, the library-mode `makeLandoRuntime({ scratch: ... })` acquisition, and the v4.0 non-goals (CoW/overlay isolation, scratch fleets, hot reload from source mtime, scratch as cross-app source). |

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
| `BUN_BE_BUN` self-spawn policy (binary is itself Bun) | 02 | §2.1 |
| `BunSelfRunner` core service | 03 | §3.4 |
| `BunSelfRunner` pluggability (audited / sandboxed / air-gapped / mirror) | 04 | §4.2 |
| `pre-bun-self-exec` / `post-bun-self-exec` lifecycle events | 03 | §3.5 + §11.2 |
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
| `@lando/core/docs/components` and `@lando/core/docs/redactions` exports | 02 + 09 + 17 | §2.7 + §16.2 + §19.3 |
| The four layers | 03 | §3.1 |
| Bootstrap flow + bootstrap levels | 03 | §3.2 |
| Level-`none` (pre-OCLIF fast path) | 03 | §3.2 |
| Service membership per bootstrap level | 03 | §3.4 |
| Source layout (`core/` tree) | 03 | §3.3 |
| Core Effect services table | 03 | §3.4 |
| `PathsService` core service | 03 | §3.4 |
| `ShellRunner` core service (Bun Shell wrapper) | 03 | §3.4 |
| `RedactionService` core service | 03 | §3.4 |
| Secret redaction policy (value + pattern layers, profiles, sentinel) | 03 | §3.7 |
| `@lando/sdk/secrets` redactor primitive (`createRedactor` / `createSecretRedactor`) | 03 + 09 | §3.7 + §16.2 |
| Redaction contract suite + redaction-boundary gate | 13 | §13.1 + §13.4 |
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
| EventService query / `waitFor` timeout / bounded history | 03 | §11.1 |
| Subscriber failure handling | 03 | §11.6 |
| Pluggability principles | 04 | §4.1 |
| The pluggability catalog (master table) | 04 | §4.2 |
| `ShellRunner` pluggability (audited / dry-run / sandboxed shell) | 04 | §4.2 |
| Config translator abstraction | 04 | §4.2 |
| Selection precedence | 04 | §4.3 |
| Manifest contribution shape | 04 | §4.4 |
| Mandatory abstraction guarantees | 04 | §4.5 |
| `RuntimeProvider` interface | 05 | §5.3 |
| `RuntimeProvider.execStream` (streaming exec for long-running build output) | 05 | §5.3 |
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
| Service-type inheritance (`extends:`) | 06 | §6.11.1 |
| Declarative version pinning (`artifacts:`) | 06 | §6.11.2 |
| Service-type-shipped tooling | 06 | §6.11.3 |
| `AppFeature` (app-scoped features with selectors; e.g., Mailpit injects) | 06 | §6.11.4 |
| Canonical service-type catalog (PHP, Node, Python, Ruby, Go, databases, caches, search, mail, queues, static, compose passthrough) | 06 | §6.12 |
| Database `creds:` schema (uniform user/password/database/rootPassword contract) | 06 | §6.12.4 |
| Build orchestration (parallel artifact and app-build phases, BuildPlan DAG) | 06 | §6.13 |
| Build phases (artifact / app) and their per-service serial dep | 06 | §6.13.1 |
| `BuildPlan` DAG construction rules | 06 | §6.13.2 |
| Build-step dispatch to provider primitives (`buildArtifact`, `pullArtifact`, `execStream`) | 06 | §6.13.3 |
| Build-phase failure policy (`failFast` for artifact; continue-all for app) | 06 | §6.13.4 |
| `buildKey` content-hash and the up-to-date check | 06 | §6.13.5 |
| Per-step build transcripts (location, rotation, redaction policy) | 06 | §6.13.6 |
| Build cancellation and `Effect.interrupt` propagation | 06 | §6.13.7 |
| `BuildPlanCycleError` / `BuildStepFailedError` / `BuildPhaseFailedError` | 06 | §6.13.8 |
| `BuildOrchestrator` core service | 03 | §3.4 |
| `Build` lifecycle event scope | 03 | §3.5 |
| `pre-build` / `post-build` / `pre-build-phase` / `post-build-phase` events | 03 | §3.5 + §11.2 |
| `build-step-start` / `-progress` / `-skip` / `-complete` / `-fail` event payloads | 03 | §11.2 |
| Standard `lando start` event sequence (with parallel build phases) | 03 | §11.4 |
| `build:` global config (concurrency, failFast, transcripts) | 07 | §7.5 |
| Per-app and per-service `build:` overrides | 06 + 07 | §6.13.1 + §7.5 |
| `build-results` cache | 12 | §12.1 |
| Per-step transcript persistent artifact (`<userDataRoot>/builds/<app-id>/...`) | 12 | §12.4 |
| Concurrent-build perf-budget assertion | 13 | §13.1 |
| Landofile discovery + merge order (six files; first-class trio: `dist`, canonical, `local`) | 07 | §7.1–7.2 |
| `load()` / `import()` expression helpers (FileRef, ImportRef, decoders) | 07 | §7.3 |
| Picking values from JSON/YAML/TOML files (`get()` and direct access) | 07 | §7.3 |
| `load()` / `import()` security policy and limits | 07 | §7.3 |
| Top-level Landofile keys, Compose subset compatibility, config translation, and forbidden wrappers (`compose:`, `recipe:`, `recipes:`) | 07 | §7.4 |
| `commandAliases:` Landofile key (per-app override) | 07 | §7.4 |
| Global config keys and user root defaults | 07 | §7.5 |
| Root and path resolution primitive (`@lando/core/paths`, `PathsService`) | 07 | §7.5.1 |
| `commandAliases:` global config key | 07 | §7.5 |
| Env-var override rules | 07 | §7.6 |
| `includes:` and fragments (local/git/npm/registry sources, lockfile, merge semantics) | 07 | §7.7 |
| `includes:` `kind:` discriminator (`landofile` / `tooling` / `compose`) — unified import surface | 07 | §7.7.1 + §7.7.7 |
| Schema and generated-doc publication | 07 | §7.8 |
| Canonical Landofile serializer (`emitLandofileYaml` / `parseLandofile`, round-trip law) | 07 | §7.8.1 |
| Command kinds (built-in, plugin, tooling, management) | 08 | §8.1 |
| Command namespaces (`app`, `apps`, `meta`) | 08 | §8.1.1 |
| Top-level command aliases | 08 | §8.1.2 |
| Built-in commands list and behavior | 08 | §8.2 |
| `lando app cache refresh` command | 08 | §8.2 |
| `lando app includes update` / `verify` commands | 08 | §8.2 |
| `lando app config` command | 08 | §8.2.1 |
| `lando app config translate` command | 08 | §8.2.1 |
| `lando events --follow` command | 08 | §8.2 |
| `lando meta config` command | 08 | §8.2.2 |
| `lando app shell` command (interactive Bun Shell REPL) | 08 | §8.2.3 |
| `lando meta bun` / `lando bun` command (BUN_BE_BUN proxy) | 08 | §8.2.4 |
| `lando meta x` / `lando x` command (bunx-equivalent) | 08 | §8.2.4 |
| `lando uninstall` command | 08 + 15 | §8.2 + §17.7 |
| `LandoCommandSpec` shape (with `namespace` and `topLevelAlias`) | 08 | §8.3 |
| OCLIF integration policies (hooks, SIGINT, manifest, topic mapping) | 08 | §8.4 |
| Config expressions | 07 | §7.3.1 |
| Template engines (pluggable; `lando` default + bundled handlebars/mustache) | 07 | §7.3.2 |
| Configuration-expression syntax (paths, filters, helpers, `${VAR}` envsubst) | 07 | §7.3.1 |
| Cross-service expression scope (`services.<name>.{type,creds,endpoints,hostnames,routes}`) | 07 | §7.3.1 |
| Self-service `creds.*` expression scope | 07 | §7.3.1 |
| `plugin.<id>.{root,config,version}` expression scope | 07 | §7.3.1 |
| Staged, bootstrap-level-aware expression resolution (scope-to-level table) | 07 | §7.3.1 |
| Helper design conventions (sync, namespacing, format args, error model) | 07 | §7.3.1 |
| Namespaced helpers (`path.*`, `fs.*`, `url.*`, `semver.*`) | 07 | §7.3.1 |
| `loader` scope (file IO at level `minimal`) | 07 | §7.3.1 |
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
| Both built-in ToolingEngines (`providerExec` + `host`) in pluggability catalog | 04 | §4.2 |
| Tooling compilation pipeline + hot path | 08 | §8.7 |
| `lando apps init` and the v4 recipe model (Yeoman-style scaffolds) | 08 | §8.8 |
| `recipe.yml` schema (prompts, files, postInit) | 08 | §8.8.3 |
| Recipe sources (built-in/local/git/npm/registry) | 08 | §8.8.4 |
| Prompt types (text, select, multiselect, confirm, number, secret, path, editor) | 08 | §8.8.5 |
| Recipe expressions and control flow | 08 | §8.8.6 |
| Recipe `postInit.bun:` action with `verb:` allowlist (`script`, `install`, `add`, `create`, `run`, `x`) | 08 | §8.8.8 |
| Programmatic recipes (`recipe.ts`) | 08 | §8.8.14 |
| Recipe `runs:` allowlist + `ctx.run` (API-backed prompt choices via canonical commands) | 08 | §8.8.3 + §8.8.14 |
| Recipe `fetchAllowlist:` + `ctx.fetch` (allowlisted HTTP GET during init) | 08 | §8.8.3 + §8.8.14 |
| Prompt `choicesFrom:` (dynamic select/multiselect choices from a canonical command) | 08 | §8.8.3 + §8.8.5 |
| Programmatic Landofile (`landofile.ts`) | 07 | §7.1.1 |
| Canonical recipes shipped in core | 08 | §8.8.10 |
| Renderers and messages | 08 | §8.9 |
| Renderer first-paint contract | 08 | §8.9.1 |
| Concurrent task tree contract (multi-task UI, per-task tail, alt-screen expand) | 08 | §8.9.2 |
| Interaction and prompts (`InteractionService`, the input peer of `Renderer`) | 08 | §8.10 |
| Prompt vocabulary (`PromptSpec`, `PromptType`, `PromptChoice`, `PromptValidate`) | 08 | §8.10.1 |
| `InteractionService` interface and answer-source precedence | 08 | §8.10.2 + §8.10.3 |
| `InteractionService` pluggability (headless/CI, recording/test, GUI/host) | 04 + 08 | §4.2 + §8.10.5 |
| `interactionServices:` plugin contribution surface | 10 | §9.5 |
| Interaction contract suite (mandatory) | 13 | §13.1 |
| `TestInteractionService` test fixture | 09 | §16.8 |
| Embedding `interaction` policy (library-mode non-interactive default) | 09 | §16.3 + §8.10.3 |
| `task.tree.start` / `task.tree.complete` render events | 08 | §8.9 |
| `task.detail` render event (per-task tail) | 08 | §8.9 |
| `task.detail.expand` / `task.detail.collapse` render events | 08 | §8.9 |
| Embedding concept and use cases | 09 | §16.1 |
| Public API surface (entry points, stability) | 09 | §16.2 |
| `@lando/core/paths` export (root/path resolver) | 02 + 09 | §2.7 + §16.2 + §7.5.1 |
| `@lando/core/landofile` export (canonical serializer) | 02 + 09 | §2.7 + §16.2 + §7.8.1 |
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
| Plugin postinstall-script trust policy | 10 | §9.6 |
| `lando plugin trust*` model (resolved: list/revoke shipped, non-expiring) | 01 | §14.2 |
| Plugin authoring toolkit (`meta:plugin:new`/`test`/`build`/`link`/`unlink`/`publish`) | 10 | §9.10 |
| Plugin loading rules | 10 | §9.7 |
| `LandoPluginContext` | 10 | §9.8 |
| Networking intent (no shared bridge in core) | 11 | §10.1 |
| Proxy/routing service | 11 | §10.2 |
| Public tunnels and app sharing (`TunnelService`) | 11 | §10.2.2 |
| `tunnelServices:` plugin contribution surface | 04 + 10 | §4.2 + §9.5 |
| `app:share` / `app:share:list` / `app:share:stop` commands | 08 | §8.2 |
| `Tunnel` lifecycle event scope (`pre-/post-tunnel-start`, `tunnel-ready`, …) | 03 | §3.5 + §10.2.2 |
| `tunnel-registry` cache (detached share sessions) | 12 | §12.1 |
| `TunnelService` contract suite | 13 | §13.1 |
| Certificate authority service | 11 | §10.3 |
| Corporate proxies and outbound trust | 11 | §10.3.1 |
| SSH and host identity (sidecar-by-default agent) | 11 | §10.4 |
| Host proxy (container→host RPC: `xdg-open` shim, in-container `lando` shim) | 11 | §10.10 |
| Host-proxy wire protocol (`openUrl`, `openPath`, `runLando`, `runBun`, `notify`, `clipboardCopy`, NDJSON streaming) | 11 | §10.10.2 |
| Host-proxy `runBun` channel + verb allowlist | 11 | §10.10.2 |
| In-container shim binary (argv[0] dispatch on `xdg-open` / `open` / `lando`) | 11 | §10.10.3 |
| `lando.host-proxy` built-in service feature | 06 | §6.11 |
| `lando.bun-self` built-in service feature (container-side Bun primitive) | 06 | §6.11 |
| `LANDO_HOST_PROXY_SOCKET` / `LANDO_HOST_PROXY_TOKEN` / `LANDO_HOST_PROXY_DEPTH` env | 06 | §6.9 |
| `HostProxyService` core service | 03 | §3.4 |
| `DoctorService` core service | 03 | §3.4 |
| `HostProxyService` pluggability (headless CI, audited builds, recording) | 04 + 11 | §4.2 + §10.10.5 |
| `pre-host-proxy-call` / `post-host-proxy-call` lifecycle events | 03 | §3.5 + §11.2 |
| `tooling-step-start` / `-skip` / `-complete` / `-fail` lifecycle event payloads | 03 | §11.2 |
| `hostProxyAllowed` field on `LandoCommandSpec` and tooling tasks | 08 | §8.3 + §8.5.1 |
| `host-proxy-allowlist` cache | 12 | §12.1 |
| Per-app `host-proxy.sock` persistent artifact | 12 | §12.4 |
| Host-proxy contract suite (mandatory) | 13 | §13.1 |
| Healthcheck runner + URL scanner | 11 | §10.5 |
| Probe / RetryPolicy primitive (`@lando/sdk/probe`) | 11 | §10.5.1 |
| Host-target healthchecks (`ShellRunner`-backed) | 11 | §10.5 |
| Files and performance | 11 | §10.6 |
| `FileSyncEngine` pluggable abstraction | 04 + 11 | §4.2 + §10.6 |
| `FileSyncEngineRegistry` core service | 03 | §3.4 |
| Mount realization (`passthrough` vs `accelerated`) | 06 | §6.4 |
| `bindMountPerformance` provider capability | 05 | §5.4 |
| Bundled `@lando/file-sync-mutagen` engine | 11 | §10.6.2 |
| `FileSyncEngine` doctor checks | 11 | §10.6.3 |
| `FileSyncEngine` replaceability (audited / air-gapped / alternate engines) | 11 | §10.6.4 |
| `HttpClient` outbound-egress chokepoint (proxy/CA-aware, streaming, upload, redacted) | 04 + 11 | §4.2 + §10.3.2 |
| `Downloader` verified downloads (checksum-verified, atomic, wraps `HttpClient`) | 04 + 11 | §4.2 + §10.3.3 |
| Tool provisioning (`ToolManifest` + extract + `bin/` install over `Downloader`) | 11 | §10.3.4 |
| `pre-http-call` / `post-http-call` lifecycle events | 03 | §3.5 + §11.2 |
| `pre-download` / `download-progress` / `post-download` lifecycle events | 03 | §3.5 + §11.2 |
| HttpClient and Downloader contract suites (mandatory) | 13 | §13.1 |
| `DataMover` local/volume byte-movement chokepoint | 03 + 11 | §3.4 + §10.11 |
| `DataEndpoint` model and transfer dispatch | 11 | §10.11.1 |
| Volume snapshot / restore + snapshot store | 11 + 12 | §10.11.3 + §12.4 |
| Provider data-plane methods + capabilities (snapshot/copy/artifact export-import, ephemeral mounts) | 05 | §5.3 + §5.4 |
| `Data` lifecycle event scope | 03 | §3.5 |
| Cache-volume storage kind (`kind: cache`) | 06 | §6.5 |
| DataMover / provider data-plane contract suite | 13 | §13.1 |
| `pre-file-sync-*` / `post-file-sync-*` lifecycle events | 03 | §3.5 + §11.2 |
| `file-sync-conflict-detected` / `file-sync-progress` events | 03 | §11.2 |
| `file-sync-sessions` cache | 12 | §12.1 |
| Mutagen daemon socket / binary persistent artifacts | 12 | §12.4 |
| File sync engine contract suite | 13 | §13.1 |
| Mutagen gRPC client codegen entry | 15 | §17.2 |
| Mutagen versions manifest codegen entry | 15 | §17.2 |
| `lando setup --skip-file-sync` flag | 11 | §10.8 |
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
| State store (durable, atomic, lockable persistence) | 12 | §12.7 |
| `StateStore` core service | 03 | §3.4 |
| `StateBucket` / `StateBucketSpec` / `StateRoot` / `StateCodec` | 12 | §12.7.1 |
| `StateStore` plugin exposure (pre-namespaced `stateStore`) | 10 | §9.8 |
| Test layers + Effect testing patterns | 13 | §13.1 |
| Plugin-abstraction contract suites (tooling-engine / route-filter / secret-store / config-translator / plugin-source / doctor-check) | 13 | §13.1 |
| Library API contract suite | 13 | §13.1 |
| `App` handle / `AppSelector` embedding primitive | 09 | §16.3 |
| `openLandoRuntime` retained runtime object | 09 | §16.3 |
| `resolveApp` Layer-native App resolver | 09 | §16.3 |
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
| Executable guides and scenarios (mission and applicability) | 17 | §19.1 |
| Guide MDX artifact and frontmatter | 17 | §19.2 |
| `GuideFrontmatter` schema | 17 | §19.2 |
| Diátaxis bucket constraints (`tutorial`/`how-to` only) | 17 | §19.2 + §19.10 |
| Guide/scenario component vocabulary | 17 | §19.3 |
| `<Guide>` / `<Scenario>` / `<Step>` / `<Run>` / `<Verify>` / `<Inspect>` props | 17 | §19.3 |
| `<Hidden>` / `<Cleanup>` / `<Variable>` / `<Skip>` / `<Inline>` props | 17 | §19.3 |
| `MatcherSchema` (declarative scenario assertion vocabulary) | 17 | §19.3 |
| `ScenarioContext` runtime surface | 17 | §19.4 |
| Display-vs-execute dual binding | 17 | §19.5 |
| Transcript capture, redaction, and embedding | 17 | §19.6 |
| `Transcript` / `TranscriptFrame` schemas | 17 | §19.6 |
| `scripts/build-guide-scenarios.ts` (MDX → generated scenario TypeScript codegen) | 17 + 15 | §19.7 + §17.2 |
| Source-location preservation (`@source` headers, source-mapper reporter) | 17 | §19.8 |
| Hidden / cleanup discipline (ratio cap, mandatory cleanup) | 17 | §19.9 |
| `bun run lint:guides` (lint gate) | 17 + 13 | §19.10 + §13.4 |
| Executable-guides/generated-scenarios test layer | 17 + 13 | §19.11 + §13.1 |
| Recipe README MDX (`recipes/<id>/README.mdx`) and strip-and-flatten | 17 + 08 | §19.13 + §8.8.2 |
| `scripts/build-recipe-readmes.ts` | 17 + 15 | §19.13 + §17.2 |
| Library-mode guides (runtime-target `<Run>`) | 17 + 09 | §19.14 + §16 |
| Executable guide acceptance checklist items | 17 + 14 | §19.15 + §15.C |
| Tabbed variants (axes, Cartesian product, multi-test codegen) | 17 | §19.16 |
| `tabs:` (single-axis) and `axes:` (multi-axis) frontmatter declarations | 17 | §19.2 + §19.16 |
| `<Tabs>` and `<Tab>` components | 17 | §19.3 + §19.16 |
| `TabAxis` / `TabAxisValue` schemas | 17 | §19.3 |
| Per-cell variant overrides (`variants:` map) | 17 | §19.16 |
| Cross-page tab sync (`syncKey`) | 17 | §19.16 |
| `test.skip` for axis-coverage gaps | 17 | §19.7 + §19.16 |
| Per-variant test file naming (`<id>.<axis-value>...test.ts`) | 17 | §19.7 + §19.16 |
| Recipe README scaffolding with axis-resolved tabs | 17 + 08 | §19.13 + §8.8.2 |

| The global app (concept and overview) | 18 | §20.1 |
| Global app identity, reserved id `global`, slug reservation | 18 | §20.2 |
| `AppIdReservedError` | 18 | §20.2 + §20.13 |
| Global Landofile location and merge order | 18 | §20.3 |
| Generated `.lando.dist.yml` for the global app | 18 | §20.3 |
| Plugin enablement map (`<userConfRoot>/global.config.yml`) | 18 | §20.3.1 |
| Global app discovery rules (excluded from cwd walk) | 18 | §20.3.2 |
| `globalServices:` plugin contribution surface | 18 | §20.4 + §4.2 |
| `GlobalServiceContext` plugin context tag | 18 | §20.4 |
| `GlobalAppService` core service | 18 | §20.5 + §3.4 |
| `global` bootstrap level | 18 | §20.6.1 + §3.2 |
| `Global` lifecycle event scope | 18 | §20.6.2 + §3.5 |
| `pre-global-start` / `post-global-start` events | 18 | §20.6.2 + §11.2 |
| `pre-global-dist-regenerate` / `post-global-dist-regenerate` events | 18 | §20.6.2 + §11.2 |
| `AppFeature.requires.globalServices` | 18 | §20.6.3 + §6.11.4 |
| Auto-start of global services via `AppFeature` | 18 | §20.6.3 |
| `meta:global:*` CLI namespace | 18 | §20.7 + §8.2 |
| `meta:global:start` / `stop` / `restart` / `rebuild` / `destroy` / `info` / `logs` / `list` / `config` / `install` / `uninstall` | 18 | §20.7 + §8.2 |
| `apps:poweroff --keep-global` flag | 18 | §20.7 + §8.2 |
| `global:` top-level alias prefix reservation | 18 | §20.7.1 + §8.1.2 |
| `<service>.global.internal` DNS | 18 | §20.8.1 + §10.1 |
| `LANDO_GLOBAL_*` environment variables | 18 | §20.8.2 + §6.9 |
| `globalServices.<name>.*` cross-service expression scope | 18 | §20.8.3 + §7.3.1 |
| Storage scope semantics inside global services | 18 | §20.9 + §6.5 |
| `ProxyServiceTraefikGlobalAppLive` (default proxy realization) | 18 | §20.10.1 + §10.2 |
| `ProxyContributionPairError` | 18 | §20.10.1 + §20.13 |
| `LegacyProxyContainerDetected` doctor diagnostic | 18 | §20.10.3 + §10.9 |
| `@lando/service-mailpit` reference plugin | 18 | §20.11.1 + §1.4 |
| Migration of `@lando/proxy-traefik` to global-app realization | 18 | §20.11.2 + §10.2 |
| Global app non-goals (multi-host, user-relocatable, explicit `dependsOn`) | 18 | §20.14 |
| `global-app-plan` cache | 18 | §12.1 |

| Scratch apps (concept and overview) | 19 | §21.1 |
| Scratch app identity, separate id namespace, `AppRef.kind` discriminator | 19 | §21.2 + §11.2 |
| Scratch app root (`<userCacheRoot>/scratch/<id>/`) and discovery exclusion | 19 | §21.3 + §12.4 |
| Scratch sources (`fork` / `from-recipe`) and `ScratchSource` schema | 19 | §21.4 |
| Fork-mode copy semantics and excludes (`scratch.fork.excludes:`) | 19 | §21.4.1 + §7.5 |
| Scratch-mode recipe render (no `postInit:` by default; `--run-post-init`) | 19 | §21.4.2 + §8.8.8 |
| `ScratchAppService` core service | 19 | §21.5 + §3.4 |
| `scratch` bootstrap level | 19 | §21.6.1 + §3.2 |
| `Scratch` lifecycle event scope | 19 | §21.6.2 + §3.5 |
| `pre-scratch-acquire` / `-materialize` / `-start` / `-stop` / `-destroy` / `-gc` events | 19 | §21.6.2 + §11.2 |
| `--isolate=full|baked|cwd` mount-isolation knob | 19 | §21.7 |
| `--mount-cwd` sugar for `--isolate=cwd` | 19 | §21.7 + §21.10.1 |
| `scope: global` → `scope: app` rewrite (and `--share-global-storage` opt-out) | 19 | §21.8 + §6.5 |
| `ScratchHostnameSuffix` route filter and `--no-hostname-suffix` / `--hostname` overrides | 19 | §21.9.2 + §6.6 |
| `apps:scratch:*` CLI namespace | 19 | §21.10 + §8.2 |
| `apps:scratch:start` / `:stop` / `:destroy` / `:list` / `:info` / `:logs` / `:gc` | 19 | §21.10 + §8.2 |
| `apps:poweroff --keep-scratch` flag | 19 | §21.6.3 + §21.10 + §8.2 |
| `scratch:` top-level alias prefix and bare `scratch` reservation | 19 | §21.10.2 + §8.1.2 |
| Scratch registry (`<userCacheRoot>/scratch/registry.bin`) | 19 | §21.11 + §12.1 |
| `apps:scratch:gc` orphan reaping (registry walk + provider-label scan) | 19 | §21.11 |
| `dev.lando.scratch` / `dev.lando.scratch-id` provider labels | 19 | §21.2 + §21.8 + §6.5 |
| `LANDO_APP_KIND` environment variable | 19 | §21.2 + §6.9 |
| Library-mode `makeLandoRuntime({ scratch: ... })` acquisition | 19 | §21.12 + §16.3 |
| `scratch-app-plan` cache | 19 | §12.1 |
| `scratch-app-info` cache | 19 | §12.1 |
| `scratch-build-results` cache | 19 | §12.1 |
| `scratch-registry` cache | 19 | §12.1 |
| Scratch app non-goals (CoW/overlay, fleets, hot-reload, cross-app reference) | 19 | §21.15 |

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
- Secret/PII redaction: the single canonical redactor — value layer, pattern-class catalog, three profiles (`secrets`/`telemetry`/`transcript`), and the `[redacted]` sentinel — is owned by `@lando/sdk/secrets` and surfaced through the core `RedactionService` (§3.7, §3.4). It is a non-replaceable security invariant; there is no `redactors:` plugin surface (§4.2). Every surface that emits potentially-sensitive output composes it; the §13.4 redaction-boundary gate forbids ad-hoc redaction elsewhere.
- Package entry points and public library exports: `package.json#exports` plus the API report gate (§2.7, §16.2, §13.4).
- Recipe action types and `postInit.command` allowlist: generated from command metadata (§8.8.8).
- Acceptance checklist items: stable checklist ids mapped to tests and public surfaces (§15.C, §17.9).
- Deprecation notices for every public surface: registered through schema annotations, contract fields, manifest fields, or TSDoc tags per §18.5; published as the merged `DeprecationService` registry (§18.3) and as `dist/schemas/deprecation-notice.json` (§18.2).
- Executable-guide component vocabulary: prop schemas, `GuideFrontmatter`, `ScenarioProps`, `MatcherSchema`, `Transcript`/`TranscriptFrame`, `TabAxis`/`TabAxisValue`, `TabsProps`/`TabProps`, and the redaction list are contracts owned by `@lando/sdk/docs/components` and `@lando/sdk/docs/redactions` (§19.3, §19.6, §19.16); the JSX/Astro runtime implementations and the Starlight integration are owned by `@lando/core/docs/components` (an entry point in `@lando/core`, not in `@lando/sdk`, because contracts-only is preserved); the `ScenarioContext` service tag is owned by `@lando/core/testing` (§19.4, §16.8).

Surface change checklist:

- Add or update the canonical registry entry first.
- Update generated docs/codegen inputs and the topic lookup when the surface is user-visible.
- Add or update schema/API/command/event/service drift gates in §13.4 when the change creates a new class of surface.
- Add a library/API test for public exports and a CLI/e2e test for user-visible commands.
- Update the acceptance checklist when the surface affects release readiness.

When the spec changes, edit the relevant part(s) directly and update the topic lookup above. There is no re-split step.
