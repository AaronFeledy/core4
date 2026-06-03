# Lando v4 — Appendices

> **Part 14 of 18** · [Index](./README.md)
> **Read next:** [15 Binary Build and Release Engineering](./15-binary-build-and-release.md)

This part is reference material, not workflow. Keep it open while reading the other parts.

Covered here: the provider-neutral language reference (which Docker-flavored terms to avoid in core docs and what to use instead), the explicit list of forbidden core dependencies (in source and in `package.json`), the source-derived acceptance checklist that the v4 implementation must satisfy, the full rationale for choosing OCLIF over `@effect/cli` as the default `CommandFramework`, and the glossary of terms.

---

## 15. Appendices

### A. Provider-neutral language

| Avoid in core | Use in core |
|---|---|
| Docker engine | Runtime provider |
| Container | Service instance |
| Image | Artifact (except in container-provider docs) |
| Compose cache | App plan cache |
| Docker network | Network plan or provider network |
| Docker volume | Data store or storage plan |
| Exposed port | Endpoint |
| Traefik middleware | Route filter |
| Docker labels | Provider metadata |
| Dockerfile | Sourcefile or Containerfile (in container-specific docs) |
| Mutagen | File-sync engine (in core docs); the bundled implementation may be referred to by name only within `@lando/file-sync-mutagen` plugin docs and within the §10.6.2 reference subsection |
| Mutagen session | File-sync session (in core docs) |
| Mutagen daemon | File-sync daemon (in core docs); the §10.6.2 reference subsection is the single place where "Mutagen daemon" is the canonical phrase |

### B. Forbidden core dependencies

Core MUST NOT contain (in source or `package.json` `dependencies`):

- Direct imports of Docker, Podman, or any provider SDK.
- Direct shellouts to provider CLIs (`docker`, `podman`, `kubectl`, …).
- Hard-coded provider socket paths (`/var/run/docker.sock`, …).
- Hard-coded provider application paths (`/Applications/Docker.app`, …).
- Provider-specific troubleshooting commands.
- Provider-native plan files as source of truth (compose.yml, Vagrantfile, …).
- Proxy implementation labels or dynamic config files (Traefik labels, …).
- v3 service parser, v3 service builder, v3 service inheritance logic.
- `dockerode`, `dockerfile-generator`, `mkcert`, `pacote`, `yargs`, `inquirer`, `listr2`, `chalk`, `lodash`, `axios`.

### C. Source-derived acceptance checklist

The v4 implementation must satisfy:

- Landofile discovery works from project subdirectories.
- Custom Landofile names and pre/post merge files work via global config.
- `load()` and `import()` expression helpers support YAML, JSON, TOML, text, and binary decoders (§7.3).
- Configuration expressions resolve across Landofile, fragment includes (§7.7), global config, events, and tooling without shell execution outside explicit tooling dynamic vars.
- Built-in commands resolve via both their canonical namespaced form (`lando app start`, `lando meta config set`, `lando apps list`) and their default top-level alias (`lando start`, `lando config set`, `lando list`) when one is configured.
- `commandAliases.disabled:` and `commandAliases.custom:` global config entries take effect without requiring a binary rebuild.
- A Landofile `commandAliases.custom.<alias>: <canonical-id>` entry overrides the same-named built-in, plugin, or global alias for that app's context, and the targeted canonical id remains callable directly via `lando <namespace> <segments>`.
- A tooling task can wrap a built-in by combining a Landofile `commandAliases.custom` override with a `command: <canonical-id>` step inside its `cmds:`; pre/post shell commands run in the same task without redefining the built-in.
- A `command:` step's `flags:`, `args:`, and `raw:` are validated against the target command's `LandoCommandSpec` at compile time when literal and at invocation time when expression-resolved; a mismatch surfaces as `CommandInputValidationError`.
- A config translator plugin can detect an external config source, generate a preview Landofile fragment, and apply it through `lando app config translate --write` only after normal Landofile validation succeeds.
- `app:cache:refresh` rebuilds the app plan cache, compiled tooling graph, and app command index without starting services.
- Direct and indirect cycles among `command:` steps are detected at compile time and rejected with `ToolingCommandCycleError`.
- A tooling task containing a `command:` step has its effective bootstrap level auto-escalated to the maximum of its declared level and every reachable target's required level; the cached `ToolingProgram` records the effective level so the hot path stays optimal.
- Tooling commands register under `app:` by default and may opt into a top-level alias via `topLevelAlias: true`.
- Plugin commands declare a target namespace (`app`, `apps`, `meta`, or their own cspace topic) and are rejected if the chosen namespace does not match the contributed id prefix.
- Top-level alias collisions across built-ins, plugins, tooling, and `commandAliases.custom:` are detected at registration and reported with remediation.
- `lando app config` reads/writes the user-editable Landofile and validates against the published schema before committing changes.
- `lando meta config` reads/writes the global config file at `<userConfRoot>/config.yml` and validates against the published schema.
- `lando apps init --recipe <id>` scaffolds a working app from a canonical recipe (§8.8.10) using interactive prompts; `--no-interactive --answers <file>` produces the same output deterministically.
- Every canonical recipe under `recipes/` produces a Landofile that passes schema validation with default answers.
- A Landofile `includes:` array (§7.7) loads local, git, and npm fragments, deep-merges them with file precedence rules, and writes an `.lando.lock.yml` recording resolved refs and checksums; `lando app includes verify` (canonical id `app:includes:verify`; §8.2) succeeds without network access on a warm cache.
- Landofile `plugins:` entries are resolved during app materialization/build, installed into an app-scoped plugin store, locked in `.lando.lock.yml`, and reused offline for subsequent local-dev commands.
- The canonical service-type catalog (§6.12) covers PHP, Node, Python, Ruby, and Go runtimes; nginx and apache; MariaDB, MySQL, and PostgreSQL; Redis, Memcached, and Valkey; Solr, Elasticsearch, OpenSearch, and Meilisearch; Mailpit and Mailhog; RabbitMQ; MinIO and LocalStack; static; and a `compose` passthrough.
- `lando app info` supports service filtering, path filtering, deep output, JSON, table.
- `lando apps list` works outside app context and supports stopped services with `--all`.
- `lando app logs --service <name>` streams one service.
- `lando app restart`, `lando app stop`, and `lando apps poweroff` have distinct, correct scopes.
- Apps with no services do not crash commands that can operate without services.
- Tooling supports Taskfile-inspired `cmds`, `deps`, `vars`, `env`, `dotenv`, `sources`, `generates`, `status`, `preconditions`, `run`, `internal`, `aliases`, and `toolingIncludes`.
- Tooling supports subdirectory working-directory mapping.
- Tooling supports dynamic service selection, expressions, host execution through `ShellRunner` (the `Bun.$`-backed primitive; §3.4), and pass-through args.
- A `ShellRunner` Live Layer (`Bun.$`-backed) is provided alongside `ProcessRunner` and is replaceable per §4.2; the default Live is constructed lazily via `Layer.suspend` so commands at level `minimal` that never shell out pay no `ShellRunner` cost.
- The bundled `host` ToolingEngine (§8.6) executes `service: :host` tasks through `ShellRunner` so multi-line `cmds:` with pipes, redirection, globs, and built-ins (`rm -rf`, `mkdir -p`, `cd`, `cat`, `mv`, `which`) work identically on Linux, macOS, and Windows without `cross-env`/`rimraf`/PowerShell branches.
- Tooling `vars.<name>.sh:` entries with `service: :host` (§8.5.3) resolve through `ShellRunner` with safe-by-default interpolation; `${…}` inputs are escaped and `${secret:…}` references redact in logs and lifecycle events; `{ raw: … }` is rejected at compile time inside `vars.sh:`.
- `.lando/scripts/<name>.bun.sh` files (§8.5.9) are auto-discovered during tooling compilation, validated against the `BunShellScriptFrontMatter` schema, and registered as canonical command id `app:<name>` (with directory-derived sub-namespaces); a Landofile `tooling.<name>:` entry of the same canonical id wins over the auto-discovery.
- `lando app shell` (§8.2.3) opens an interactive `Bun.$`-backed REPL with the app's `LANDO_*` env, host paths, and `host.lando.internal` resolution active; `--service <name>` runs the REPL inside a service via provider exec; without a TTY it errors with `ShellRequiresTtyError`.
- Host-target healthchecks (§10.5) declare `target: host` and run through `ShellRunner`; the planner refuses host-target healthchecks if no installed runner declares the capability with `HealthcheckTargetUnsupportedError`.
- Recipe `postInit.bun: { verb: script }` (§8.8.8) executes a recipe-bundled `.bun.sh` file through `ShellRunner.runScript()` after build-time-embedded checksum verification; the script's path MUST resolve inside the recipe's `templates/` or `assets/` tree; mismatched checksums fail with `BunScriptChecksumError`.
- `lando doctor` records every shell-shaped diagnostic and `--fix` step as a redacted transcript at `<userCacheRoot>/logs/doctor/<run-id>.transcript`; `lando doctor --transcript-only` prints the transcript to stdout without the rendered diagnostic UI (§10.9).
- `pre-shell-exec` / `post-shell-exec` lifecycle events (§3.5) publish for every `ShellRunner` invocation in core code paths (host ToolingEngine, `vars.sh:` evaluator, `.bun.sh` scripts, the `lando shell` REPL, recipe `bun: { verb: script }`, host-target healthcheck/scanner runners, doctor checks).
- The `scripts/release.ts` orchestrator (§17.1) and codegen scripts under `scripts/` use `Bun.$` directly for shell-shaped pipeline stages and `Bun.spawn` for argv-precise tool calls; production source under `core/src/` continues to route shell-shaped work through `ShellRunner` for redaction, lifecycle events, and pluggability.
- Events run around lifecycle and tooling commands, and events can call tooling tasks directly.
- CLI lifecycle events publish under the canonical command id (`cli-app:start-run`) regardless of which alias the user invoked.
- Routes support hostname, port, path, wildcard, and object forms.
- Route filters express request/response header manipulation without naming a proxy implementation.
- Cert generation supports disabled, generated, and custom cert/key forms.
- Service cert SANs include `localhost`, service name, internal hostname, configured hostnames, loopback IP.
- Host access works through `host.lando.internal` and `LANDO_HOST_IP` when capability allows.
- An app with the `lando.host-proxy` feature enabled binds a per-app Unix socket at `<userDataRoot>/run/<app-id>/host-proxy.sock` (mode `0600`) at `app:start` and unlinks it at `app:stop` or scope finalization (§10.10).
- The in-container shim binary, symlinked as `xdg-open` / `open` / `lando` inside `type: lando` services, dispatches `openUrl` and `runLando` requests to the per-app `HostProxyService` over the bind-mounted socket using `LANDO_HOST_PROXY_SOCKET` and `LANDO_HOST_PROXY_TOKEN`; missing env produces a deterministic stderr fallback message rather than a silent failure.
- `HostProxyService` enforces token Bearer auth, the URL scheme allowlist (rejecting `file://` always), the `host-proxy-allowlist` cache for `runLando`, the `LANDO_HOST_PROXY_DEPTH >= 3` recursion guard, and the per-app concurrency cap; rejected requests still publish `pre-host-proxy-call` / `post-host-proxy-call` events with redacted payloads (§10.10, §11.2).
- Lifecycle commands (`app:start`, `app:stop`, `app:rebuild`, `app:destroy`, `apps:poweroff`) are absent from the `host-proxy-allowlist` cache and registering them with `hostProxyAllowed: true` raises `HostProxyAllowlistConflictError` at registration time (§8.3, §13.1).
- `runLando` requests dispatch through `@lando/core/cli` against a single retained `LandoRuntime` held by `HostProxyService` for the app's started state; the second and subsequent in-container `lando` invocations meet the §2.1 hot-path budget at p95 (§10.10.1, §16.3).
- The host-proxy contract suite (§13.1) is mandatory and runs against both the bundled default `HostProxyServiceLive` and any plugin-contributed implementation.
- Healthchecks support disabled, string, script, array, object, user, retry, delay forms.
- SSH key loading supports disablement and allowlists; default uses sidecar agent.
- SQL helper plugins can expose import/export workflows for supported services.
- Mount excludes/includes are explicit on per-mount config.
- Bind mounts on a `bindMountPerformance: "slow"` provider (§5.4) are routed through the active `FileSyncEngine` (§10.6) without any user-facing config change. The user's Landofile carries `mounts: [..., type: bind, ...]` (or `appMount: <path>`) and the engine activation is invisible — no engine id surfaces in the canonical Landofile, no recipe or executable guide mentions it, and `lando config --format yaml` MUST NOT leak the engine id into committed config output.
- The bundled `@lando/file-sync-mutagen` engine is auto-selected on `bindMountPerformance: "slow"` providers, downloads its host CLI and per-platform agent binaries to `<userDataRoot>/bin/` during `lando setup` (or first accelerated `app:start`), and binds a Lando-owned daemon socket at `<userDataRoot>/run/file-sync/daemon.sock` (Linux/macOS) or the equivalent Windows named pipe (§12.4). The plugin refuses to use a system Mutagen install on PATH; `lando doctor` flags conflicting installs without blocking sync.
- Every `FileSyncEngine` session lifecycle transition publishes the matching `pre-/post-file-sync-*` event with the redacted `FileSyncSessionEvent` payload (§3.5, §11.2); host-home source paths normalize to `${HOME}/<...>` for non-debug subscribers and recorded transcripts.
- A `MountPlan` of `type: bind` carries a planner-set `realization: "passthrough" | "accelerated"` field (§6.4) derived deterministically from the resolved provider's `bindMountPerformance` capability. Engines declaring `exclusionPatterns: true` honor `excludes:` natively; engines declaring `false` fall back to the volume-shadow expansion described in §6.4.
- The §13.1 file-sync engine contract suite passes against `passthrough` and `@lando/file-sync-mutagen`; the §13.1 perf-budget suite asserts that `app:start` on a slow-IO provider engages the engine (`Layer.suspend` forced, daemon acquired, sessions created) and reuses cached `file-sync-sessions` entries on subsequent invocations.
- Library consumers receive only the `passthrough` engine by default; the bundled Mutagen engine is gated by the same opt-in (`discovery.bundled: true`) as every other bundled plugin (§16.4).
- Compose-compatible Landofile input is accepted only for the documented subset, normalized where portable, and never silently dropped; provider-specific Compose, labels, daemon, and network details remain invisible unless the user opts into the provider extension or selects a provider with native Compose capability.
- A user can install a plugin from registry, git, local dir, or tarball.
- A compiled binary can load external user/system/app plugins from validated absolute `file://` module URLs while keeping bundled plugins statically imported.
- External plugin module paths are rejected when they resolve outside the plugin package root.
- A user can swap the active logger, renderer, and tooling engine via global config.
- A user can run `lando` with no provider installed and receive guidance to install one.
- The compiled binary meets the §2.1 end-to-end budgets at p95 for level-`none` (`meta:version`, `meta:shellenv`, `meta:recipes:list`), level-`minimal` (`apps:list`), and level-`tooling` (Landofile-defined tooling) commands on a warm filesystem; the perf-budget suite (§13.1) gates this on per-PR CI.
- Level-`none` commands print from compile-time embedded data without importing `@oclif/core` or constructing any `Context.Service`, verified by the `LANDO_PERF_TRACE` allowlist snapshot.
- `bin/lando.ts` short-circuits the level-`none` argv shapes (§3.2) before any heavyweight import resolves; an unknown flag attached to a level-`none` shape falls through to OCLIF.
- The compiled binary embeds Bun bytecode (§2.1 `--bytecode`) so cold start does not pay JavaScript parse cost on every invocation.
- AOT-composed bootstrap layers (§17.2 codegen, "Bootstrap layers") are loaded as static imports per `BootstrapLevel`; runtime `Layer.merge` / `Layer.provide` chains in core are forbidden outside the codegen output.
- The `cwd-app-map` cache (§12.1) returns a resolved app root via O(1) lookup + one stat on the warm path; a deep-cwd `lando` invocation does not perform a directory walk after the first successful resolve.
- Hot-path caches (`core-command`, `plugin-command`, `app-command`, `cwd-app-map`, `oclif-manifest`, `app-plan`) use the §12.2 binary encoding with a versioned magic header; a header mismatch triggers automatic regeneration with no user-visible error.
- The Renderer first-paint contract (§8.9.1) is honored: pre-bootstrap banner within 50 ms cold for any command at level ≥ `plugins`; spinner appears for tasks exceeding 100 ms; tables emit headers within 80 ms cold.
- Telemetry events do not block command exit, do not change exit code on endpoint failure, and do not leave the process hanging on shutdown (§2.4, §3.4).
- `EventService.publish` is a no-op when the event has zero subscribers in the current runtime; subscriber lists are pre-sorted by priority at registration time (§11.1).
- Bootstrap levels are sequential, but independent IO-bound steps within a level run concurrently via `Effect.all({ concurrency: "unbounded" })` (§3.2).
- `lando events --follow --format json` streams lifecycle event traces for diagnostics and e2e assertions.
- `lando uninstall --dry-run` reports Lando-owned files that would be removed; `lando uninstall --yes` removes the binary when Lando owns the install path plus `<userDataRoot>` and `<userCacheRoot>` without deleting provider-owned runtime resources.
- The hot path for `lando <tooling-cmd>` does not hit the network or read more than the command + plan caches.
- After a successful app build, routine local-dev commands (`start`, `stop`, `restart`, `info`, `logs`, cached tooling) do not require internet access unless the app's own build/tooling commands or missing remote artifacts require it.
- Lando-owned network access for setup, plugin resolution, includes, recipes, updates, telemetry, runtime/provider downloads, provider artifact pulls, and Lando-initiated artifact builds works behind corporate proxies and custom CA chains.
- A Bun program can `import { makeLandoRuntime } from "@lando/core"` and obtain a fully-typed `Layer` without pulling OCLIF into the import graph.
- A Bun program can import `EmbeddedAssetService` from `@lando/core/services` and override it in tests without exposing it as a plugin contribution surface.
- A Bun program can plan, start, info, exec, and stop an app programmatically using `@lando/core/cli` operations (e.g., `appStart`, `appInfo`, `appStop`) and receive tagged errors with remediation messages.
- A long-lived embedding host (TUI, editor extension, dashboard, web server) can construct one `LandoRuntime`, execute many sequential `runTooling`, `appInfo`, and `appConfig.get`-style operations against it, and have operations 2..N each meet their respective §2.1 hot-path budget at p95 without paying repeat bootstrap cost. The library-mode reuse-perf test class in §13.1 asserts this on per-PR CI.
- A `bun test` suite can construct an isolated Lando runtime via `@lando/core/testing`, run lifecycle assertions, and tear down deterministically.
- An embedding host can opt into bundled, system, user, and app-local plugin discovery independently; the default in library mode is none.
- Multiple `makeLandoRuntime` instances coexist in one process without shared caches or cross-instance event bleed.
- The library package and the compiled binary ship at the same version from the same source.
- Every public surface in the §18.5 surface deprecation matrix is deprecable through the canonical mechanism for its kind (schema annotation, contract field, manifest field, or TSDoc tag), and a representative deprecation per kind has an end-to-end test exercising it (§18.8).
- The `DeprecationService` registry walk (§18.5) merges built-in contracts, schema annotations, and plugin manifests into a single registry; runtime lookups, `lando doctor --deprecations`, generated docs callouts, and JSON Schema `x-deprecation` extensions all derive from the same registry and never disagree.
- The release pipeline rejects any release whose `removeIn` notices have not been cleaned up: `DeprecationStaleError` for current-release stale notices, `DeprecationOverdueError` for past-release notices still on disk (§18.7).
- `--no-deprecation-warnings` and `LANDO_DEPRECATION_WARNINGS=0` suppress only the renderer's per-`(kind, id)` line; recording, the `deprecation-used` event, telemetry, `lando doctor`, and `lando config --format yaml` always include deprecations (§18.6).
- A non-deprecated alias of a deprecated canonical command is rejected at registration with `DeprecationContradictionError` (§18.1, §18.3).
- Every executable guide under `docs/src/content/docs/{guides,tutorials,how-to}/**` and `recipes/<id>/README.mdx` regenerates via `scripts/build-guide-scenarios.ts` into generated scenario tests that type-check under `tsc --noEmit` and run through each scenario's declared `layer`; failures map back to MDX or colocated case coordinates via the source-mapper reporter (§19.7, §19.8, §19.11).
- The guide linter (`bun run lint:guides`, §19.10) passes on every supported platform: frontmatter conforms to `GuideFrontmatter`, components conform to their published prop schemas, hidden/test-only scenario guardrails hold, the `<Inline>` density cap holds, the display:execute divergence cap holds, every `<Scenario layer="e2e">` carries at least one `<Cleanup>`, and no raw shell fenced blocks appear inside `<Guide>` elements.
- Every component prop schema in `@lando/sdk/docs/components`, plus `GuideFrontmatter`, `ScenarioProps`, `MatcherSchema`, `Transcript`, and `TranscriptFrame`, round-trips through encode/decode and is published as JSON Schema by the standard codegen pipeline (§19.3, §19.6, §13.2).
- The transcript redaction list in `@lando/sdk/docs/redactions` redacts every declared class (secrets, time-based values, container ids, port allocations, hostnames) byte-identically against a fixture transcript; the redaction gate is part of every build (§19.6, §19.10).
- The `<Cleanup>` blocks declared by every `layer: "e2e"` scenario are idempotent: the scenario harness exercises each cleanup twice in succession and asserts the second invocation does not error (§19.9).
- The strip-and-flatten output produced by `scripts/build-recipe-readmes.ts` (§19.13) for every recipe README scaffolds into a directory whose `README.md` contains no MDX JSX, no `import` statements, and no unresolved interpolation expressions; the rendered displayed commands match the user's intended workflow even though the test executes against `${ctx.testDir}`-based paths.
- Library-mode guides (§19.14) — those whose `<Run>` uses the `runtime` form — render TypeScript host-code snippets in the docs and exercise the same `LandoRuntime` operations in the generated test that an embedding host would call directly through `@lando/core/cli`.
- Tabbed guides (§19.16) — those declaring `tabs:` or `axes:` — generate one passing test file per Cartesian-product variant, each with a transcript file matching its axis-value path. The reporter prefixes failure output with the variant axis-value map. A multi-axis fixture guide with at least two axes and at least two values per axis is part of the per-PR matrix and asserts the codegen path end-to-end.
- Tab coverage gaps surface visibly: when a `<Tabs>` block's union of step names is non-uniform across tabs, every variant whose tab is missing one or more steps emits a `test.skip(<step-name>, "axis A=V …")` entry that the reporter renders alongside its variant prefix.

- A user app whose resolved `name:` normalizes to the slug `global` is rejected at Landofile parse time with `AppIdReservedError` and a remediation suggesting an explicit `name:` (§20.2).
- The global Lando app's directory at `<userDataRoot>/global/` is excluded from cwd-based app discovery and from the `cwd-app-map` cache (§20.3.2); only `meta:global:*` commands resolve to it.
- A plugin that contributes a `globalServices:` entry produces, after install, a regenerated `<userDataRoot>/global/.lando.dist.yml` containing the contributed service; a subsequent `meta:global:start` brings it up; `<service>.global.internal` resolves from inside any user-app service when the active provider declares `sharedCrossAppNetwork: true` (§20.4, §20.8.1).
- An `AppFeature` declaring `requires.globalServices: [<id>]` triggers `GlobalAppService.ensureRunning([<id>])` at `pre-start` of any user app whose plan activates the feature; a missing or disabled global service surfaces `GlobalServiceMissingError` and aborts the user app's start with remediation pointing at `meta:global:install <plugin>` (§20.6.3).
- `apps:poweroff` stops every Lando-managed service across user apps and the global app by default; `--keep-global` opts out (§20.6.4, §20.7).
- The default `ProxyService` Live Layer (`ProxyServiceTraefikGlobalAppLive` in `@lando/proxy-traefik`) realizes its routes through a `traefik` service running inside the global app; the plugin contributes both `proxyServices:` and `globalServices:` entries, and installing one without the other fails at plugin load with `ProxyContributionPairError` (§20.10.1).
- The bundled `@lando/service-mailpit` plugin contributes (a) a `mailpit` `ServiceType`, (b) a `globalServices:` entry, and (c) an `AppFeature` injecting `MAIL_HOST=mailpit.global.internal` and `MAIL_PORT=…` env into framework-aware user-app services; a fresh user app whose framework matches the feature's selectors gets working SMTP capture with no Landofile changes (§20.11.1).
- The reserved top-level alias prefix `global:` rejects plugin and tooling contributions whose `topLevelAlias` starts with `global:` (§20.7.1).
- Storage volumes created by global-app services carry `dev.lando.storage-global-app: "TRUE"` so `apps:poweroff --keep-global` can identify them (§20.9).

- A scratch Lando app acquired through `apps:scratch:start --fork` content-copies the resolved source app root into `<userCacheRoot>/scratch/<scratch-id>/root/` honoring `scratch.fork.excludes:` plus `--exclude` flags; mutations inside the scratch's services do not modify the source app root, and the scratch's containers carry distinct `dev.lando.scratch: "TRUE"` plus `dev.lando.scratch-id: <id>` provider labels (§21.4.1, §21.8).
- A scratch Lando app acquired through `apps:scratch:start --from <recipe-ref>` renders the recipe pipeline against the scratch root, skips the recipe's `postInit:` actions by default, defaults isolation to `--isolate=baked` (no appMount), and switches to `--isolate=cwd` when `--mount-cwd` is set; the host cwd at start time is bind-mounted at the appMount destination in cwd mode (§21.4.2, §21.7).
- A scratch's `scope: global` storage entries are rewritten to `scope: app` at plan time so a scratch start does NOT touch user-app `scope: global` volumes; `--share-global-storage` opts back into the original semantics, and the resulting volumes carry the `dev.lando.scratch-id: <id>` label so cleanup is deterministic (§21.8).
- A scratch's routes are auto-suffixed by the planner-applied `ScratchHostnameSuffix` filter so a fork-mode scratch's hostnames (`<host>--<scratch-id>.<domain>`) do not collide with the source app's; `--no-hostname-suffix` and per-host `--hostname <host>` opt out (§21.9.2).
- A foreground `apps:scratch:start` (no `--detach`) acquires the scratch under the OCLIF command's `Scope`; SIGINT propagates through `Effect.interrupt` into the scope finalizer, which destroys the scratch — containers, volumes (per §21.8 rules), proxy routes, host-proxy socket, build transcripts, materialized root, registry entry — before the process exits (§21.5, §21.6).
- A detached `apps:scratch:start --detach` registers the scratch in `<userCacheRoot>/scratch/registry.bin`; `apps:scratch:stop <id>` and `apps:scratch:destroy <id>` end its lifetime, and `apps:scratch:gc --prune` reaps orphans found via the registry walk plus the provider-label scan (§21.10, §21.11).
- `apps:poweroff` destroys every running scratch app by default; `--keep-scratch` opts out and reports the kept count in the renderer's final summary; `--keep-scratch` and `--keep-global` compose (§21.6.3, §21.10).
- Scratch ids and user-app slugs live in separate identifier namespaces: a user app named `scratch-foo` and a scratch app whose id begins with `scratch-foo-` coexist without collision because caches key by `(kind, id)` and provider labels carry both `dev.lando.storage-project` and `dev.lando.scratch-id` (§21.2, §7.4).
- The `AppRef` schema published from `@lando/sdk` carries a `kind: "user" | "global" | "scratch"` discriminator on every event payload, embedding-host API result, and provider operation; subscribers and embedding hosts switch on `kind` (or on the per-scope event `_tag`) when behavior depends on the kind of app (§11.2, §21.2).
- A library-mode embedding host that calls `makeLandoRuntime({ scratch: { source, isolate, shareGlobalStorage } })` receives a runtime whose `Scope` finalizer destroys the scratch on close; per-scratch acquisition latency stays steady-state when the host reuses the same `LandoRuntime` across many sequential `acquire` calls (§21.12, §16.3).
- The §13.1 scratch-app contract suite verifies fork-mode copy semantics (excludes honored, source files unmodified), scratch-mode recipe materialization, the three `--isolate` modes, the `scope: global` rewrite, the `ScratchHostnameSuffix` route filter, scope-finalizer destroy on Ctrl+C and on library-mode scope close, registry write/read concurrency under multiple simultaneous starts, and the `apps:scratch:gc` orphan-reap protocol against fixture orphan resources.

Binary-shipping criteria — items the v4.0.0 release pipeline (rather than the source) must satisfy — are catalogued separately in §17.9 (signing, notarization, SBOM, provenance, self-update, installer, codegen drift gates).

### D. Why OCLIF (and not @effect/cli)

OCLIF was kept as the default `CommandFramework` after consideration. The tradeoffs:

| Capability | OCLIF | @effect/cli |
|---|---|---|
| Plugin manifest model | Mature; battle-tested at Heroku/Salesforce | Nascent; would need to build |
| Lazy command loading | Built in via manifest | Possible but manual |
| Auto-update plugin | Mature plugin available | Not available |
| Friendly-name plugin install | Mature | Not available |
| Effect ergonomics | Adapter shim required | Native |
| Schema-typed flags/args | Adapter shim | Native |
| CommandFramework abstraction cleanliness | Sufficient — only `src/cli/oclif/` imports OCLIF | Same applies in reverse |

The decisive factor is the plugin ecosystem maturity: Lando v4 *is* a plugin platform, and OCLIF's plugin model maps directly onto Lando's needs. Building Lando's plugin system on top of `@effect/cli` would mean reimplementing manifest caching, lazy loading, and friendly-name install — exactly the layers OCLIF gives us for free.

The `CommandFramework` abstraction exists so that if `@effect/cli` reaches feature parity for plugin platforms, a Lando distribution can swap in an alternate adapter without touching core domain logic.

#### D.1 Compiled-binary dispatch spike

Source mode routes through `@oclif/core`'s `execute()`; the compiled `$bunfs` binary forks to the hand-rolled `runCompiledCli` (§8.4.1). The §14.2 decision "Compiled-binary CLI dispatch unification" asked whether that fork could be removed — option (a): make `execute()` dispatch reliably inside `bun build --compile` against the static `oclif.manifest.json` + `core/src/cli/oclif/compiled-commands.ts`, then delete `runCompiledCli` and the §8.4.1 relaxations; option (b): accept dual dispatch as permanent, promote §8.4.1's parity rules to normative, and add a compiled-binary parity test layer.

This spike ran both arms (`core/test/cli/dispatch-unification-spike.test.ts`; probe `core/test/cli/parity/oclif-static-probe.ts`; shared normalizer `core/test/cli/parity/normalize.ts`).

**Conclusion: option (b).** This outcome is now applied: §8.4.1's parity rules are normative, the compiled-binary dispatch parity test layer ships in §13.1 (`core/test/cli/parity/`), and the §14.2 "Compiled-binary CLI dispatch unification" decision is closed (see §14.2 "Resolved since this draft").

**Arm A — can `execute()` dispatch in the compiled binary?** No, not through any supported public API. A probe importing only `@oclif/core` and calling `execute()` was compiled with `bun build --compile` to its own outfile and run from a directory outside the source tree (a faithful relocated-deployment reproduction). It fails before any command runs:

```
Error: could not find package.json with {
  isRoot: true,
  pjson: undefined,
  root: '<binary path>'
}
```

Two filesystem boundaries break, neither addressable on the `$bunfs` virtual disk:

1. `Config.load(dir)` → `findRoot()` walks up from the entry path reading `package.json`. Next to a relocated single-file binary there is none, so `Config` throws (above) or mis-roots — losing the `oclif` topics, `flexibleTaxonomy`, hooks, and help plugin.
2. Even with a static manifest, command dispatch still resolves the target to an absolute path and does a runtime `import(pathToFileURL(filePath))` (`@oclif/core` `module-loader`). `bun build --compile` embeds only statically analyzable imports, so a runtime-computed path is not embedded and the module does not exist on real disk → `ModuleLoadError`. The `init` hook and `@oclif/plugin-help` load the same way.

OCLIF v4's `explicit`/`single` command-discovery strategies read an in-memory command map structurally identical to `compiled-commands.ts`, but they too resolve and `import()` their target file from disk, so they do not clear boundary 2. The only way to dispatch through OCLIF in-binary is to construct `Config`/`Plugin` programmatically and pre-populate private internals (`Plugin.commandCache`, `.manifest`, `.commands`, the plugins `Map`) so neither `findRoot` nor `module-loader` runs. That pins Lando to `@oclif/core` private implementation across patch releases — a fragility cost rejected here, bought only cosmetic gains (flexible-taxonomy space forms and byte-identical help, both already listed as accepted §8.4.1 divergences).

**Arm B — are the two shipping paths already at parity?** Yes. For the four target commands, source-mode `execute()` and the compiled `runCompiledCli` produce semantically identical results:

| Scenario | Command | Exit | Parity asserted |
|---|---|---|---|
| S1 happy | `meta:bun --version` (passthrough) | 0 | stdout equal after version normalization |
| S2 deferred | `meta:plugin:new --renderer=json` | 1 | JSON envelope byte-identical (modulo `timestamp`); `code = NotImplementedError` |
| S3 error | `app:start` (no Landofile) `--renderer=json` | 1 | JSON envelope byte-identical (modulo `timestamp`/temp path); `code = LandofileNotFoundError` |
| S4 setup | `meta:setup --provider=podman` (`PATH=/no-such-path`, temp roots) | 1 | exit + tagged `code = ProviderUnavailableError` + `commandId` equal |

The headline finding answers §8.4.1's open question on parity granularity: **the `json` renderer's event envelope is byte-identical across both paths**, while plain/`lando` stderr differs only in presentation — source-mode OCLIF prefixes `Error:` and wraps at terminal width, the compiled path prints the raw block and appends `logsDir`/`cacheDir`. The parity contract is therefore byte-identical on the JSON envelope and identical tagged-error fields (`code`, `commandId`, `remediation`, `specSection`) on plain output — not byte-for-byte on plain stderr. Green parity here is the evidence that promoting §8.4.1 to a normative, test-enforced contract (option b) is safe; that promotion and the compiled-binary parity test layer (§13.1, `core/test/cli/parity/`) are now in force.

### E. Glossary

- **Adapter** — A plugin Layer that implements a port (abstraction).
- **AppPlan** — Provider-neutral, schema-validated desired state for one Lando app.
- **Artifact** — Provider-specific runnable asset (image, template, manifest).
- **BootstrapLevel** — Declared by each command, indicates how much of the runtime to load.
- **Canonical command id** — The fully-qualified namespaced identifier of a command, of the form `<namespace>:<segments…>` (e.g., `app:start`, `meta:plugin:add`, `app:db:wait`). Every command has exactly one canonical id; lifecycle events, cache keys, and library API function names are derived from it. Top-level aliases (§8.1.2) are alternate invocation paths, not alternate ids.
- **Command alias override** — A `commandAliases.custom.<alias>: <canonical-id>` entry in the Landofile (§7.4) or global config (§7.5) that re-binds a top-level alias to a canonical id, possibly shadowing a built-in. Landofile-level overrides take effect inside the app context only; the targeted canonical id remains callable directly. The built-in mechanism for "redefine what `lando start` does in this project."
- **Command framework** — The pluggable `CommandFramework` abstraction (§4.2) that handles argv parsing, manifest, help, namespace-to-topic mapping, and top-level alias registration. Default implementation is OCLIF.
- **Command namespace** — One of the three core namespaces (`app`, `apps`, `meta`) or a plugin-owned topic. Each namespace is a top-level OCLIF topic and the prefix segment of every canonical id within it.
- **Command step** — A `cmds[].command:` entry in a tooling task (§8.5.2.1) that invokes another canonical command (built-in, plugin, or tooling) by id. The structured way to wrap or compose around a built-in. Inputs are validated against the target's `LandoCommandSpec`; lifecycle events for the target still publish; bootstrap level auto-escalates to the target's requirement.
- **Config translator** — A plugin contribution that detects external configuration files and returns a partial Landofile fragment plus diagnostics. Translators are invoked explicitly by `lando app config translate` or embedding hosts; they never run during normal app startup.
- **DeprecationNotice** — The canonical Effect Schema (§18.2) attached to a public surface to declare its deprecation. Carries `since`, `removeIn`, `severity`, `replacement`, `note`, optional `docsUrl` and `ticket`. Expressed across surfaces through schema annotations, contract fields, manifest fields, or TSDoc tags per the surface deprecation matrix in §18.5.
- **DeprecationService** — Core Effect service (§3.4, §18.3) that records deprecated-surface usage, dedupes per `(kind, id)` per process, publishes `deprecation-used` events, and answers lookups for `lando doctor` / `lando config` / docs build.
- **`deprecation-used` event** — Cross-cutting lifecycle event (§3.5, §18.4) published whenever a registered deprecated surface is used at runtime. Renderer subscribers emit `message.warn` once per unique `(kind, id)` per process.
- **Effect** — The TypeScript framework used for all runtime composition.
- **Embedding host** — A Bun program that imports `@lando/core` and constructs its own `LandoRuntimeLive` Layer instead of (or in addition to) invoking the `lando` binary. See §16.
- **End-to-end suite** — Test layer that drives the compiled `lando` binary against a real provider on a real OS (§13.1). Lives in `test/e2e/` with internal fixtures under `test/e2e/fixtures/`; user-facing scenarios are exercised through the canonical recipe scaffold flow. The e2e suite plus the executable-guides suite (§19) together replace the Lando 3 Leia format.
- **Executable guide** — An MDX file (under `docs/src/content/docs/{guides,tutorials,how-to}/**` or `recipes/<id>/README.mdx`) that is both an authored Lando guide and a source for runnable scenarios (§19). Prose is authored as prose; typed JSX components — `<Guide>`, `<Scenario>`, `<Step>`, `<Run>`, `<Verify>`, `<Inspect>`, `<Hidden>`, `<Cleanup>`, `<Variable>`, `<Skip>`, `<Inline>`, `<UseFixture>`, `<Tabs>`, `<Tab>` — define rendered reader scenarios and optional hidden test-only scenarios. `scripts/build-guide-scenarios.ts` compiles them into generated TypeScript scenario tests under `test/scenarios/generated/**` (gitignored, regenerated each run); the Starlight site renders only reader-scenario content and public transcript frames.
- **Executable-guides suite** — Test layer that runs every generated guide scenario through its declared `layer` (§19.11). Scenario-layer guide scenarios run against `TestRuntimeProvider` on every per-PR platform; e2e guide-scenario `@smoke` subsets run on Linux x64 per-PR; the full e2e guide-scenario set runs nightly. Failures map back to MDX or colocated case coordinates via the source-mapper reporter (§19.8). When a guide declares `tabs:` or `axes:`, the suite runs every Cartesian-product variant.
- **Tab axis** — A dimension of variation declared in an executable guide's `GuideFrontmatter` (§19.2, §19.16). An axis has a name (`version`, `package-manager`, `os`) and an ordered list of values (`drupal-10`/`drupal-11`, `composer`/`npm`, `linux`/`macos`). The Cartesian product of every declared axis's values is the variant set; `scripts/build-guide-scenarios.ts` emits one generated scenario test per variant, with the axis-value path encoded in the filename. Single-axis guides use the `tabs:` frontmatter sugar (implicit axis name `default`); multi-axis guides use `axes:`. The two are mutually exclusive.
- **Tab variant** — One cell of the Cartesian product produced by a guide's tab axes. A guide with `axes: { version: [a, b], package-manager: [c, d] }` has four variants: `a.c`, `a.d`, `b.c`, `b.d`. Each variant generates its own test file under `test/scenarios/generated/**`, its own `dist/transcripts/<guide-or-fixture-id>/<scenario-id>.<v1>.<v2>.json` transcript, and its own captured runtime state. The non-tabbed steps are byte-identical across every variant; only `<Tabs>`-wrapped content differs.
- **Endpoint** — A service listener (port, path, socket).
- **Host proxy** — Per-app container→host RPC channel exposed by `HostProxyService` (§10.10). A token-authenticated HTTP/JSON dispatcher binds a Unix socket at `<userDataRoot>/run/<app-id>/host-proxy.sock`, bind-mounted into `type: lando` services by the `lando.host-proxy` feature (§6.11). In-container shims (`xdg-open`, `open`, `lando`) call back to the host to open URLs in the user's real browser and to re-enter the host's `lando` command runtime. Lifetime is bound to `app:start` / `app:stop`; not the deferred persistent agent (§14.2).
- **Host-proxy allowlist** — Generated cache of canonical command ids that the in-container `lando` shim is permitted to forward via `HostProxyService.runLando` (§10.10, §12.1). Built from `LandoCommandSpec.hostProxyAllowed: true` (§8.3), per-plugin command flags, and per-app tooling tasks with `hostProxyAllowed: true` (§8.5). Lifecycle commands are forbidden from the allowlist by construction.
- **Entry point** — A documented `package.json#exports` path of `@lando/core` that hosts may import. The catalog is in §2.7; semver stability per §16.9.
- **Feature** — A composable, ordered, idempotent service-plan transformation.
- **File sync engine** — Pluggable abstraction (`FileSyncEngine`, §4.2, §10.6) responsible for realizing accelerated bind mounts when the active `RuntimeProvider` declares `bindMountPerformance: "slow"` (§5.4). Default engine is the no-op `passthrough`; the bundled default for slow-IO providers is `@lando/file-sync-mutagen` (§10.6.2). Engines hold sync-session lifetime through `Scope` and publish `pre-/post-file-sync-*` lifecycle events (§3.5).
- **File sync session** — One per accelerated `MountPlan` per started app. Created by `FileSyncEngine.createSession`, finalized at `app:stop` or `Effect.interrupt`. Identified by an engine-issued opaque `FileSyncSessionRef` plus a stable `mountKey` linking it back to the originating mount entry (§6.4). Recorded in the `file-sync-sessions` cache (§12.1) for fast `app:start` reconciliation.
- **`bindMountPerformance` capability** — `ProviderCapabilities` field declaring the provider's host↔guest filesystem-IO characteristics for `bind` mounts: `"native"` (Linux native runtime, OrbStack, WSL-resident projects), `"slow"` (Docker Desktop / Podman Desktop / Lima / Colima / Rancher Desktop), or `"none"` (the provider does not support bind at all). Drives mount-realization selection at plan time (§5.4, §6.4).
- **Mount realization** — A planner-set `realization: "passthrough" | "accelerated"` field on every `bind`-type `MountPlan` (§6.4). Derived deterministically from the active provider's `bindMountPerformance`. The user's Landofile is unchanged across both values.
- **Fragment** — A partial Landofile (`services:`, `tooling:`, `proxy:`, etc.) loaded by an enclosing Landofile through `includes:` (§7.7). Fragments are pure config — never code — and resolve from local paths, git, npm, or the registry.
- **Global app** — A reserved, host-level Lando app with id `global` rooted at `<userDataRoot>/global/` whose Landofile is plugin-contributed via `globalServices:` entries (§20). The canonical home for cross-cutting host services like the proxy and Mailpit. Started, stopped, and managed through the `meta:global:*` CLI namespace; auto-started by user-app `pre-start` when an `AppFeature` declares `requires.globalServices`.
- **`globalServices:` contribution surface** — Plugin manifest field (§4.2 row, §20.4) that contributes a service definition into the global app's generated `.lando.dist.yml` layer. Each entry declares `id`, `module`, `enabledByDefault`, `requires.providerCapabilities`, and optional `conflicts`.
- **`GlobalAppService`** — Core Effect service (§3.4, §20.5) that owns global Landofile management, `dist` regeneration from plugin contributions, plan derivation, and lifecycle. `Layer.suspend`-wrapped — costs nothing on commands that don't need it.
- **Imperative shell** — The outer layer of the architecture (§3.1) that runs Effect programs against the runtime. The CLI is one shell; an embedding host is another (§3.6).
- **Include** — An entry in a Landofile's `includes:` array referencing a fragment by source scheme (local path, git, npm, registry). See §7.7.
- **Layer** — Effect's mechanism for providing services with their dependencies and lifecycles.
- **Library API** — The public, semver-stable surface of `@lando/core` available to embedding hosts (§16.2).
- **Manifest** — Per-plugin declaration of contributions, requirements, and metadata.
- **Plan cache** — On-disk Effect-Schema-encoded `AppPlan` enabling fast hot-path commands.
- **Port** — An abstraction (Service tag + interface) that core depends on.
- **Provider** — Implementation of `RuntimeProvider`; realizes `AppPlan`s.
- **Recipe** — A Yeoman-style init-time scaffolding artifact (§8.8). A directory with a `recipe.yml` (Q&A prompts + file manifest + post-init actions), `templates/` (rendered files), optional `fragments/` (shipped alongside), and optional `assets/` (verbatim files). Recipes are consumed once by `lando apps init` and produce a fully-visible Landofile the user owns. The v3 `RecipeDefinition` plugin contract is removed in v4; recipes are no longer a runtime abstraction.
- **Recipe suite** — Test layer that scaffolds every canonical recipe under `recipes/` with default and varied answers and validates the produced Landofiles against the published schema (§13.1).
- **Renderer** — Plugin that renders task progress, tables, and messages to output.
- **Route** — A host-facing HTTP/TLS mapping to one or more endpoints.
- **Route filter** — A provider-neutral request/response transformation.
- **Scenario suite** — Test layer that drives the program through the public library API against `TestRuntimeProvider` (§13.1). Lives in `test/scenarios/`, uses no real container runtime, and runs in seconds on every per-PR platform.
- **Schema** — Effect Schema instance defining a runtime-validated type.
- **Scratch app** — A short-lived Lando app whose lifetime is bounded by an Effect `Scope` and whose state is purged at scope close (§21). Acquired through `apps:scratch:start` (`--fork` to copy a source app root, `--from <recipe-ref>` to render a recipe) or through `makeLandoRuntime({ scratch: ... })` in library mode. Discoverable only via `apps:scratch:*` and the registry; never via cwd walk.
- **Scratch id** — A scratch app's stable identifier. String of the form `scratch-<base>-<6-hex>` where `<base>` is derived from the source (source app slug, recipe id, or `--name`) and the 6-hex suffix guarantees uniqueness across concurrent starts. Lives in a separate identifier namespace from user-app slugs (§21.2); user apps named `scratch-foo` are legal.
- **`AppRef.kind`** — Discriminator on the `AppRef` schema (`"user" | "global" | "scratch"`) that splits the app identifier namespace across the three kinds. Consumers that switch on app identity MUST consider `kind` together with `id` (§11.2, §21.2).
- **`ScratchAppService`** — Core Effect service (§3.4, §21.5) that owns scratch-app acquisition, materialization, lifecycle, and the registry-plus-provider-label orphan-reap protocol. `Layer.suspend`-wrapped — costs nothing on commands that don't need it.
- **`ScratchHostnameSuffix` route filter** — Built-in `RouteFilter` (§6.6) applied unconditionally at plan time to every scratch app's `RoutePlan` (unless suppressed via `--no-hostname-suffix`); rewrites every hostname `<host>.<domain>` to `<host>--<scratch-id>.<domain>` so a fork-mode scratch's routes do not collide with the source app's (§21.9.2).
- **Scratch registry** — Single-file binary registry at `<userCacheRoot>/scratch/registry.bin` (§12.1, §21.11) recording every running scratch app on the host. Source-of-truth for `apps:scratch:list`; combined with a provider-label scan (`dev.lando.scratch: "TRUE"`) to drive `apps:scratch:gc`.
- **Scope** — Effect's resource-lifetime tracker; runs finalizers in LIFO on close/error/interrupt.
- **Service base** — `l337` (raw artifact) or `lando` (opinionated dev service).
- **Service feature** — See "Feature".
- **Service info** — Provider-neutral runtime metadata returned by `app info`.
- **Service plan** — A single service's contribution to an `AppPlan`.
- **Service type** — A plugin-provided resolver for `type: <name>` returning normalized config + features.
- **Subscriber** — A plugin event handler declared in manifest.
- **TaggedError** — An Effect Schema-defined error class with a discriminating `_tag`.
- **TestRuntime** — A pre-composed, in-memory `Layer` published from `@lando/core/testing` for use in `bun test` suites and embedding hosts (§16.8).
- **Tooling** — User-defined CLI commands materialized from `tooling:` Landofile entries. Tooling commands register under the `app:` namespace by default (§8.1.1, §8.5).
- **Transcript** — Structured capture of a scenario variant's runtime behavior — per-`<Run>` stdout, stderr, exit code, lifecycle event trace, and `<Inspect>` artifacts — written to `dist/transcripts/<id>.json` and consumed by the docs build to embed real captured output next to the rendered command (§19.6). Subject to a published redaction policy in `@lando/sdk/docs/redactions` covering secrets, time-based values, container ids, port allocations, and hostnames. Regenerated every test run; never committed.
- **ScenarioContext** — Effect service exposed from `@lando/core/testing` (§19.4, §16.8) that binds the per-test working directory, the active `LandoRuntime`, the declared `<Variable>` values, the lifecycle event stream, and the transcript writer for the duration of one scenario run. The only Effect requirement on the generated test program.
- **Tooling task** — A Taskfile-inspired execution node defined under `tooling:`. A tooling task may have commands, dependencies, expressions, status checks, and service/host execution metadata.
- **ToolingEngine** — Pluggable component that executes compiled tooling task graphs.
- **Top-level alias** — An optional bare command name registered for a canonical command (e.g., `lando start` for `app:start`). Top-level aliases are an ergonomics layer; they share the canonical command's identity, lifecycle event name, library function, and cache key. Configured per command via `topLevelAlias` and per user via global config `commandAliases:` (§8.1.2).

---

*End of SPEC.md*
