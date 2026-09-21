# Lando v4 — Appendices

> **Part 14 of 18** · [Index](./README.md)
> **Read next:** [15 Binary Build and Release Engineering](./15-binary-build-and-release.md)

This part is reference material, not workflow. Keep it open while reading the other parts.

---

## 15. Appendices

### A. Provider-neutral language

| Avoid in core | Use in core |
|---|---|
| Docker engine | Runtime provider |
| Container | Service instance |
| Image | Artifact, except in container-provider docs |
| Compose cache | App plan cache |
| Docker network | Network plan or provider network |
| Docker volume | Data store or storage plan |
| Exposed port | Endpoint |
| Traefik middleware | Route filter |
| Docker labels | Provider metadata |
| Dockerfile | Sourcefile, or Containerfile in container-specific docs |
| Mutagen | File-sync engine; use the product name only in `@lando/file-sync-mutagen` docs and §10.6.2 |
| Mutagen session | File-sync session |
| Mutagen daemon | File-sync daemon; §10.6.2 alone uses “Mutagen daemon” canonically |

### B. Forbidden core dependencies

Core MUST NOT contain, in source or `package.json` dependencies:

- Direct Docker, Podman, provider-SDK, or provider-CLI imports or shellouts, including `docker`, `podman`, and `kubectl`.
- Hard-coded provider sockets, application paths, troubleshooting commands, or provider-native plan files as source of truth.
- Proxy-implementation labels or dynamic configuration files.
- Lando 3 service parser, builder, or inheritance logic.
- `dockerode`, `dockerfile-generator`, `mkcert`, `pacote`, `yargs`, `inquirer`, `listr2`, `chalk`, `lodash`, or `axios`.

### C. Source-derived acceptance checklist

The v4 implementation must satisfy every item below; binary-shipping criteria remain in §17.9.

- Landofile discovery works from subdirectories; configured names and pre/post merge files work; `load()` and `import()` decode YAML, JSON, TOML, text, and binary; expressions resolve across Landofiles, includes, global config, events, and tooling without implicit shell execution (§7.3, §7.7).
- Canonical namespaced commands and configured top-level aliases both resolve. Global `commandAliases.disabled`/`custom` require no rebuild; app-local custom aliases override built-in, plugin, or global aliases only in that app while canonical ids remain callable.
- Tooling can wrap a canonical command with `command:` plus surrounding shell steps. Literal and resolved flags/args/raw inputs validate against `LandoCommandSpec` or raise `CommandInputValidationError`; direct and indirect cycles raise `ToolingCommandCycleError`; effective bootstrap is the reachable maximum and is cached.
- Tooling defaults to `app:` and may request `topLevelAlias`; plugin namespaces must match id prefixes; all alias collisions fail with remediation.
- Config translators detect external sources, preview fragments, and write only after validation. `app:cache:refresh` rebuilds app plan, tooling graph, and command index without starting services.
- `lando app config` edits the user Landofile with schema validation; `lando meta config` edits `<userConfRoot>/config.yml` with schema validation.
- `lando apps init --recipe <id>` is deterministic between interactive defaults and `--no-interactive --answers`; every canonical `recipes/` scaffold validates.
- `includes:` supports local, git, and npm fragments, precedence merge, and `.lando.lock.yml` refs/checksums; warm `app:includes:verify` is offline. Landofile `plugins:` materialize into app-scoped locked stores and are reused offline.
- The canonical service catalog covers PHP, Node, Python, Ruby, Go, nginx, apache, MariaDB, MySQL, PostgreSQL, Redis, Memcached, Valkey, Solr, Elasticsearch, OpenSearch, Meilisearch, Mailpit, Mailhog, RabbitMQ, MinIO, LocalStack, static, and `compose` passthrough.
- `app:info` supports service/path filtering, deep, JSON, and table output; `apps:list --all` works outside apps; `app:logs --service` streams one service; restart, stop, and poweroff scopes differ correctly; service-less apps do not crash service-independent commands.
- Tooling supports Taskfile-style `cmds`, `deps`, `vars`, `env`, `dotenv`, `sources`, `generates`, `status`, `preconditions`, `run`, `internal`, `aliases`, `toolingIncludes`, subdirectory cwd mapping, dynamic service selection, expressions, pass-through args, and host execution through `ShellRunner`.
- Lazy replaceable `ShellRunner` and `ProcessRunner` both ship. The host `ToolingEngine` preserves Bun Shell pipelines and built-ins cross-platform; host `vars.sh` escapes interpolation, redacts secrets, and rejects raw values.
- `.lando/scripts/<name>.bun.sh` auto-registers validated `app:` commands, with Landofile tooling winning conflicts. `app:shell` provides host or service REPL behavior and raises `ShellRequiresTtyError` without a TTY.
- Host healthchecks use `ShellRunner` and unsupported targets raise `HealthcheckTargetUnsupportedError`. Recipe `postInit.bun` scripts are contained and checksum-verified or raise `BunScriptChecksumError`.
- Doctor shell checks and fixes produce redacted transcripts at `<userCacheRoot>/logs/doctor/<run-id>.transcript`; `--transcript-only` prints them. Every core `ShellRunner` invocation publishes `pre-shell-exec` and `post-shell-exec`. Release/codegen scripts use `Bun.$` for shell shapes and `Bun.spawn` for argv shapes.
- Lifecycle and tooling events compose; CLI events use canonical ids regardless of aliases.
- Routes cover hostname, port, path, wildcard, and object forms; route filters express request/response headers provider-neutrally; certificates support disabled, generated, and custom forms with required SANs; host access uses `host.lando.internal` and `LANDO_HOST_IP` when supported.
- `lando.host-proxy` binds `<userDataRoot>/run/<app-id>/host-proxy.sock`, unlinks it on stop/finalization, and installs deterministic `xdg-open`/`open`/`lando` shim behavior through authenticated `openUrl` and `runLando` requests.
- `HostProxyService` enforces token auth, URL schemes, `host-proxy-allowlist`, recursion, and concurrency; rejected calls still publish redacted events. Lifecycle commands are forbidden by `HostProxyAllowlistConflictError`; one retained runtime serves nested calls; every implementation passes the host-proxy suite.
- Healthchecks support disabled, string, script, array, object, user, retry, and delay forms. SSH loading supports disablement and allowlists and defaults to the sidecar agent. SQL plugins can expose import/export. Mount includes/excludes are per mount.
- Slow-provider binds use the active `FileSyncEngine` invisibly; canonical config MUST NOT expose engine identity. `@lando/file-sync-mutagen` auto-selects, provisions pinned binaries under `<userDataRoot>/bin/`, uses its Lando-owned daemon endpoint, ignores system Mutagen, and is doctor-visible.
- File-sync lifecycle and conflict/progress events publish with home-path normalization. `MountPlan.realization` derives from provider capability; exclusion fallback follows §6.4. Passthrough and Mutagen pass the contract/performance suites. Library mode gets only passthrough unless bundled discovery is enabled.
- Supported Compose input is normalized without silent loss; provider details require explicit extension or native capability.
- Plugins install from registry, git, directory, or tarball. Compiled binaries load validated absolute `file://` external modules while bundled plugins remain static; module paths MUST stay within package roots.
- Logger, renderer, and tooling engine are configurable. Missing providers produce installation guidance.
- Compiled level-`none`, `minimal`, and `tooling` commands meet §2.1 p95 budgets. Level-`none` uses embedded data without OCLIF or services; `bin/lando.ts` short-circuits recognized shapes and falls through unknown flags; bytecode and generated static bootstrap layers are mandatory.
- `cwd-app-map` provides warm constant-time resolution. Hot-path caches are versioned binary data; incompatible headers regenerate. The command-registry manifest is build-embedded, not a runtime cache.
- Renderer first paint, spinner, and table-header budgets hold. Telemetry never blocks, changes exit status, or hangs shutdown. Zero-subscriber event publication is a no-op. Bootstrap levels are sequential while independent in-level IO is concurrent.
- `lando events --follow --format json` streams traces. `lando uninstall --dry-run` reports ownership; `--yes` removes only Lando-owned binary/data/cache paths, not provider resources.
- Hot tooling uses only command and plan caches. Routine post-build local development works offline unless user work or absent remote artifacts require network. All Lando egress honors corporate proxies and custom CAs.
- `makeLandoRuntime` imports without OCLIF; `EmbeddedAssetService` is host-overridable but not plugin-contributed. `openLandoRuntime(...).app(...)` and `resolveApp(...)` provide typed start/info/exec/stop operations with tagged remediation.
- Retained embedding runtimes meet hot-path budgets after first use; `@lando/core/testing` tears down deterministically; discovery sources are independently opt-in and default to none; multiple runtimes do not share caches/events; library and binary versions match.
- Every §18.5 public surface supports canonical deprecation. `DeprecationService`, doctor, config, docs, JSON Schema, events, telemetry, and warnings derive from one registry; stale or overdue notices fail release with `DeprecationStaleError` or `DeprecationOverdueError`.
- `--no-deprecation-warnings` and `LANDO_DEPRECATION_WARNINGS=0` suppress only renderer lines. Deprecated canonical commands cannot have non-deprecated aliases; violations raise `DeprecationContradictionError`.
- Every executable guide and recipe README regenerates typed runnable scenarios with source-mapped failures. `lint:guides` enforces schemas, hidden/inline/divergence/cleanup rules, and forbids raw shell fences inside `<Guide>`.
- Guide component, frontmatter, matcher, and transcript schemas round-trip and publish JSON Schema. Published redactions are byte-identical. E2E cleanup is idempotent. Recipe README flattening leaves no JSX/imports/unresolved expressions. Library-mode guides execute actual runtime calls.
- Tabbed guides generate each Cartesian variant and transcript with prefixed failure context; non-uniform tab steps produce visible `test.skip` coverage entries.
- User slug `global` raises `AppIdReservedError`. `<userDataRoot>/global/` is excluded from cwd discovery. `globalServices:` regenerates the global `.lando.dist.yml`, starts through `meta:global:*`, and supports `<service>.global.internal` only with shared networking.
- `AppFeature.requires.globalServices` auto-starts requirements or raises `GlobalServiceMissingError`. `apps:poweroff` includes global services unless `--keep-global`. `RouterServiceTraefikGlobalAppLive` requires paired router/global contributions or raises `ProxyContributionPairError`.
- `@lando/service-mailpit` contributes its service type, global service, and framework-aware mail env feature. `global:` alias prefix is reserved. Global volumes carry `dev.lando.storage-global-app: "TRUE"`.
- Fork scratch apps copy into `<userCacheRoot>/scratch/<scratch-id>/root/` with exclusions and distinct labels; recipe scratches skip `postInit` by default and honor `baked`/`cwd` isolation and `--mount-cwd`.
- Scratch global storage rewrites to app scope unless `--share-global-storage`; routes use `ScratchHostnameSuffix` unless overridden. Foreground scope interruption destroys all scratch state; detached state persists in `<userCacheRoot>/scratch/registry.bin` and GC reconciles provider labels.
- `apps:poweroff` destroys scratches unless `--keep-scratch`; keep flags compose. Scratch ids and user slugs are separate namespaces keyed by `AppRef.kind`; every consumer considers both kind and id.
- Library scratch acquisition finalizes on scope close and remains steady-state under runtime reuse. The scratch contract suite covers copy, recipes, isolation, storage rewrite, routes, finalization, registry concurrency, and orphan GC.

### D. Why OCLIF (and not `@effect/cli`) — historical decision

OCLIF was originally selected for its mature plugin manifest, lazy-loading, install, and update ecosystem despite adapter costs around Effect and typed flags. Compiled Bun binaries later proved unable to use supported OCLIF dispatch because root discovery and runtime module loading require adjacent filesystem packages. The normative architecture is now one native registry and dispatcher for source and compiled modes (§8.4.1); registry completeness, machine-output conformance, and relocated-binary smoke replace the retired dual-dispatch parity design.

### E. Glossary

- **Adapter** — Plugin Layer implementing a port.
- **AppPlan** — Provider-neutral, schema-validated desired state for one app.
- **Artifact** — Provider-specific runnable asset.
- **BootstrapLevel** — Command declaration of required runtime depth.
- **Canonical command id** — Unique `<namespace>:<segments…>` identity; aliases never change events, caches, or API identity.
- **Command alias override** — App or global `commandAliases.custom` rebinding of a top-level alias while preserving the canonical id.
- **Command framework** — `CommandFramework` argv/help/registry abstraction; the default is the native shared dispatcher (§8.4.1).
- **Command namespace** — Core `app`, `apps`, `meta`, or a plugin-owned topic.
- **Command step** — Tooling `cmds[].command` invocation of a validated canonical command with lifecycle and bootstrap propagation.
- **Config translator** — Explicit plugin conversion from an external config source to a Landofile fragment and diagnostics.
- **DeprecationNotice** — Canonical schema for `since`, `removeIn`, severity, replacement, note, and optional documentation/ticket metadata (§18.2).
- **DeprecationService** — Service that records, deduplicates, publishes, and reports deprecated-surface use.
- **`deprecation-used` event** — Event emitted for registered deprecated-surface use.
- **Effect** — Runtime composition framework.
- **Embedding host** — Bun program constructing a Lando runtime instead of or alongside the binary (§16).
- **End-to-end suite** — Compiled-binary tests against a real provider and OS (§13.1).
- **Executable guide** — Authored MDX whose typed components compile to runnable scenarios (§19).
- **Executable-guides suite** — Tests all generated guide scenarios and variants through their declared layers.
- **Tab axis** — Ordered dimension of executable-guide variation; `tabs:` is single-axis sugar and is mutually exclusive with `axes:`.
- **Tab variant** — One Cartesian-product cell with isolated generated test, transcript, and runtime state.
- **Endpoint** — Service listener such as a port, path, or socket.
- **Host proxy** — Per-app authenticated container-to-host RPC channel exposed by `HostProxyService` (§10.10).
- **Host-proxy allowlist** — Generated canonical ids permitted through `runLando`; lifecycle commands are forbidden.
- **Entry point** — Documented `package.json#exports` path of `@lando/core`.
- **Feature** — Ordered, idempotent service-plan transformation.
- **File sync engine** — `FileSyncEngine` implementation for accelerated binds; bundled slow-provider default is `@lando/file-sync-mutagen`.
- **File sync session** — Scoped engine session for one accelerated mount, identified by `FileSyncSessionRef` and `mountKey`.
- **`bindMountPerformance` capability** — Provider declaration of `native`, `slow`, or `none` bind behavior.
- **Mount realization** — Planner-chosen `passthrough` or `accelerated` value on a bind `MountPlan`.
- **Fragment** — Pure partial Landofile loaded through `includes:`.
- **Global app** — Reserved host-level app `global` under `<userDataRoot>/global/` for cross-cutting services (§20).
- **`globalServices:` contribution surface** — Plugin declarations merged into the global app's generated distribution Landofile.
- **`GlobalAppService`** — Lazy service owning global Landofile generation, planning, and lifecycle.
- **Imperative shell** — CLI or embedding-host layer that runs Effect programs.
- **Include** — Local, git, npm, or registry reference to a fragment.
- **Layer** — Effect service provisioning and lifetime mechanism.
- **Library API** — Public semver-stable `@lando/core` surface.
- **Manifest** — Plugin declaration of contributions, requirements, and metadata.
- **Plan cache** — On-disk schema-encoded `AppPlan` for hot paths.
- **Port** — Service tag and interface on which core depends.
- **Provider** — `RuntimeProvider` implementation realizing app plans.
- **Recipe** — Init-time scaffold with prompts, files, and optional post-init actions; not a runtime abstraction.
- **Recipe suite** — Tests every canonical recipe with default and varied answers.
- **Renderer** — Plugin rendering progress, tables, and messages.
- **Route** — Host-facing HTTP/TLS mapping to endpoints.
- **Route filter** — Provider-neutral request/response transformation.
- **Scenario suite** — Public-library tests against `TestRuntimeProvider`.
- **Schema** — Effect Schema runtime-validated contract.
- **Scratch app** — Scope-bounded app whose resources and materialized state are purged at lifetime end (§21).
- **Scratch id** — Stable scratch identifier in a namespace separate from user slugs.
- **`AppRef.kind`** — `user | global | scratch` discriminator that partitions app identity.
- **`ScratchAppService`** — Lazy service owning scratch acquisition, materialization, lifecycle, registry, and orphan GC.
- **`ScratchHostnameSuffix` route filter** — Built-in scratch hostname collision-avoidance filter.
- **Scratch registry** — `<userCacheRoot>/scratch/registry.bin`, reconciled with provider labels for list and GC.
- **Scope** — Effect lifetime tracker that finalizes resources on close, failure, or interruption.
- **Service base** — `l337` raw artifact or opinionated `lando` service.
- **Service feature** — See **Feature**.
- **Service info** — Provider-neutral runtime metadata returned by app info.
- **Service plan** — One service's contribution to an `AppPlan`.
- **Service type** — Plugin resolver for `type: <name>` producing normalized config and features.
- **Subscriber** — Manifest-declared plugin event handler.
- **TaggedError** — Effect Schema error with discriminating `_tag`.
- **TestRuntime** — Pre-composed in-memory testing Layer from `@lando/core/testing`.
- **Tooling** — User-defined commands materialized from Landofile `tooling:` under `app:` by default.
- **Transcript** — Redacted generated capture of scenario runtime behavior and inspected artifacts.
- **ScenarioContext** — Per-scenario Effect service binding test directory, runtime, variables, events, and transcript writer.
- **Tooling task** — Taskfile-inspired node with commands, dependencies, expressions, status, and execution metadata.
- **ToolingEngine** — Pluggable executor for compiled tooling graphs.
- **Top-level alias** — Optional bare invocation path sharing its canonical command's identity.

---

*End of SPEC.md*
