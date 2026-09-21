# Lando v4 — Scratch Apps

> **Part 19 of 19** · [Index](./README.md)
> **Read next:** *(end of spec)*

**Scratch apps** are short-lived Lando apps whose resources and materialized state are owned by an Effect `Scope`. They support isolated forks of existing apps, recipe-backed temporary stacks, and library-hosted test environments.

---

## 21. Scratch Apps

### 21.1 What scratch apps are

A scratch app:

- Has an identity disjoint from user and global apps (§21.2).
- Has a Lando-managed root at `<userCacheRoot>/scratch/<id>/`, populated from a source app or recipe.
- Uses the standard Landofile, planner, build, provider, router, and certificate contracts.
- Is owned by a `Scope` whose finalizer destroys containers, applicable volumes, routes, host-proxy state, transcripts, caches, and the materialized root.
- Is excluded from cwd discovery and is addressable only through `apps:scratch:*` or the library API.

A scratch app is not a Git worktree, a source-app extension, a persistent project, or a multi-instance fleet. Fork mode is a point-in-time copy; `apps:init` remains the path for permanent projects.

### 21.2 Identity

`AppRef.kind` discriminates `user`, `global`, and `scratch`. Cache keys, provider labels, environment, DNS, events, and persistent artifacts MUST use `(kind, id)` rather than id alone. Scratch ids occupy a separate namespace, so they do not reserve user-app slugs and do not use `AppIdReservedError` (§20.2).

| Field | Contract |
|---|---|
| `kind` | `scratch` |
| `id` | A validated, unique `scratch-<base>-<suffix>` identity derived from source or `--name`. The suffix is bounded and collision-resistant. |
| Root | `<userCacheRoot>/scratch/<id>/` with the materialized app under its managed root. |
| Provider labels | `dev.lando.scratch=TRUE` and `dev.lando.scratch-id=<id>` on every provisioned container, volume, and network, in addition to §6.5 labels. |
| Environment | `LANDO_PROJECT=<id>`, `LANDO_APP_NAME=<id>`, `LANDO_APP_KIND=scratch`; `LANDO_APP_KIND` applies to every app kind (§6.9). |
| DNS | `<service>.<id>.internal` |

Scratch ids MAY appear in user-facing output and are not secrets.

### 21.3 The scratch app root

Scratch state lives under `<userCacheRoot>/scratch/<id>/`, including the materialized root and the `scratch-app-plan`, `scratch-app-info`, and `scratch-build-results` caches (§12.1). Build transcripts live under the scratch branch of the standard build artifact root (§12.4).

The entire scratch tree MUST be excluded from cwd discovery and `cwd-app-map`. Scope finalization removes the root, caches, and transcripts after resource destruction. A crash may leave them behind; `apps:scratch:gc` reaps them (§21.11).

### 21.4 Scratch sources

`ScratchSource` is a tagged contract with exactly two v4.0 variants:

- `fork` identifies the resolved source app root, source app id, and copied Landofile layers.
- `from-recipe` identifies a standard `RecipeRef` and resolved answers (§8.8.4).

#### 21.4.1 Fork mode

`apps:scratch:start --fork [--source <path>]` copies the resolved source app root; without `--source`, standard cwd discovery applies (§7.1).

- Materialization is a content copy, not a hardlink or CoW overlay; CoW is deferred (§21.15).
- `--exclude` and `scratch.fork.excludes:` add bounded ignore patterns. Generated and dependency-heavy paths are excluded by default.
- All included Landofile layers and the lockfile are copied; merge and include resolution then run against the scratch root.
- The resolved app name is rewritten to the scratch id.
- Local and user overrides are copied unless `--no-local-overrides` is set.
- Materialization is atomic. Failure removes the partial root and raises `ScratchMaterializeError`; provider actions MUST NOT begin first.

#### 21.4.2 Scratch mode

`apps:scratch:start --from <recipe-ref>` materializes through the standard recipe pipeline (§8.8). Recipe `postInit:` actions MUST NOT run unless `--run-post-init` is set.

Recipe resolution, prompt precedence, validation, fragments, and assets follow §8.8. Missing non-interactive answers fail through the recipe error contract and remove partial state. The generated Landofile uses the scratch id. Scratch mode defaults to `baked` isolation (§21.7).

### 21.5 `ScratchAppService` core service

`ScratchAppService` owns scope-bound acquisition, lookup, listing, lifecycle operations, and garbage collection. `ScratchAcquireInput` names the source, isolation mode, optional cwd mount, global-storage policy, name, recipe answers, copy excludes, and foreground or detached lifetime. `ScratchHandle` carries the scratch `AppRef`, plan, source, isolation mode, and creation time.

Required behavior:

- The service belongs to the `scratch` bootstrap level and is lazy when included by higher levels.
- `acquire` binds the root, caches, host-proxy socket, routes, containers, and volumes to the caller's `Scope`. Finalization MUST destroy resources before unlinking state.
- CLI foreground acquisition uses the command scope so interruption reaches finalization.
- Destroy is idempotent after success; an unresolved id raises `ScratchUnknownIdError`.
- Operations for one id are serialized across callers and processes through the canonical state and locking contracts (§12.7).
- Failures are tagged as listed in §21.14.

The service reuses the standard Landofile, planner, build, routing, certificate, and provider services.

### 21.6 Lifecycle

#### 21.6.1 The `scratch` bootstrap level

`scratch` sits between `provider` and `app`, parallel to `global`, in the §3.2 ladder. It eagerly adds `ScratchAppService` and lazily adds arbitrary-root Landofile loading, planning, build, and required global-service access. It MUST NOT eagerly construct `GlobalAppService`.

`bootstrap: scratch` is a valid `LandoCommandSpec` value. Plugins MAY use it in their own namespaces; `apps:scratch:*` remains reserved for core. Library hosts MAY request it through `makeLandoRuntime({ bootstrapLevel: "scratch" })`.

#### 21.6.2 Lifecycle event scope

The `Scratch` scope extends §3.5 with every event below:

| Operation | Events |
|---|---|
| Acquire | `pre-scratch-acquire`, `post-scratch-acquire` |
| Materialize | `pre-scratch-materialize`, `post-scratch-materialize` |
| Start | `pre-scratch-start`, `post-scratch-start` |
| Stop | `pre-scratch-stop`, `post-scratch-stop` |
| Destroy | `pre-scratch-destroy`, `post-scratch-destroy` |
| Garbage collection | `pre-scratch-gc`, `post-scratch-gc` |

Payloads carry the scratch `AppRef`, source, plan where applicable, isolation and global-storage policy, detached state, trigger or destroy reason, retained artifacts, and timestamp. Standard App-scope events still fire inside Scratch-scope events with `app.kind === "scratch"`.

#### 21.6.3 Standard event sequence

Acquisition wraps materialization and start; scratch start wraps the standard App lifecycle and any required global-service start (§20.6.3). Scope close emits scratch destroy around standard stop and destroy. `apps:poweroff` destroys scratch apps before stopping the global app. `--keep-scratch` suppresses every scratch destroy block and composes with `--keep-global`.

### 21.7 Mount isolation: the `--isolate` knob

`--isolate=full|baked|cwd` defines access to host files.

| Mode | `appMount` and relative mounts | Absolute mounts |
|---|---|---|
| `full` | Resolve against the copied scratch root. Default for fork mode. | Pass through unchanged. |
| `baked` | Suppressed. Default for recipe mode. | Pass through unchanged. |
| `cwd` | Resolve against the cwd captured at start. | Pass through unchanged. |

`--mount-cwd` is sugar for `--isolate=cwd`; in fork mode it MUST warn that it overrides the safer `full` default. Combining it with an explicit incompatible isolation mode fails with `ScratchIsolationConflictError`. `--isolate=passthrough` is reserved and unsupported in v4.0, raising `ScratchIsolationUnsupportedError`. Copy exclusions apply only to fork materialization.

### 21.8 Storage shadowing

At plan time, scratch storage obeys this rewrite:

| Written scope | Effective scope | Destroy behavior |
|---|---|---|
| `service` | `service` | Removed. |
| `app` | `app` | Removed. |
| `global` | `app` by default | Removed. |
| `global` with `--share-global-storage` | `global` | Preserved under §6.5. |

The `scope: global` to `scope: app` rewrite is mandatory unless `--share-global-storage` is explicitly set. It MUST NOT be inferred from another flag. Scratch volumes carry the scratch labels and standard storage ownership labels using the effective scope.

### 21.9 Networking and discovery

#### 21.9.1 DNS

`<service>.<scratch-id>.internal` is the canonical internal address. Providers with `sharedCrossAppNetwork` MAY expose that address from user apps, but committed config SHOULD NOT depend on a transient scratch app (§5.4, §10.1).

#### 21.9.2 Route auto-suffix

`ScratchHostnameSuffix` is the plan-time `RoutePlan` filter for scratch routes (§6.6). Unless overridden, it rewrites each route hostname with the scratch id before the domain, including nested and wildcard hostnames. The filter MUST be idempotent.

`--no-hostname-suffix` disables the filter. Repeated `--hostname` values preserve selected hostnames and MAY deliberately collide with another app.

#### 21.9.3 Exclusion from cross-app scopes

Scratch `AppFeature` code may consume permitted `globalServices.<name>.*` expressions (§20.8.3). User apps MUST NOT reference `scratchApps.<id>.*`; scratch apps are not cross-app expression sources in v4.0.

### 21.10 CLI surface (`apps:scratch:*`)

| Canonical id | Alias | Contract |
|---|---|---|
| `apps:scratch:start` | `scratch:start`, `scratch` | Acquire from exactly one of `--fork` or `--from`; foreground by default, detached with `--detach`. |
| `apps:scratch:stop` | `scratch:stop` | Stop and destroy the selected scratch or the current foreground scratch. |
| `apps:scratch:destroy` | `scratch:destroy` | Force resource destruction; `--keep-volumes` retains volumes for inspection. |
| `apps:scratch:list` | `scratch:list` | List registry entries and provider-label orphans; JSON is the canonical machine form. |
| `apps:scratch:info` | `scratch:info` | Report runtime info with service and format selection. |
| `apps:scratch:logs` | `scratch:logs` | Stream logs with standard service, follow, tail, and since filters. |
| `apps:scratch:run` | `scratch:run`, `run` | Run one command in a scope-bound toolbox scratch (§21.10.3). |
| `apps:scratch:gc` | `scratch:gc` | Report orphans; `--prune` reaps them. |

Every command uses `scratch` bootstrap. `apps:list --include-scratch` adds running scratches; `apps:list --all` includes all app kinds. `apps:poweroff` destroys scratches by default; `--keep-scratch` opts out and composes with `--keep-global`.

#### 21.10.1 `apps:scratch:start` flags

Behavior-defining flags are `--fork`, `--from`, `--source`, `--isolate=full|baked|cwd`, `--mount-cwd`, `--share-global-storage`, `--no-hostname-suffix`, `--hostname`, `--name`, `--exclude`, `--no-local-overrides`, recipe-answer and interaction flags, `--run-post-init`, `--detach`, `--keep-volumes`, and `--keep-on-failure`.

Foreground mode owns the scratch in the command scope and blocks until exit or interruption. Detached mode records the identity, source, isolation, policy, owner, and start state in `<userCacheRoot>/scratch/registry.bin` and returns. `--keep-volumes` applies to foreground and explicit stop cleanup but MUST NOT prevent `apps:poweroff` cleanup. `--keep-on-failure` retains failed state for explicit inspection and destruction.

#### 21.10.2 Top-level alias reservation

The `scratch:` prefix, bare `scratch`, and bare `run` are reserved under §8.1.2. Conflicting plugin or tooling aliases raise `CommandAliasConflictError`. User alias overrides MAY remap them; canonical `apps:scratch:*` ids remain callable.

#### 21.10.3 `apps:scratch:run` and the disposable tool runner

`apps:scratch:run` is a thin `ScratchAppService.acquire` surface, not a separate lifecycle. It defaults to the bundled `toolbox` recipe, cwd isolation, and the primary service. `--from`, `--service`, and `--no-mount` select another recipe, target, or baked isolation.

Arguments after `--` pass verbatim to provider exec. TTY and agent-context forwarding follow §6.9.1; output streams through the renderer; the tool exit code becomes the command exit code and is not a tagged Lando failure. Scope close destroys the scratch on success, failure, or interruption. `--keep` converts it to a detached scratch. JSON mode uses the streaming contract in §8.11.3. Warm pooling is deferred (§21.15).

### 21.11 Cleanup, registry, and orphan reaping

The `scratch-registry` at `<userCacheRoot>/scratch/registry.bin` (§12.1) is the active-process source of truth. Entries identify the scratch, source, isolation, global-storage policy, detached and owner state, managed paths, lifecycle status, and timestamps. Acquisition records state before provider operations, marks running after start, and removes the entry after destroy. Failed finalization leaves a cleanup-pending entry.

Registry updates MUST use the canonical atomic, lockable `StateStore` contract (§12.7). `apps:scratch:gc` combines two authorities:

1. Registry entries whose recorded owner is no longer alive are candidates.
2. Provider resources labeled `dev.lando.scratch=TRUE` whose scratch id is absent from the registry are candidates.
3. Without `--prune`, GC reports candidates and exits successfully. With `--prune`, it destroys each id and removes managed host state.

The registry walk MUST NOT replace the provider-label scan, and the provider-label scan MUST NOT replace the registry walk. The combined protocol recovers both lost registry entries and host-only artifacts. The JSON report is the canonical machine shape and GC is safe for unattended use.

### 21.12 Library mode

`makeLandoRuntime({ scratch })` is the library-mode acquisition form (§16.3). Supplying `scratch` acquires the app in the runtime `Scope`; finalization destroys it. Omitting the option preserves the non-scratch runtime contract.

`runtime.scratch(input)` exposes manual acquisition through `ScratchAppService`. Hosts creating successive scratches SHOULD reuse one runtime. The §13.1 library contract suite MUST verify that repeated acquisitions do not accumulate per-acquisition overhead.

### 21.14 Errors

Every error is tagged and includes remediation:

- `ScratchAppError`, the umbrella for state-transition failures
- `ScratchMaterializeError`
- `ScratchSourceUnresolvedError`
- `ScratchUnknownIdError`
- `ScratchIsolationConflictError`
- `ScratchIsolationUnsupportedError`
- `ScratchRecipeAnswersError`
- `ScratchRegistryCorruptError`
- `ScratchRunTargetError`

`ScratchRecipeAnswersError` wraps `RecipeMissingAnswerError` or `RecipeOutputValidationError` with scratch identity. This surface also uses the shared `CommandAliasConflictError` tag (§8.1.2). Materialization failures remove partial roots. Corrupt registries are quarantined and recovery invokes label-driven GC. Finalizer failures are logged even when cleanup remains best-effort.

### 21.15 Non-goals

- CoW, overlay, and passthrough isolation are deferred pending a provider capability and cross-platform contract.
- Scratch fleets are not a v4.0 primitive; callers may compose independent detached acquisitions.
- Fork mode has no hot reload from source changes.
- Scratch apps are not cross-app expression sources.
- `<userCacheRoot>/scratch/` is not independently relocatable in v4.0.
- The persistent agent remains deferred and does not change scratch lifetime (§14.2).
- `apps:scratch:run` has no warm toolbox pool; `--keep` or a normal app provides persistence.
- Plugins MUST NOT acquire scratches during install. They MAY contribute recipes or `globalServices:` that user-initiated scratches consume.
