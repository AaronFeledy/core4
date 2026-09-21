# Lando v4 — Mission, Tenets, and Non-Goals

> **Part 1 of 18** · [Index](./README.md)
> **Read next:** [02 Toolchain](./02-toolchain.md)

This part states the mission, non-negotiable tenets, core boundaries, default distribution, non-goals, and decisions remaining before GA.

§1 and §14 are paired because they define what Lando v4 is and is not.

---

## 1. Mission and Tenets

### 1.1 What Lando v4 is

Lando v4 is a declarative local-development toolchain. A committed Landofile produces an identical networked environment with one command. The user promise continues; the implementation is a hard reset.

1. **Provider-neutral.** Runtime providers are plugins; core has no Docker dependency.
2. **Bun-native.** Bun is the runtime, package manager, test runner, process and shell substrate, file layer, and bundler. `ProcessRunner` owns argv-precise work and `ShellRunner` owns shell-shaped work (§3.4, §4.2).
3. **Effect-driven.** Side effects, failures, resources, concurrency, logging, and dependencies flow through Effect.
4. **Plug-everything.** Replaceable capabilities live behind interfaces; implementations ship as plugins where §4 declares them pluggable.
5. **Hard reset.** v3 services, v3 service inheritance, v3 recipes, legacy raw passthrough shims, and Traefik labels are not part of core; core MUST NOT execute any Lando 3 code path. The bundled decode-only `@lando/lando3` translator runs only on explicit request, never during bootstrap or `start` (§7.4.1, §9.5).
6. **CLI-and-library.** The CLI and Bun embedding hosts are peer imperative shells over the same public Effect runtime, services, schemas, errors, plugins, and events (§16).
7. **Agent-native.** AI coding agents are a first-class operator alongside humans and scripts. **Context continuity:** when work crosses a boundary (host into container, one command into another), the context an agent depends on travels with it rather than being silently dropped, under explicit security-fenced policy. **Machine-legibility:** commands expose structured results, observable operations, and tagged failures with remediation rather than requiring prose scraping. When a choice would force an agent to parse human output or lose state at a boundary, prefer the legible, state-preserving approach.

### 1.2 Architectural tenets

These tenets are non-negotiable and reviewable on every PR.

| Tenet | Contract |
|---|---|
| **Functional core, imperative shell** | Business logic is pure Effect; filesystem, process, network, and terminal effects live behind services. CLI and library hosts are imperative shells. |
| **Type-driven design** | Effect Schema defines public contracts and TypeScript types are inferred from it. |
| **Tagged errors only** | Core failures are `Schema.TaggedError` values with machine `_tag` and actionable remediation, not thrown generic exceptions. |
| **Resource-safe by construction** | Handles, locks, files, ports, networks, and subprocesses are acquired in `Scope`; interruption cleans them up. |
| **Capability before plan, plan before action** | Providers declare capabilities; planning validates intent; providers execute only valid plans. |
| **Performance is a feature** | Published p95 end-to-end, first-paint, and hot-path budgets in §2.1 are release contracts; embedding hosts that reuse one `LandoRuntime` across sequential operations are held to the same hot-path budgets (§16.3). Streaming render, bytecode, generated bootstrap layers, lazy services, bounded caches, efficient event dispatch, concurrency, and runtime reuse remain mandatory where their owning sections specify them. Regressions are release-blocking. |
| **Hot path stays hot** | Tooling commands that do not need full app init MUST run from cached plans without provider contact. |
| **Disconnectable local dev** | Lando MAY use the network during install, setup, update, app-dependency materialization, and app build. After a successful app build, routine local-dev commands MUST run from local caches and artifacts unless the user's app or tooling explicitly needs the internet. |
| **Pluggable beats configurable** | Prefer interfaces and plugins for differing implementations; flags tune one implementation. |
| **Bun first, Node last** | Use Bun primitives; Node compatibility APIs require narrow adapters or plugin necessity. |
| **Native CLI dispatcher for UX, Effect for logic** | One native registry and dispatcher own argv, discovery, help, and source/compiled dispatch; command execution crosses into Effect. OCLIF is not a shipping engine (§8.4.1). |
| **Library-grade public API** | CLI-consumed services, Layers, schemas, errors, and events are versioned exports for embedding hosts. |
| **Agent-native dev environment** | Context continuity is explicit and security-fenced; user-facing surfaces MUST be structured and agent-drivable. A screen-scraping-only surface is a defect. |

### 1.3 Core boundaries

Core owns:

- Landofile and global-config discovery, merge, normalization, validation, schema publication, and environment overrides (§7).
- The provider-neutral authoring translation pipeline and managed writes, but no external-format translator implementation (§7.4.1, §12.4).
- Plugin discovery, validation, dependency resolution, and contribution registration (§9).
- The native command registry, routing, help/manifest generation, and CLI-to-Effect boundary (§8.4.1).
- Provider-neutral planning, app lifecycle orchestration, provider selection, subsystem contracts, and caches (§3–§12).
- The public embedding API, including runtime factories, services, schemas, errors, and event payloads (§16).
- Global-app identity, lifecycle, CLI, plugin enablement, and required-service integration; plugins own contributed services (§20).
- Scratch-app identity, scoped lifecycle, isolation transforms, registry, and orphan cleanup; plugins MAY contribute inputs, not scratch ownership (§21).
- The embedded Bun user surface, its allowed verbs, redaction, recursion, and host-proxy policy (§2.1, §8.2.4, §8.8.8, §10.10).
- The canonical service-type catalog and recipe set. Recipes MUST decompose into ordinary Landofile data with inert provenance (§6.12, §8.8).

Core does not own:

- Docker, Podman, Lima, OrbStack, Hyper-V, WSL, BuildKit, or other host-runtime integration.
- Traefik configuration, proxy labels, or proxy daemon lifecycle.
- mkcert, dockerode, dockerfile generators, Compose binaries, or provider-specific runtimes.
- v3 execution, resource adoption, state import, retired image emulation, hoster synchronization, or Lando 3 binary management.

Core and the bundled translator MUST NOT adopt v3 containers, volumes, networks, state, custom basename settings, images, helpers, environment, or execution order; MUST NOT perform hoster synchronization; and MUST NOT download or manage a Lando 3 binary. Explicit custom-name settings are diagnosed only.

### 1.4 Default distribution

Bundled plugins remain separate packages governed by the public plugin contract.

| Concern | Reference implementation | Runtime status |
|---|---|---|
| Managed runtime | `@lando/provider-lando` | Bundled default, optional |
| System Docker / Podman | `@lando/provider-docker`, `@lando/provider-podman` | Optional |
| Canonical v4 translation | `@lando/lando4` | Bundled, two-way, explicit-only; MUST depend only on `@lando/sdk` and MUST NOT participate in normal bootstrap |
| Lando 3 conversion | `@lando/lando3` | Bundled, decode-only, explicit-only; also contributes the read-only `lando3-leftovers` / `lando3-shadow` doctor checks (§10.9); MUST depend only on `@lando/sdk` and `@lando/paths` and MUST NOT participate in normal bootstrap |
| Proxy / CA | `@lando/proxy-traefik`, `@lando/ca-mkcert` | Optional |
| Service base | `@lando/service-lando` | Required for `type: lando` |
| Logger | Built-in Effect logger | Always available |
| Renderer | `@lando/renderer-lando` | Bundled default |
| Notifications | `@lando/notify-lando` | Bundled optional policy plugin |
| Whole-file templates | `@lando/template-handlebars`, `@lando/template-mustache` | Bundled optional |
| File sync | `@lando/file-sync-mutagen` | Bundled; selected for slow bind mounts |
| Global mail capture | `@lando/service-mailpit` | Bundled optional |

The built-in `providerExec` and `host` ToolingEngines and the `lando` expression/template engine are always available; plugin selection remains replaceable where §4 permits it.

The default managed provider MUST work without pre-existing Docker or Podman. After install/setup/materialization/build, routine local development MUST remain offline-capable; telemetry and update checks are best-effort.

| Form | Audience | Contract |
|---|---|---|
| **Single-binary CLI** | End users | Bytecode-enabled compiled `bin/lando.ts` through the mandatory §17.3 wrapper. |
| **Library package** | Bun embedding hosts and package-manager users | Version-matched ESM entry points; Alpha/Beta `package.json#bin` exposes `lando4` beside untouched Lando 3. |

The forms ship from the same source at the same version and MUST NOT drift.

---

## 14. Non-Goals and Open Decisions

### 14.1 Non-goals

- v3 execution/emulation, automatic conversion, resource adoption, legacy state import, retired image manufacture, hoster synchronization, or Lando 3 binary management.
- Docker Compose as core's runtime model; only the documented input subset is supported (§7.4).
- Required Traefik or Docker implementations.
- Built-in Kubernetes in v4.0.0, plugin sandboxing, registry push workflows, or core SQL helpers.
- File-sync engines beyond passthrough and bundled Mutagen in v4.0, or file-sync-owned TCP/UDP forwarding (§10.6).
- Copy-on-write scratch isolation, scratch fleets, fork-source hot reload, or scratch apps as expression sources (§21.15).

### 14.2 Open decisions

| Decision | Required resolution before GA |
|---|---|
| Bun version floor | Select the latest stable GA floor supporting bytecode for every §2.1 target. |
| Telemetry inventory and privacy | Finalize events, redaction, retention, and disablement controls. |
| Renderer wiring at the CLI boundary | Route command output through `Renderer`, add renderer config, and enforce the output boundary; GA-blocking. |

Resolved decisions remain: setup is explicit guided opt-in; direct host SSH-agent socket mounts are rejected; the schema-backed Compose subset is authoritative; OCLIF is removed from shipping dispatch; plugin trust ships explicit non-expiring list/revoke grants; source and compiled modes share one native dispatcher.

Deferred post-v4.0 capabilities MUST remain architecturally possible:

| Capability | Constraint |
|---|---|
| Persistent local agent | v4.0 remains transactional with no shared daemon/socket, but runtime, caches, and Scopes MUST permit future warm IPC ownership. No core code may assume one process per command in a way that prevents holding state across calls (e.g. argv stored in global `FiberRef`s, caches pinned to `process.pid`). The per-app `HostProxyService` worker (§10.10) is not this agent and MUST NOT be relied on as a long-lived runtime cache. |
| Explicit `dependsOn: ["global:<service>"]` | Add only if usage proves `AppFeature.requires.globalServices` plus explicit global start is insufficient. |
| Service-type `topLevelAlias` enforcement | Enforce when the 4.1 tooling schema lifts the current beta-wide rejection. |
