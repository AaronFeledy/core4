# Lando v4 — Mission, Tenets, and Non-Goals

> **Part 1 of 16** · [Index](./README.md)
> **Read next:** [02 Toolchain](./02-toolchain.md)

This part captures the *why* of Lando v4. It states the mission, the non-negotiable architectural tenets that every PR is reviewed against, the explicit core boundaries (what core owns and what it does not), the default plugin distribution, the explicit non-goals, and the open decisions that remain before GA.

§1 (Mission and Tenets) and §14 (Non-Goals and Open Decisions) are paired here because they answer the same question from opposite sides: what we *are* building, and what we are *not*. Read both before working anywhere else in the spec.

---

## 1. Mission and Tenets

### 1.1 What Lando v4 is

Lando v4 is a declarative local-development toolchain. A team commits a Landofile to its repo and any developer can produce an identical, networked environment with one command. The user-facing promise is unchanged from prior versions; the implementation is rewritten from scratch.

v4 differs from prior versions on six fundamental axes:

1. **Provider-neutral.** Docker, Podman, Lima, OrbStack, remote runtimes, and lightweight VMs are *runtime providers* implemented by plugins. Core knows nothing about Docker by default.
2. **Bun-native.** Bun is the runtime, package manager, test runner, subprocess driver (`Bun.spawn`), shell substrate (`Bun.$` / Bun Shell), file IO layer, and bundler. The two host-execution primitives are deliberately complementary: `Bun.spawn` is exposed through the `ProcessRunner` service for argv-precise calls, `Bun.$` is exposed through the `ShellRunner` service for shell-shaped pipelines that must work identically on Linux, macOS, and Windows (§3.4, §4.2).
3. **Effect-driven.** All side effects, errors, resources, concurrency, logging, and dependencies flow through Effect.
4. **Plug-everything.** Every meaningful capability — containerization, tooling execution, logging, output rendering, certificates, proxy, schema validation, plugin sources, even the CLI parser — lives behind an interface and ships as a replaceable plugin.
5. **Hard reset.** v3 services, v3 service inheritance, v3 recipes, legacy raw passthrough shims, and Traefik labels are not part of core. Plugins may offer v3 affordances through the config-translation surface (§7.4.1/§9.5); core does not.
6. **CLI-and-library.** The `lando` binary is one imperative shell; a Bun-based program that imports `@lando/core` is another. The runtime, every Effect service, every schema, and every tagged error is part of a stable, versioned public API. Anything the CLI can do, an embedding host can do — using the same Effect runtime, the same `LandoRuntimeLive` Layer, the same plugins, and the same lifecycle events. See §16 ([09 Embedding and Library Use](./09-embedding.md)).

### 1.2 Architectural tenets

These tenets are non-negotiable. Every PR is reviewed against them.

| Tenet | What it means in practice |
|---|---|
| **Functional core, imperative shell** | Business logic is pure Effect. Side effects (filesystem, processes, networking, terminal) live behind services. The CLI is the only imperative shell. |
| **Type-driven design** | Public API is defined by Effect Schema. TS types are *inferred* from schemas, not declared separately. Drift is impossible. |
| **Tagged errors only** | No thrown exceptions in core. All failures are `Schema.TaggedError` instances with machine-readable `_tag` and human-readable remediation. |
| **Resource-safe by construction** | Anything that opens a handle, lock, file, port, network, or subprocess is acquired in a `Scope`. Cancellation cleans up automatically. |
| **Capability before plan, plan before action** | Providers declare capabilities. The planner validates capabilities against the desired state. Only then does the provider execute. |
| **Performance is a feature** | Every command meets a published end-to-end budget at p95 (§2.1) on the reference runner spec (§17.8). **Perceived performance is part of the contract**, not a polish item: first paint — a banner, action verb, or first table row — lands within 50 ms cold for any command at level ≥ `plugins` (§8.9.1); renderers stream rather than buffer for TTY output; spinners appear within 100 ms of any operation expected to exceed 200 ms. The perf-budget test suite (§13.1) gates merges. A measurable startup regression is a release-blocking bug. **Embedding hosts (§16) are held to the same hot-path budgets** when they reuse a single `LandoRuntime` across sequential operations (§16.3 "Runtime reuse for performance"); a host that constructs a fresh runtime per operation pays cold-start every time and is correctness-equivalent but performance-irresponsible. The mechanisms that make all of this achievable — `--bytecode` (§2.1), AOT-composed bootstrap layers (§2.4, §17.2), the level-`none` pre-OCLIF fast path (§3.2), binary-encoded hot-path caches (§12.2), the `cwd-app-map` cache (§12.1), `Layer.suspend` for non-critical services (§2.4), pre-sorted subscriber lists with zero-subscriber short-circuits (§11.1), intra-level concurrency (§3.2), fire-and-forget telemetry (§2.4), and library-mode runtime reuse (§16.3) — are themselves non-negotiable and reviewable per their respective sections. |
| **Hot path stays hot** | Tooling commands that don't need full app init must run from cached plans without provider contact. |
| **Disconnectable local dev** | Lando may use the network during install, setup, update, app-dependency materialization, and app build. After a successful app build, routine local-dev commands must run from local caches/artifacts unless the user's app or tooling explicitly needs the internet. |
| **Pluggable beats configurable** | Where two implementations might differ, prefer an interface + plugin over a flag. Reserve flags for behavior tuning of a single implementation. |
| **Bun first, Node last** | Use Bun primitives everywhere. Node-compat APIs are allowed only behind narrow adapters when Bun lacks a primitive or a plugin requires it. |
| **OCLIF for UX, Effect for logic** | OCLIF parses, discovers commands, renders help, and packs the binary. The moment a command's `run()` is invoked, control crosses into Effect and never goes back. |
| **Library-grade public API** | Effect service tags, Layers, schemas, and tagged errors that the CLI consumes are also a versioned, exported, semver-stable surface for embedding hosts. The CLI is one consumer, not the privileged one. |

### 1.3 Core boundaries

Core owns:

- Landofile discovery, parsing, merging, validation, and schema publication.
- Supported Compose-subset Landofile input parsing and normalization before provider planning.
- Global config loading and environment-variable overrides.
- The config-translation pipeline: plugin registration, detection orchestration, preview, validation, and atomic application of generated Landofile fragments. Core does not own any external format-specific translator.
- Plugin discovery, manifest validation, dependency resolution, and contribution registration.
- OCLIF command registration, command routing, and OCLIF↔Effect adaptation.
- v4 service planning and app lifecycle orchestration.
- Runtime Provider API contracts and provider selection.
- Provider-neutral subsystem contracts: tooling engine, proxy, certs, SSH, healthcheck, scanner, networking intent.
- Cache management for commands, plans, plugin metadata, and service info.
- The **public programmatic API** for embedding hosts: the `LandoRuntime` factory, the exported service tags, schemas, tagged errors, and lifecycle event payloads. Versioning and stability of this surface are owned by core (§16 Embedding, §13 Distribution).

Core does not own:

- Docker daemon access, Docker Desktop integration, or BuildKit configuration.
- Podman, Lima, OrbStack, Hyper-V, WSL integration, or any other host runtime.
- Traefik configuration, proxy container labels, or proxy daemon lifecycle.
- v3 services, v3 inheritance, v3 migration shims, v3 recipe compatibility, or v3 fixture compatibility. An external plugin MAY translate v3 config into v4 Landofile fragments, but that plugin is outside the core rewrite.
- mkcert, dockerode, dockerfile-generator, docker-compose binaries, or any provider-specific runtime.

Core *does* own — and ships in the binary — the comprehensive service-type catalog (PHP, Node, Python, Ruby, Go runtimes; common databases, caches, search engines, mail capture, queues, static servers; see §6.12) and the canonical recipe set (Yeoman-style scaffolds for common stacks; see §8.8.10). The v3 model where each stack lived in its own `@lando/recipe-*` plugin is removed: stack starters are no longer code, they are init-time scaffolds.

### 1.4 Default distribution

Core ships installable plugins that make the default `lando` install useful. Bundling does not move a plugin into core; bundled plugins live in their own packages and follow the public plugin contract.

Reference bundle (subject to change in §14):

| Concern | Reference plugin | Required at runtime? |
|---|---|---|
| Default runtime | `@lando/provider-lando` | Optional (bundled by default) |
| System Docker provider | `@lando/provider-docker` | Optional |
| System Podman provider | `@lando/provider-podman` | Optional |
| Proxy | `@lando/proxy-traefik` | Optional |
| CA / certs | `@lando/ca-mkcert` | Optional |
| Service base | `@lando/service-lando` | Required for `type: lando` |
| Logger | `@lando/logger-pretty` | Optional (Effect default `Logger.pretty` is built in) |
| Renderer | `@lando/renderer-listr` | Optional |
| Template engine (Handlebars) | `@lando/template-handlebars` | Optional (bundled by default; configured with `noEscape: true` and `strict: true`; §7.3.2) |
| Template engine (Mustache) | `@lando/template-mustache` | Optional (bundled by default; logic-less; §7.3.2) |

Two `ToolingEngine`s ship **built into core**, not as plugins, and are always available: the default `providerExec` engine (in-service exec via the active `RuntimeProvider`) and the `host` engine (`ShellRunner` / `Bun.$`-backed; powers `service: :host` tooling, `.bun.sh` scripts, `vars.<name>.sh:`, the `lando shell` REPL, recipe `bunScript:` post-init, and host-target healthchecks/scanners). They do not appear in the table above because they are not replaceable via plugin install in v4.0; both selection precedence and engine override remain plugin-replaceable per §4.2 and §8.6.

The default **template engine** (`lando`) also ships built into core, not as a plugin. It implements the §7.3.1 expression language and is the only engine permitted for Landofile string-value interpolation. The `@lando/template-handlebars` and `@lando/template-mustache` plugins above are bundled for whole-file rendering of users' existing `.hbs` and `.mustache` templates; both follow the standard `TemplateEngine` plugin surface (§7.3.2, §9.5) and can be disabled or replaced like any other plugin.

A user with the default bundle gets a working `lando setup` that downloads and configures the Lando-managed runtime without requiring any pre-existing Docker or Podman installation. Users who prefer a system runtime may install `@lando/provider-docker` or `@lando/provider-podman` and opt in explicitly.

The default user experience is **disconnectable local development**. A user may need internet access to install Lando, run `lando setup`, resolve app-declared plugins/includes/recipes, pull provider artifacts, or let the app download its own dependencies during the first successful `lando start`/`lando rebuild`. Once that app is built and its Lando-managed dependencies are cached and locked, `lando start`, `stop`, `restart`, `info`, `logs`, and ordinary tooling commands MUST NOT require network access unless the project itself invokes network-dependent commands or references missing remote artifacts. Telemetry and update checks are best-effort and never make a local-dev command fail solely because the host is offline.

Lando v4 ships in two distribution forms (see §13.5 for the artifact catalog and §17 for the operational pipeline that produces them):

| Form | Audience | Built from |
|---|---|---|
| **Single-binary CLI** | End users | `bun build --compile` of `bin/lando.ts` |
| **Library package** | Bun programs that embed Lando, plus end users who prefer a package-manager install | Standard `@lando/core` publish with multiple ESM entry points; `package.json#bin` exposes `lando` on PATH for `bun add -g @lando/core` users |

The two forms are produced from the same source and pinned to the same version; they are never out of sync.

---

## 14. Non-Goals and Open Decisions

### 14.1 Non-goals

- v3 service compatibility in core.
- v3 Landofile migration behavior in core (a config translator plugin may exist outside core).
- Docker Compose as core's internal runtime model or as a required provider implementation. Landofile input supports the documented Compose subset (§7.4).
- Traefik as a required proxy implementation.
- Docker as a required runtime provider.
- Kubernetes as a built-in provider in v4.0.0.
- Plugin sandboxing.
- Built-in image/artifact registry push workflows.
- Built-in SQL helper commands in core.

### 14.2 Open decisions

These remain unresolved at the time of this draft and should be addressed before v4.0.0 GA:

| Decision | Options |
|---|---|
| Bun version floor | Latest stable at GA that supports `--bytecode` for every cross-compile target listed in §2.1. Documented minimum (`>=1.2`?). |
| OCLIF major version | OCLIF v4 (current) or wait for v5? |
| How much provider setup is automatic | Aggressive auto-setup vs. guided opt-in |
| Telemetry data inventory and privacy controls | Telemetry is core and enabled by default; finalize event inventory, redaction, retention, and disablement controls |
| Exact Compose compatibility subset | Support common Compose features and every Compose feature Lando uses internally; document the accepted key matrix and reject unsupported keys with remediation |
| Whether `sshAgent.sidecar: false` opt-out is permitted | Sidecar is the v4.0 **default** (decided, see §10.4). The remaining choice is whether a `sshAgent.sidecar: false` opt-out reverts to the v3-era direct-mount behavior or is rejected at GA. |

**Deferred to post-v4.0 (architecture must not preclude these):**

| Deferred capability | Notes |
|---|---|
| **Persistent local agent** (`lando agent`) | A user-level (or per-app) background process holding a warm Effect runtime, parsed Landofiles, and the plugin contribution graph; CLI invocations become thin IPC clients. Brings hot-path latency from ~150 ms to ~10 ms. **In v4.0 Lando is transactional** — no daemon ships in the binary, no IPC server is built, no socket is created. The architecture preserves the option: the AOT bootstrap layers (§17.2), the binary cache encoding (§12.2), the `Scope`-based resource model, and the `makeLandoRuntime` factory (§16.3) are all daemon-friendly. The motivating downstream consumers are a future TUI control surface and a VSCode extension that wants to share runtime state across many small operations; both want sub-50 ms response that a transactional binary cannot reach. The post-v4.0 design must address daemon lifecycle, socket auth (per-app uid + path containment is the leading model), state-drift on Landofile/config change, multi-tab concurrency, and graceful upgrade. Until that design lands, no core code may assume "one process per command" in a way that prevents holding state across calls (e.g., FiberRefs that store argv globally, caches pinned to `process.pid`). |
