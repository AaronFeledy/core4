# Lando v4 — Appendices

> **Part 14 of 15** · [Index](./README.md)
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
- `!load` and `!import` support YAML, JSON, string, and binary forms.
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
- A Landofile `includes:` array (§7.7) loads local, git, and npm fragments, deep-merges them with file precedence rules, and writes an `.lando.lock.yml` recording resolved refs and checksums; `lando includes verify` succeeds without network access on a warm cache.
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
- Recipe `postInit.bunScript:` (§8.8.8) executes a recipe-bundled `.bun.sh` file through `ShellRunner.runScript()` after build-time-embedded checksum verification; the script's path MUST resolve inside the recipe's `templates/` or `assets/` tree; mismatched checksums fail with `BunScriptChecksumError`.
- `lando doctor` records every shell-shaped diagnostic and `--fix` step as a redacted transcript at `<userCacheRoot>/logs/doctor/<run-id>.transcript`; `lando doctor --transcript-only` prints the transcript to stdout without the rendered diagnostic UI (§10.9).
- `pre-shell-exec` / `post-shell-exec` lifecycle events (§3.5) publish for every `ShellRunner` invocation in core code paths (host ToolingEngine, `vars.sh:` evaluator, `.bun.sh` scripts, the `lando shell` REPL, recipe `bunScript:`, host-target healthcheck/scanner runners, doctor checks).
- The `scripts/release.ts` orchestrator (§17.1) and codegen scripts under `scripts/` use `Bun.$` directly for shell-shaped pipeline stages and `Bun.spawn` for argv-precise tool calls; production source under `core/src/` continues to route shell-shaped work through `ShellRunner` for redaction, lifecycle events, and pluggability.
- Events run around lifecycle and tooling commands, and events can call tooling tasks directly.
- CLI lifecycle events publish under the canonical command id (`cli-app:start-run`) regardless of which alias the user invoked.
- Routes support hostname, port, path, wildcard, and object forms.
- Route filters express request/response header manipulation without naming a proxy implementation.
- Cert generation supports disabled, generated, and custom cert/key forms.
- Service cert SANs include `localhost`, service name, internal hostname, configured hostnames, loopback IP.
- Host access works through `host.lando.internal` and `LANDO_HOST_IP` when capability allows.
- Healthchecks support disabled, string, script, array, object, user, retry, delay forms.
- SSH key loading supports disablement and allowlists; default uses sidecar agent.
- SQL helper plugins can expose import/export workflows for supported services.
- Mount excludes/includes are explicit on per-mount config.
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
- A `bun test` suite can construct an isolated Lando runtime via `@lando/core/testing`, run lifecycle assertions, and tear down deterministically.
- An embedding host can opt into bundled, system, user, and app-local plugin discovery independently; the default in library mode is none.
- Multiple `makeLandoRuntime` instances coexist in one process without shared caches or cross-instance event bleed.
- The library package and the compiled binary ship at the same version from the same source.

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
- **Effect** — The TypeScript framework used for all runtime composition.
- **Embedding host** — A Bun program that imports `@lando/core` and constructs its own `LandoRuntimeLive` Layer instead of (or in addition to) invoking the `lando` binary. See §16.
- **End-to-end suite** — Test layer that drives the compiled `lando` binary against a real provider on a real OS (§13.1). Lives in `test/e2e/` with internal fixtures under `test/e2e/fixtures/`; user-facing scenarios are exercised through the canonical recipe scaffold flow. Replaces the Lando 3 Leia format.
- **Endpoint** — A service listener (port, path, socket).
- **Entry point** — A documented `package.json#exports` path of `@lando/core` that hosts may import. The catalog is in §2.7; semver stability per §16.9.
- **Feature** — A composable, ordered, idempotent service-plan transformation.
- **Fragment** — A partial Landofile (`services:`, `tooling:`, `proxy:`, etc.) loaded by an enclosing Landofile through `includes:` (§7.7). Fragments are pure config — never code — and resolve from local paths, git, npm, or the registry.
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
- **Tooling task** — A Taskfile-inspired execution node defined under `tooling:`. A tooling task may have commands, dependencies, expressions, status checks, and service/host execution metadata.
- **ToolingEngine** — Pluggable component that executes compiled tooling task graphs.
- **Top-level alias** — An optional bare command name registered for a canonical command (e.g., `lando start` for `app:start`). Top-level aliases are an ergonomics layer; they share the canonical command's identity, lifecycle event name, library function, and cache key. Configured per command via `topLevelAlias` and per user via global config `commandAliases:` (§8.1.2).

---

*End of SPEC.md*
