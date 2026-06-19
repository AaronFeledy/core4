# Lando v4 — Scratch Apps

> **Part 19 of 19** · [Index](./README.md)
> **Read next:** *(end of spec)*

This part defines **scratch apps**: short-lived Lando apps whose lifetime is bounded by a `Scope` and whose state — containers, volumes, materialized app root, transcripts, host-proxy socket — is purged when that scope closes. Scratch apps exist to support two user workflows that the user-app model cannot serve cleanly:

1. **Fork mode (worktree-style).** A user has a Landofile in cwd and wants a sibling instance to test a theory or work on a parallel task without affecting the source app or the files mounted into it.
2. **Scratch mode (rootless).** A user wants a quick stack — `lamp`, `lemp`, `node-api`, `empty` — to test something without committing to a project on disk.

§21 (Scratch Apps) is filed as a single part because every facet of the concept is novel to v4: a separate identifier namespace from user apps, a Lando-managed app root, a new core service, a new bootstrap level, a new lifecycle event scope, a new CLI namespace, and a new pluggability axis through which embedding hosts and tests acquire isolated runtimes. Reading the part top-to-bottom is the fastest way to understand how the "ephemeral instance" idea differs from a normal `apps:init` + `app:start` flow.

The motivating user-facing examples:

- A developer working in a Drupal project runs `lando scratch start --fork --isolate=full` and gets a sibling instance whose containers, volumes, and `<service>.<id>.internal` DNS aliases are independent of the source. Edits made inside the scratch app's services do not touch the source app's files. `Ctrl+C` ends the foreground scratch and tears every resource down.
- A developer wants to try a query against a fresh MariaDB. `lando scratch start --from lamp` materializes the canonical `lamp` recipe (§8.8.10) into a temp app root under `<userCacheRoot>/scratch/<id>/`, starts the stack, and gives the developer a shell inside the `appserver`. `Ctrl+C` (or `lando scratch stop`) destroys the stack and removes the temp root.
- A test harness inside an embedding host wraps a suite in `Effect.scoped` against `makeLandoRuntime({ scratch: { kind: "from-recipe", recipe: "lamp" } })`. The runtime acquires a scratch app at suite start, runs assertions against it, and the scope finalizer destroys every resource at suite end. No `afterAll` cleanup hook to maintain.

---

## 21. Scratch Apps

### 21.1 What scratch apps are

A **scratch app** is a Lando app that:

- Has a synthesized identity disjoint from any user app's identity (§21.2).
- Has a Lando-managed root under `<userCacheRoot>/scratch/<scratch-id>/` populated either by copying a source app root (fork mode) or by rendering a recipe (scratch mode) (§21.3, §21.4).
- Goes through the same `LandofileService`, `AppPlanner`, `BuildOrchestrator`, `RuntimeProvider`, `ProxyService`, and `CertificateAuthority` user apps go through; only the identity and the lifetime contract differ.
- Has its lifetime bound to an Effect `Scope` whose finalizer destroys every resource: containers, volumes (per the §21.8 storage rules), proxy routes, host-proxy socket, build transcripts, the materialized root.
- Is invisible to cwd-based app discovery (§7.1) and to the `cwd-app-map` cache (§12.1); only `apps:scratch:*` commands and the library API resolve to it.

What a scratch app is **not**:

- Not a worktree of the source's git history. Fork mode copies the *resolved app root at start time*; it does not track the source's working tree afterward. Edits inside the scratch are isolated; edits in the source after start are not propagated.
- Not a multi-instance orchestrator. Each scratch start creates exactly one independent app. There is no "scratch fleet" primitive in v4.0 (§21.15).
- Not a runtime extension of the source app. The source app's containers, volumes, and proxy routes are entirely untouched by any scratch operation that derives from it.
- Not a replacement for `apps:init`. A scratch app produces no committed artifacts. Users who want a permanent project run `apps:init` instead.

### 21.2 Identity

User apps and scratch apps live in **separate identifier namespaces**. The `AppRef` schema published from `@lando/sdk` carries a `kind` discriminator:

```ts
export const AppRef = Schema.Struct({
  kind: Schema.Literal("user", "global", "scratch"),
  id:   Schema.String,                                  // user slug, "global", or scratch id
  root: AbsolutePath,                                   // user app root, global app root, or scratch root
});
export type AppRef = Schema.Schema.Type<typeof AppRef>;
```

Lookups across caches, provider labels, env, and DNS key by `(kind, id)` rather than by `id` alone. A user app whose slug normalizes to a string that *also* appears as a scratch id is legal — the two coexist in different cache subtrees, different provider label keys, and different DNS suffixes. There is no reserved slug prefix and no parse-time rejection like the global app's `AppIdReservedError` (§20.2).

| Field | Value | Notes |
|---|---|---|
| `kind` | `"scratch"` | Discriminator on `AppRef`. |
| `id` | `scratch-<base>-<6-hex>` | `<base>` is derived from the source: the source app's slug for fork mode, the recipe id for scratch mode, or the user-supplied `--name`. The 6-hex suffix is a content hash over `(source identity, scope acquisition time, host pid)` and ensures uniqueness across concurrent starts. The `scratch-` prefix is human-readable scaffolding; it is not a reservation. |
| `root` | `<userCacheRoot>/scratch/<id>/root/` | The materialized app root. Created by `ScratchAppService` at start; removed at scope finalization. |
| Provider labels | `dev.lando.scratch: "TRUE"` plus `dev.lando.scratch-id: <id>` | Added to every container, volume, and network the scratch app provisions. The standard `dev.lando.storage-project`, `dev.lando.storage-service` labels (§6.5) are populated using the scratch id as `<project>`; the additional `scratch:`/`scratch-id:` pair is the deterministic key `apps:scratch:gc` uses to find orphans without consulting the registry. |
| Env | `LANDO_PROJECT=<id>`, `LANDO_APP_NAME=<id>`, `LANDO_APP_KIND=scratch` | The new `LANDO_APP_KIND` env var is populated for every Lando-managed service in every kind of app (`user`, `global`, `scratch`); it is part of the §6.9 contract. |
| DNS | `<service>.<id>.internal` | Same shape as user apps; uniqueness is guaranteed by the `<id>`'s 6-hex suffix. |

A scratch id is the canonical key in every persistent artifact path (§12.4), every cache entry (§12.1), every provider label, and every event payload's `app:` field. The string MAY appear in user-facing UI; it is not a secret.

### 21.3 The scratch app root

A scratch app's root is created on demand at start under `<userCacheRoot>/scratch/<scratch-id>/root/`. The directory layout mirrors a normal app root:

```text
<userCacheRoot>/scratch/<scratch-id>/
├── root/                          # the scratch app root
│   ├── .lando.yml                 # canonical Landofile (rendered or copied)
│   ├── .lando.lock.yml            # lockfile if the source had one
│   └── … (source files, recipe-rendered files, fragments/)
├── plan.bin                       # app-plan cache (§12.1 scratch-app-plan)
├── info.json                      # last-known ServiceInfo[] (§12.1 scratch-app-info)
└── build-results.bin              # per-(service,phase,buildKey) outcomes (§12.1)
```

The root is **not** a discoverable app root: `LandofileService` and the `cwd-app-map` writer (§12.1) explicitly exclude `<userCacheRoot>/scratch/` from the cwd walk, identical to the global app's directory exclusion (§20.3.2). A user who `cd`s into a scratch root sees no app context from `lando info`.

The root, the plan cache, the info cache, the build-results cache, and every transcript under `<userDataRoot>/builds/scratch/<scratch-id>/` are removed atomically at scope finalization (§21.6). A SIGKILL or host crash that bypasses finalization leaves the directory in place; `apps:scratch:gc` (§21.10, §21.11) reaps it.

### 21.4 Scratch sources

A scratch app has exactly one source. Two source kinds are supported in v4.0:

```ts
export const ScratchSource = Schema.Union(
  Schema.TaggedStruct("fork", {
    sourceAppRoot: AbsolutePath,
    sourceAppId:   Schema.String,                       // resolved user-app slug at start time
    landofileLayers: Schema.Array(Schema.String),       // file names copied from the source's six merge layers
  }),
  Schema.TaggedStruct("from-recipe", {
    recipe:    RecipeRef,                               // accepts every source scheme `apps:init --recipe` accepts (§8.8.4)
    answers:   Schema.Record(Schema.String, Schema.Unknown), // resolved prompt answers (`--answer` / `--answers`)
  }),
);
```

#### 21.4.1 Fork mode

`apps:scratch:start --fork [--source <path>]` materializes the scratch root by **copying the resolved source app root**. With no `--source`, the source is the standard cwd-walk app root (§7.1).

Materialization rules:

- The copy is a recursive content copy via `Bun.file` / `FileSystem` primitives, not a hardlink, not a CoW overlay. Provider-managed CoW is deferred to v4.x via a new `ProviderCapabilities.copyOnWriteAppRoot` capability (§21.15).
- Files matched by the source app's resolved excludes (`.gitignore`-style patterns supplied via `--exclude` plus the global config `scratch.fork.excludes:`, defaulting to `.git/`, `node_modules/`, `vendor/`, `.lando/cache/`, `.DS_Store`) are NOT copied. The default excludes keep the typical fork copy bounded; a 5-GB `node_modules` does not enter the scratch root.
- The source's six Landofile layers (§7.2) are all copied verbatim. The scratch's `LandofileService` re-runs the merge against the scratch root so cross-Landofile layer overrides apply identically.
- The scratch's resolved `name:` is rewritten to the scratch id at parse time so `<app-id>` derivation in §7.4 and provider labels stay consistent. The user does not author a name.
- A `.lando.lock.yml` from the source is copied byte-for-byte, but the scratch's plan caches (§12.1) are fresh; `includes:` resolution runs against the warm cache and does not re-fetch (the lockfile pins the resolved refs).
- The source's `.lando.local.yml` and `.lando.user.yml` MAY be excluded via `--no-local-overrides`; by default they are copied so the developer's host-specific config (e.g., volume mounts to a host tools directory) carries through.

The copy is atomic: failures during materialization remove the partial root and surface `ScratchMaterializeError` with the offending path. Provider operations do not start until the root is fully materialized.

#### 21.4.2 Scratch mode

`apps:scratch:start --from <recipe-ref> [--answer key=value]…` materializes the scratch root by **running the recipe pipeline** (§8.8.9, steps 1–6) against the scratch root as the destination. The recipe's `postInit:` actions are NOT run (a scratch app's `postInit.command: app:start` would conflict with the scratch start's own orchestration; recipes that rely on `bun: { verb: install }` post-init can opt in via `--run-post-init`).

Materialization rules:

- The recipe is resolved through the standard recipe source registry (§8.8.4) and is content-addressed; repeated `lando scratch start --from lamp` reuses the same warm-cached recipe.
- Prompts honor `--answer key=value`, `--answers <file>`, `--no-interactive`, and `--yes` exactly as `apps:init` does. A prompt without an answer in `--no-interactive` mode aborts with `RecipeMissingAnswerError`; the partially-materialized root is removed.
- The recipe's generated `.lando.yml` carries the scratch's resolved id as `name:` (rewritten before file write); the user does not author a name unless they pass `--name`, in which case the supplied base is used to compute the scratch id (§21.2).
- Bundled fragments (`fragments/`) and assets (`assets/`) are copied through.
- Scratch mode's default mount isolation is `baked` (§21.7): the recipe-generated user-code files (e.g., a default `index.php`) live in the scratch root for the planner to read, but the `appMount` that would bind them into services is suppressed.

### 21.5 `ScratchAppService` core service

```ts
export class ScratchAppService extends Context.Service<ScratchAppService, {
  // Acquisition. Each call returns a Scope-owned AppRef + plan; finalizers destroy on scope close.
  readonly acquire: (input: ScratchAcquireInput) =>
    Effect.Effect<ScratchHandle, ScratchAppError, Scope.Scope>;

  // Identity helpers.
  readonly resolveById: (id: string) => Effect.Effect<ScratchHandle, ScratchAppError>;
  readonly list:        (opts?: ScratchListOptions) => Effect.Effect<ReadonlyArray<ScratchSummary>, ScratchAppError>;

  // Lifecycle. `start`/`stop` are exposed for the detached path (§21.10);
  // foreground starts go through `acquire` so scope finalization handles teardown.
  readonly start:   (id: string, opts?: ScratchStartOptions)  => Effect.Effect<ScratchHandle, ScratchAppError, Scope.Scope>;
  readonly stop:    (id: string, opts?: ScratchStopOptions)   => Effect.Effect<void, ScratchAppError>;
  readonly destroy: (id: string, opts?: ScratchDestroyOptions) => Effect.Effect<void, ScratchAppError>;

  // GC. Walks the scratch registry and the active provider's labeled containers
  // to find orphans; reports and (with `--prune`) reaps them.
  readonly gc: (opts?: ScratchGcOptions) => Effect.Effect<ScratchGcReport, ScratchAppError>;
}>()("@lando/core/ScratchAppService") {}

export interface ScratchAcquireInput {
  readonly source: ScratchSource;                       // §21.4
  readonly isolate: "full" | "baked" | "cwd";           // §21.7
  readonly mountCwd?: AbsolutePath;                     // when `isolate: "cwd"`
  readonly shareGlobalStorage: boolean;                 // §21.8
  readonly name?: string;                               // user-supplied base; default derived from source
  readonly answers?: Record<string, unknown>;           // recipe answers (scratch mode only)
  readonly excludes?: ReadonlyArray<string>;            // additive excludes for fork-mode copy
  readonly detached: boolean;                           // §21.10; foreground default false
}

export interface ScratchHandle {
  readonly app:  AppRef;                                // .kind === "scratch"
  readonly plan: AppPlan;
  readonly source: ScratchSource;
  readonly isolate: "full" | "baked" | "cwd";
  readonly createdAt: DateTimeUtc;
}
```

Required behaviors:

- **Bootstrap level:** the service is a member of the AOT-composed `scratch` bootstrap layer (§21.6.1, §3.4 membership table). Library-mode hosts MAY construct it directly via `makeLandoRuntime({ bootstrapLevel: "scratch" })`.
- **`Layer.suspend`-wrapped.** Constructing the runtime at level `app` (or higher) does NOT instantiate `ScratchAppService` until something actually requests it. A `lando info` against a regular user app pays zero `ScratchAppService` cost.
- **Scope ownership.** `acquire` returns a `ScratchHandle` whose containing `Scope` owns the materialized root, the plan cache entry, the host-proxy socket (if any), the proxy routes, and every container/volume the start created. Scope finalization MUST `destroy` before unlinking the root. The CLI's foreground command (§21.10) acquires the scratch under the OCLIF command's scope so `Ctrl+C` propagates cleanly via `Effect.interrupt`.
- **Idempotent destroy.** A second call to `destroy(id)` after the first succeeded is a no-op; a call against an unknown id surfaces `ScratchUnknownIdError`. This matters for the orphan-reap path: `apps:scratch:gc --prune` calls `destroy` against ids found via the provider label scan that may already be torn down.
- **Single-writer lock per id.** Concurrent `acquire` calls produce different ids by construction (the 6-hex suffix is unique per acquisition). Concurrent operations against the *same* id (e.g., a foreground stop racing a `gc --prune`) are serialized by an in-process `Ref<Map<id, Mutex>>`. Cross-process serialization uses the registry file (§21.11) plus a fcntl-style lockfile under `<userCacheRoot>/scratch/<id>/lock`.
- **Errors are tagged.** `ScratchMaterializeError`, `ScratchSourceUnresolvedError`, `ScratchUnknownIdError`, `ScratchIsolationUnsupportedError`, `ScratchRecipeAnswersError`, plus the umbrella `ScratchAppError` for state transitions.

`ScratchAppService` reuses every existing core service: `LandofileService` for parse/merge against the scratch root, `AppPlanner` for plan derivation, `BuildOrchestrator` for build, `ProxyService` and `CertificateAuthority` for routing/certs (with the §21.9 route-suffix transformation applied at plan time). Treating the scratch app as "an app whose root, identity, and lifetime are managed by Lando" is the design's north star.

### 21.6 Lifecycle

#### 21.6.1 The `scratch` bootstrap level

A new `scratch` bootstrap level slots between `provider` and `app` in the §3.2 ladder, parallel to `global`:

| Level | Adds | Used by |
|---|---|---|
| `provider` | (unchanged) | `meta:setup`, `apps:poweroff`, `apps:list --all` |
| `global` | (unchanged) | `meta:global:*` |
| **`scratch`** | `ScratchAppService` (eager); `LandofileService` constructible against an arbitrary scratch root; `AppPlanner` and `BuildOrchestrator` (lazy via `Layer.suspend`) | `apps:scratch:start`, `apps:scratch:stop`, `apps:scratch:list`, `apps:scratch:destroy`, `apps:scratch:gc`, `apps:scratch:info`, `apps:scratch:logs` |
| `app` | (unchanged) | `app:start`, `app:stop`, etc. |

`scratch` does NOT include `global` eagerly: a scratch app whose `AppFeature` activations require global services will still trigger `GlobalAppService.ensureRunning` per §20.6.3, but the lazy construction of `GlobalAppService` is wrapped in `Layer.suspend` exactly as it is at level `app`.

**`bootstrap: scratch` on a `LandoCommandSpec`** is a new value in the §8.3 enum. Plugins MAY use it for commands under their own namespace that operate on scratch apps through `ScratchAppService`; `apps:scratch:*` canonical ids remain reserved for core (§21.10, §21.15).

#### 21.6.2 Lifecycle event scope

A new **`Scratch`** scope joins the §3.5 event taxonomy:

| Scope | Standard events |
|---|---|
| Scratch | `pre-scratch-acquire`, `post-scratch-acquire`, `pre-scratch-materialize`, `post-scratch-materialize`, `pre-scratch-start`, `post-scratch-start`, `pre-scratch-stop`, `post-scratch-stop`, `pre-scratch-destroy`, `post-scratch-destroy`, `pre-scratch-gc`, `post-scratch-gc` |

Events follow the same shape as the App scope. Payload schemas mirror App-scope payloads with the additional source/isolation context:

```ts
export const PreScratchStartEvent = Schema.TaggedStruct("pre-scratch-start", {
  app: AppRef,                                          // .kind === "scratch"
  plan: AppPlan,
  source: ScratchSource,                                // §21.4
  isolate: Schema.Literal("full", "baked", "cwd"),
  shareGlobalStorage: Schema.Boolean,
  detached: Schema.Boolean,
  triggeredBy: Schema.Union(
    Schema.Literal("apps:scratch:start"),
    Schema.Literal("scratch-acquire"),                  // library-mode acquire path
    Schema.Literal("apps:scratch:gc"),                  // GC-driven re-resolve (rare; surfaces a stale-running scratch)
  ),
  timestamp: Schema.DateTimeUtc,
});
export type PreScratchStartEvent = Schema.Schema.Type<typeof PreScratchStartEvent>;

export const PreScratchDestroyEvent = Schema.TaggedStruct("pre-scratch-destroy", {
  app: AppRef,
  reason: Schema.Union(
    Schema.Literal("scope-finalize"),                   // foreground exit / library scope close
    Schema.Literal("user-stop"),                        // explicit `apps:scratch:stop` / `:destroy`
    Schema.Literal("poweroff"),                         // `apps:poweroff`
    Schema.Literal("gc-orphan"),                        // `apps:scratch:gc --prune`
  ),
  retainArtifacts: Schema.Array(Schema.String),         // paths NOT removed (e.g., `--keep-volumes`)
  timestamp: Schema.DateTimeUtc,
});
export type PreScratchDestroyEvent = Schema.Schema.Type<typeof PreScratchDestroyEvent>;
```

The `App` scope events (`pre-init`, `pre-start`, `pre-build`, etc.) STILL fire from inside the scratch app's lifecycle, with `app.kind === "scratch"` on every payload. Subscribers that already react to `pre-start` automatically receive scratch-app starts; subscribers that want to single out scratch apps pattern-match on `app.kind` or subscribe to `pre-scratch-start` directly. The relationship mirrors §20.6.4: Global-scope events wrap the underlying App-scope events; Scratch-scope events do the same.

#### 21.6.3 Standard event sequence

`apps:scratch:start --from lamp` (cold) — illustrative ordering, scratch id `scratch-lamp-3a2f9c`:

```text
… (bootstrap-minimal..bootstrap-scratch per §11.4)
post-bootstrap
ready
cli-apps:scratch:start-init
pre-scratch-acquire   { source: { _tag: "from-recipe", recipe: "lamp" } }
  pre-scratch-materialize
    … (recipe pipeline: prompts, render, atomic file writes; §8.8.9 steps 1–6)
  post-scratch-materialize
  pre-scratch-start   { app: { kind: "scratch", id: "scratch-lamp-3a2f9c" }, isolate: "baked", detached: false }
    pre-init          (App scope; app.kind === "scratch")
    post-init
    pre-start
      pre-global-start { triggeredBy: "ensure-running", … }   (only when AppFeature.requires.globalServices yields a non-empty set)
      post-global-start
      pre-build
        …                                                       (per §6.13)
      post-build
    post-start
  post-scratch-start
post-scratch-acquire
cli-apps:scratch:start-run
                                                                (foreground: command's run() is now blocking on the scope)
                                                                (Ctrl+C → Effect.interrupt → scope finalize:)
pre-scratch-destroy   { reason: "scope-finalize" }
  pre-stop                                                       (App scope)
  post-stop
  pre-destroy
  post-destroy
post-scratch-destroy
cli-apps:scratch:start-run                                       (only fires once at success; if a destroy error escapes,
                                                                   cli-apps:scratch:start-error fires instead)
before-exit
```

`apps:poweroff` (default behavior, with at least one detached scratch app running):

```text
cli-apps:poweroff-init
  pre-stop (foo)
  post-stop (foo)
  pre-scratch-destroy { app: <scratch-1>, reason: "poweroff" }
    pre-stop  (scratch-1)
    post-stop (scratch-1)
    pre-destroy
    post-destroy
  post-scratch-destroy
  pre-scratch-destroy { app: <scratch-2>, reason: "poweroff" }
    …
  post-scratch-destroy
  pre-global-stop { triggeredBy: "apps:poweroff" }
    …
  post-global-stop
cli-apps:poweroff-run
```

`apps:poweroff --keep-scratch` skips every `pre-scratch-destroy` block and reports "kept N scratch app(s) running" in the renderer's final summary. The flag composes with `--keep-global` (§20.6.4).

### 21.7 Mount isolation: the `--isolate` knob

A scratch app's relationship to host filesystem state is governed by `--isolate=full|baked|cwd`. The default depends on the source kind:

| Source | Default | What "default" means |
|---|---|---|
| Fork (`--fork`) | `full` | The scratch root is a copy of the source app root (§21.4.1). The `appMount:` (§6.4) and any user-declared `mounts:` whose `source:` is relative to the app root resolve against the scratch root's copy, NOT the source. The source app's files are physically a different copy on disk; mutations inside the scratch are isolated by construction. |
| Scratch (`--from <recipe>`) | `baked` | The `appMount:` is suppressed at plan time. Services start with whatever `/app` (or the configured destination) the artifact provides; recipe-rendered user-code files live in the scratch root for the planner to read but are not bound into containers. |

The full enum:

| Value | Effect on `appMount` | Effect on `mounts:` entries with relative `source:` | Effect on `mounts:` entries with absolute `source:` |
|---|---|---|---|
| `full` | Bound to the scratch root's copy of the source app root | Resolve against the scratch root | Pass through unchanged (the user explicitly named a host path; honor it) |
| `baked` | Suppressed (no bind for the appMount) | Suppressed | Pass through unchanged |
| `cwd` | Bound to the host cwd at start time | Resolve against the host cwd | Pass through unchanged |

`--mount-cwd` is sugar for `--isolate=cwd` (when used in scratch mode) or for `--isolate=cwd` with an explicit warning (in fork mode, where it overrides the safer `full` default). The flag exists because the most common user request — "spin up a quick LAMP and serve my current directory" — should be one short flag, not `--isolate=cwd`.

`--isolate=full` and `--isolate=cwd` are mutually exclusive with `--mount-cwd`; passing both fails fast with `ScratchIsolationConflictError`.

`--isolate=passthrough` (sharing the source app's mounts directly) is **not** accepted at v4.0; the flag is reserved for a future v4.x release that gates it on a `ProviderCapabilities.copyOnWriteAppRoot` capability. Specifying it surfaces `ScratchIsolationUnsupportedError` with remediation pointing at `--isolate=full`.

`--exclude <pattern>` (repeatable) extends the fork-mode copy excludes (§21.4.1); `scratch.fork.excludes:` in global config extends them globally. Excludes are pattern-matched gitignore-style.

### 21.8 Storage shadowing

The §6.5 storage scopes are unchanged. The scratch-app interpretation:

| Scope as written | Scope as planned in scratch | Volume auto-name | Survives `apps:scratch:destroy`? |
|---|---|---|---|
| `service` | `service` | `<scratch-id>-<service>-<destination>` | No |
| `app` | `app` | `<scratch-id>-<destination>` | No |
| `global` | **`app` by default** | `<scratch-id>-<destination>` | No |
| `global` (with `--share-global-storage`) | `global` | `lando-<destination>` (the §6.5 cross-app shape) | **Yes** — the same survives-destroy contract every cross-app `scope: global` volume already has |

The default rewriting of `scope: global` → `scope: app` at plan time is what makes scratch apps safe by construction: a `lando scratch start --fork` against a Drupal project does not reach into the `lando-mysql-data` volume that the source app uses. The user's data on the host is never at risk from a scratch op. With `--share-global-storage`, the original semantics are restored — the scratch's MariaDB sees the same `lando-mysql-data` the source does, the user gets to test against real data, and cleanup leaves the volume in place.

`--share-global-storage` is the explicit opt-in. It MUST NOT be inferred from any other flag.

Volumes created by scratch services additionally carry these provider labels (extending §6.5):

```text
dev.lando.scratch:        "TRUE"
dev.lando.scratch-id:     <scratch-id>
dev.lando.storage-volume: "TRUE"
dev.lando.storage-scope:  <effective-scope>            # "service" | "app"; "global" only with --share-global-storage
dev.lando.storage-project: <scratch-id>                # set for service/app; absent for shared scope: global
dev.lando.storage-service: <service>                   # set for service scope only
```

The labels make `apps:scratch:gc` deterministic without consulting the registry: a `dev.lando.scratch: "TRUE"` label whose `dev.lando.scratch-id` does not appear in the running scratch registry (§21.11) is an orphan.

### 21.9 Networking and discovery

#### 21.9.1 DNS

`<service>.<scratch-id>.internal` resolves from inside the scratch app's services exactly the way `<service>.<app-id>.internal` resolves for user apps (§10.1). The `<scratch-id>`'s 6-hex suffix guarantees uniqueness across concurrent scratch apps, so a `mariadb.scratch-lamp-3a2f9c.internal` does not collide with a `mariadb.scratch-lamp-7e91bc.internal` even when both share a base.

Cross-app DNS into a scratch app (`<service>.<scratch-id>.internal` from a *user* app) is supported when the active provider declares `sharedCrossAppNetwork: true` (§5.4); the scratch app's services join the same provider network user apps and the global app share. The expected use is "let me curl my scratch's web service from a tool running in my user app" during a debugging session; it is not a recommended pattern for committed config.

#### 21.9.2 Route auto-suffix

When the scratch app's plan contains routes whose hostnames would collide with an in-flight user app's routes (the most common case: a fork of a user app whose Landofile declares `proxy: app: [app.lndo.site]`), the planner applies a **route auto-suffix** filter at plan time. Every hostname `<host>.<domain>` not explicitly overridden via `--hostname` or `--no-hostname-suffix` is rewritten to `<host>--<scratch-id>.<domain>`:

```text
app.lndo.site             →  app--scratch-myproj-3a2f9c.lndo.site
admin.app.lndo.site       →  admin.app--scratch-myproj-3a2f9c.lndo.site
*.app.lndo.site           →  *.app--scratch-myproj-3a2f9c.lndo.site
```

The transformation is implemented as a `RoutePlan` filter (§6.6) named `ScratchHostnameSuffix` and is applied unconditionally to every scratch app at plan time unless `--no-hostname-suffix` is passed. The filter is idempotent — running it twice yields the same hostnames — and does not modify routes whose hostname is already explicitly bound to the scratch via `--hostname`.

`--hostname <host>` (repeatable) overrides the suffix transformation for a single hostname: `--hostname app.lndo.site` keeps the route as-is, which collides with the source app if it is running. The flag is for users who deliberately want the collision (e.g., to test "what if I shut down the source and serve the scratch on the same hostname").

#### 21.9.3 Exclusion from cross-app scopes

`globalServices.<name>.*` cross-service expressions (§7.3.1, §20.8.3) work from a scratch app's `AppFeature.apply()` body identically to a user app. The reverse — a user app referencing `scratchApps.<id>.*` — is NOT supported in v4.0. Scratch apps are addressable by their stable id but they are not first-class cross-app sources, because their lifetime is by definition transient.

### 21.10 CLI surface (`apps:scratch:*`)

Scratch apps get their own CLI subtree under the `apps:` namespace. Default top-level aliases use the `scratch:` prefix so they don't shadow user-app aliases. The single-word top-level `scratch` (no colon) is also reserved as the `apps:scratch:start` shortcut, mirroring how `apps:init` ships with the `init` top-level alias.

| Canonical id | Default top-level alias | Bootstrap | Summary |
|---|---|---|---|
| `apps:scratch:start` | `scratch:start`, `scratch` | `scratch` | Start a scratch app. `--fork` (use cwd's Landofile as source) or `--from <recipe-ref>` (recipe scaffold) is required. Foreground by default; `--detach` registers the scratch and returns. |
| `apps:scratch:stop` | `scratch:stop` | `scratch` | Stop a scratch app. `<id>` selects an explicit one; with no id, stops the foreground scratch in this shell session if any. Calls `destroy` after stop. |
| `apps:scratch:destroy` | `scratch:destroy` | `scratch` | Destroy a scratch app's resources without first stopping (used after a stuck stop). `<id>` required. `--keep-volumes` retains volumes for inspection (overrides the §21.6.2 default that volumes go on destroy). |
| `apps:scratch:list` | `scratch:list` | `scratch` | List every scratch app from the scratch registry plus orphans found via the provider label scan. `--format table\|json`. |
| `apps:scratch:info` | `scratch:info` | `scratch` | Print runtime info for a scratch app. `<id>` selects; `--service`, `--format`. |
| `apps:scratch:logs` | `scratch:logs` | `scratch` | Stream scratch service logs. `<id>` selects; `--service`, `--follow`, `--tail`, `--since`. |
| `apps:scratch:gc` | `scratch:gc` | `scratch` | Find orphaned scratch resources (stale registry entries, label-matched containers/volumes whose scratch root or registry entry is missing) and report them. `--prune` reaps. Recommended for cron or post-host-reboot cleanup. |

`apps:list` shows user apps by default. `apps:list --include-scratch` adds running scratch apps; `apps:list --all` is the union (`--all` continues to include stopped user apps, the global app, and scratch apps).

`apps:poweroff` stops every Lando-managed service across user apps + the global app + every scratch app by default. `--keep-scratch` opts out (§21.6.3). The flag composes with `--keep-global`.

#### 21.10.1 `apps:scratch:start` flags

```text
lando apps scratch start
        [--fork | --from <recipe-ref>]
        [--source <path>]                     # fork mode override; defaults to cwd-walk
        [--isolate=full|baked|cwd]            # default: full (fork) | baked (scratch)
        [--mount-cwd]                         # sugar for --isolate=cwd
        [--share-global-storage]              # opt out of §21.8 shadowing
        [--no-hostname-suffix]                # opt out of §21.9.2 route suffix
        [--hostname <host>]...                # per-host override of the route suffix
        [--name <base>]                       # base for the scratch id (default: source name / recipe id)
        [--exclude <pattern>]...              # additive fork-mode copy excludes
        [--no-local-overrides]                # fork mode: don't copy .lando.local.yml / .lando.user.yml
        [--answer key=value]... [--answers <file>] [--no-interactive] [--yes]
        [--detach]                            # don't block the shell; register and return
        [--keep-volumes]                      # retain scratch-created volumes for inspection; cf. §21.8 shadowing rules
        [--keep-on-failure]                   # don't auto-destroy if the scratch fails to come up healthy
```

Behaviors:

- The default (no `--detach`) is **foreground**. The CLI's `run()` body acquires the scratch under the OCLIF command's scope and blocks until the user signals exit (Ctrl+C, `lando scratch stop` from another shell, or process termination). Scope finalization on exit destroys the scratch.
- `--detach` registers the scratch in `<userCacheRoot>/scratch/registry.bin` (§12.1, §21.11) with the owning process's PID, the scratch id, the source kind, the resolved isolation mode, and the start time. The CLI prints the scratch id and exits 0; the scratch survives until `apps:scratch:stop <id>`, `apps:poweroff`, or `apps:scratch:gc --prune` reaps it.
- Every flag is recorded in the scratch registry entry so `apps:scratch:list` can render the human-readable shape later.
- `--keep-volumes` is a destroy-time flag (it is forwarded into the scope finalizer) and applies on Ctrl+C, foreground exit, and explicit `apps:scratch:stop`. It does NOT apply to `apps:poweroff`-driven destroys, which always purge.
- `--keep-on-failure` skips the scope finalizer's destroy when the start fails to reach a healthy state. The user can inspect the broken scratch with `apps:scratch:info <id>` and `apps:scratch:logs <id>` and then explicitly destroy. Useful for diagnosing recipe-rendered Landofiles that fail validation.

#### 21.10.2 Top-level alias reservation

The §8.1.2 alias-collision policy reserves the `scratch:` prefix and the bare `scratch` alias for the `apps:scratch:*` defaults listed above. Plugin- or tooling-contributed top-level aliases that begin with `scratch:` or that are exactly `scratch` collide with the built-ins and are rejected with `CommandAliasConflictError`. User overrides via `commandAliases.custom:` MAY remap a `scratch:*` alias to a user-defined tooling task; the underlying `apps:scratch:*` canonical id is always callable directly.

### 21.11 Cleanup, registry, and orphan reaping

The **scratch registry** at `<userCacheRoot>/scratch/registry.bin` (§12.1) is the in-process source of truth for active scratch apps. Each entry carries:

```ts
export const ScratchRegistryEntry = Schema.Struct({
  id: Schema.String,
  source: ScratchSource,                                // §21.4
  isolate: Schema.Literal("full", "baked", "cwd"),
  shareGlobalStorage: Schema.Boolean,
  detached: Schema.Boolean,
  ownerPid: Schema.optional(Schema.Number),             // present for foreground scratches; null when detached if the owning shell has since exited
  ownerStartedAt: Schema.DateTimeUtc,
  rootPath: AbsolutePath,                               // <userCacheRoot>/scratch/<id>/root/
  hostProxySocket: Schema.optional(AbsolutePath),       // when the plan included `lando.host-proxy`
  status: Schema.Literal("acquiring", "running", "stopping", "destroyed-pending-cleanup"),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
```

Lifecycle invariants:

- `acquire` writes the entry as `acquiring` before any provider operation, updates to `running` after `post-scratch-start`, and removes it after `post-scratch-destroy`.
- A scope finalizer that fails mid-destroy leaves the entry as `destroyed-pending-cleanup`; the next `apps:scratch:gc` retries the destroy.
- Concurrent process access to the registry uses an atomic write plus a fcntl-style lockfile at `<userCacheRoot>/scratch/registry.lock`, both realized through the canonical `StateStore` primitive (§12.7) — an `advisory`, `quarantine` bucket whose `read`/`upsert`/`remove` map to `StateBucket.get`/`update`.

`apps:scratch:gc` does three things, in order:

1. **Walk the registry.** For each entry whose `ownerPid` is set and not alive (`kill(pid, 0)` fails with ESRCH), promote the entry to GC's reap list.
2. **Walk provider labels.** For each `RuntimeProvider.listLandoResources()` result whose `dev.lando.scratch: "TRUE"` label's `dev.lando.scratch-id` value is NOT present in the registry, treat the resource as orphaned and add the implied scratch id to the reap list.
3. **Reap.** With `--prune`, call `ScratchAppService.destroy` against every reap-list id; without `--prune`, print the report and exit 0.

The provider-label walk is what catches resources whose registry entry was removed by a corrupt cache or whose registry was wiped by `--clear`. The two walks are deliberately complementary: registry-only would miss resources whose registry was lost; label-only would miss the materialized scratch root and the host-proxy socket whose locations are not encoded in any provider label.

`apps:scratch:gc` is safe to run from cron. Its stdout shape is stable for piping into other tools; `--format json` is the canonical machine shape.

### 21.12 Library mode

Embedding hosts acquire scratch apps through the public `@lando/core` API:

```ts
import { Effect } from "effect";
import { openLandoRuntime } from "@lando/core";

const program = Effect.gen(function* () {
  const runtime = yield* openLandoRuntime({
    bootstrap: "scratch",
    scratch: {
      source: { _tag: "from-recipe", recipe: "lamp" },
      isolate: "baked",
      shareGlobalStorage: false,
    },
  });

  // The scratch is acquired against the program's Scope.
  // Run library API operations here:
  const app = yield* runtime.app();
  const info = yield* app.info();
  // …assertions…
  // …on scope close, the scratch is destroyed automatically.
});

await Effect.runPromise(Effect.scoped(program));
```

Required behaviors (extends §16.3):

- `makeLandoRuntime({ scratch })` with the `scratch` option provided causes the returned runtime to acquire a scratch app at construction. The acquisition runs within the runtime's `Scope`; finalization destroys the scratch.
- Without the `scratch` option, the runtime is non-scratch (the existing §16 contract). The option is opt-in.
- `runtime.scratch(input)` is exposed as the typed handle for hosts that want to drive multi-scratch flows manually (a TUI control surface that lists and switches between scratches, for example). The handle delegates to `ScratchAppService` (§21.5).
- The library reuse-perf rule from §16.3 applies: a host that wants to spin up many scratches in succession SHOULD reuse the same `LandoRuntime` and call `runtime.scratch(input)` per scratch, rather than constructing a fresh runtime each time.
- The §13.1 library API contract suite gains a scratch-app reuse class: a host that acquires N scratches in succession against a single runtime MUST observe steady-state per-scratch acquisition latency (no growth as N increases).

### 21.13 Discovery and resolution rules summary

| Rule | Source |
|---|---|
| `AppRef.kind` is the discriminator between `user`, `global`, and `scratch` apps. | §21.2 |
| Scratch ids and user-app slugs live in separate identifier namespaces; no slug reservation is enforced. | §21.2 |
| `<userCacheRoot>/scratch/<id>/` is excluded from cwd-based app discovery and from the `cwd-app-map` cache. | §21.3 |
| Fork mode copies the resolved source app root via content copy; CoW overlay is deferred. | §21.4.1, §21.15 |
| Scratch mode renders a recipe into the scratch root; recipe `postInit:` actions are NOT run unless `--run-post-init` is set. | §21.4.2 |
| Default isolation: fork mode → `full`; scratch mode → `baked`. `--mount-cwd` is sugar for `--isolate=cwd`. | §21.7 |
| `scope: global` storage in a scratch app is rewritten to `scope: app` at plan time unless `--share-global-storage` is set. | §21.8 |
| Routes are auto-suffixed with `--<scratch-id>` unless `--no-hostname-suffix` or `--hostname <host>` overrides. | §21.9.2 |
| `apps:poweroff` destroys scratch apps by default; `--keep-scratch` opts out. | §21.6.3, §21.10 |
| `scratch:` and the bare `scratch` reserve top-level alias names. | §21.10.2 |
| The scratch registry plus the provider-label scan together drive `apps:scratch:gc`. | §21.11 |

### 21.14 Errors

Tagged errors specific to scratch apps live in `@lando/core/errors`:

- `ScratchAppError` — umbrella error for state transitions; carries a `state` field (`acquire`, `materialize`, `start`, `stop`, `destroy`, `gc`) and a redacted cause.
- `ScratchMaterializeError` — fork-mode copy or recipe-render failed. Payload: `{ id, source, path, cause }`. The partial root is removed before the error surfaces.
- `ScratchSourceUnresolvedError` — `--fork` was passed but cwd has no resolvable Landofile, OR `--from <recipe-ref>` resolution failed against every source scheme. Payload: `{ source, attempts }`.
- `ScratchUnknownIdError` — an operation referenced an id that has no registry entry and no live provider resources. Payload: `{ id, suggestions: ReadonlyArray<string> }`.
- `ScratchIsolationConflictError` — incompatible flags (e.g., `--mount-cwd` plus `--isolate=full`). Payload: `{ flags: ReadonlyArray<string> }`.
- `ScratchIsolationUnsupportedError` — `--isolate=passthrough` (deferred) or another mode the active provider does not satisfy. Payload: `{ mode, requiredCapability?: keyof ProviderCapabilities }`.
- `ScratchRecipeAnswersError` — recipe prompts could not be satisfied (missing answer in `--no-interactive`, validation failure). Wraps `RecipeMissingAnswerError` / `RecipeOutputValidationError` with the scratch id attached.
- `ScratchRegistryCorruptError` — the registry binary failed schema decode and was quarantined to `<userCacheRoot>/scratch/registry.bin.corrupt-<timestamp>`. The next operation rebuilds an empty registry and triggers a label-driven `apps:scratch:gc` run to recover orphans.

Every error includes a `remediation` field. Errors raised during scope finalization are *also* logged via `Logger` at warn level so they are observable even when the destroy path swallows them to keep the scope finalizer honoring "best-effort cleanup" semantics.

### 21.15 Non-goals

Out of scope for v4.0; the architecture preserves the option for each:

- **CoW / overlay isolation.** `--isolate=passthrough` and "instant fork" via filesystem CoW (APFS clonefile, btrfs reflink, ZFS clone, Docker overlay2-on-overlay2) are deferred. The trigger for adding them post-v4.0 is a `ProviderCapabilities.copyOnWriteAppRoot` capability plus a clear story for cross-platform reflink support. Until then, fork mode does a content copy.
- **Scratch fleets.** A primitive that orchestrates N parallel scratch apps from one source (matrix testing across PHP versions, for example) is not a v4.0 feature. The architecture preserves the option through `ScratchAppService.acquire` being scope-keyed and idempotent; a fleet abstraction would compose acquires concurrently. Until then, users script `apps:scratch:start --detach` calls.
- **Hot reload from the source's working tree.** Fork mode is a snapshot. There is no v4.0 mechanism for the scratch to track edits made in the source app's directory after acquisition. A future plugin could observe the source's mtimes and re-sync into the scratch root via `FileSyncEngine`; v4.0 does not.
- **Scratch as cross-app source.** User apps cannot reference `scratchApps.<id>.*` in cross-service expressions (§21.9.3). Scratch ids are stable but transient; reaching across the boundary would tempt the user into committing config that breaks when the scratch is destroyed.
- **User-relocatable scratch root.** The path `<userCacheRoot>/scratch/` is canonical at v4.0; there is no `scratch.root:` global config key. If users want scratch state on a different filesystem, they relocate `<userCacheRoot>` (a documented operation) — scratch state moves with it.
- **Persistent agent for scratch.** §14.2's deferred persistent agent would cache a warm runtime for fast successive invocations. That is orthogonal to scratch: even with a warm runtime, scratch apps still have to materialize, plan, and start their services. The two compose cleanly when both ship.
- **Scratch through `meta:plugin:add` install.** A plugin author cannot register a scratch app at install time. Scratch acquisition is always a user-initiated CLI invocation or a library-mode `acquire`. Plugins MAY contribute new `globalServices:` (§20) or new recipes (§8.8.4) that scratches can consume; they do not own scratches themselves.
