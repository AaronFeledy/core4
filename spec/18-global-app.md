# Lando v4 — The Global App

> **Part 18 of 18** · [Index](./README.md)
> **Read next:** *(end of spec)*

This part defines the **global Lando app**: a reserved, host-level Lando app that runs services shared across every user app on the host. The global app is the canonical home for cross-cutting host services — the Mailpit SMTP server and UI, the Traefik proxy, and any plugin-contributed service that has more affinity with "the host" than with a single project. Plugins contribute services to the global app through a new `globalServices:` manifest surface; user apps automatically discover and depend on them through existing `AppFeature` activations (§6.11.4).

§20 (The Global App) is filed as a single part because every facet of the concept is novel to v4: a reserved app id, a Lando-owned Landofile location, a new manifest contribution surface, a new core service, a new bootstrap level, a new lifecycle event scope, a new CLI namespace, and a refactor of how `ProxyService` realizes its routes. Reading the part top-to-bottom is the fastest way to understand how Lando's "ambient services" model differs from a v3 setup where Traefik is implicit.

The motivating user-facing examples:

- A user runs `lando plugin add @lando/service-mailpit`. From that moment, every PHP/Node/Python service in every user app on the host can `mail to mailpit.global.internal:1025` and read captured mail at `https://mailpit.lndo.site`. No per-app Landofile change. No `services: { mailpit: { type: mailpit } }` boilerplate.
- The Lando proxy (Traefik in the default bundle) is itself a service in the global app. Plugins that need an HTTP proxy contribute routes through `ProxyService` exactly as they do today; the realization is now visible in `lando meta global info` and reuses the same lifecycle, build, healthcheck, and cert machinery user apps use.

---

## 20. The Global App

### 20.1 What the global app is

The **global app** is a Lando app with the reserved id `global`. It satisfies the same `AppPlan` schema (§5.5), uses the same `RuntimeProvider` (§5.3), runs through the same `BuildOrchestrator` (§3.4, §6.13), publishes the same lifecycle events with a parallel `Global` event scope (§3.5, §20.6), and surfaces in the same `lando info`/`lando logs` shapes user apps do — under the `meta:global:*` CLI namespace.

What makes it global, not just another app:

- **Reserved identity.** The id `global` is reserved by core (§20.2). Users cannot name a project `global`.
- **Lando-owned Landofile.** The global Landofile lives at `<userDataRoot>/global/.lando.yml` (§20.3). The canonical layer is plugin-contributed and Lando-managed; the `local` and `user` layers remain available for user override.
- **Plugin contribution surface.** A new `globalServices:` manifest entry (§4.2 row, §20.4) lets a plugin contribute a service definition that materializes into the global Landofile's plugin-contributed `dist` layer at level `plugins`.
- **Cross-app discovery.** The provider's `sharedCrossAppNetwork` capability (§5.4, §10.1) makes `<service>.global.internal` resolve from inside every user-app service. `LANDO_GLOBAL_*` env variables (§6.9) surface the resolved hosts and ports in every user-app service that needs them.
- **Auto-start via `AppFeature.requires.globalServices`.** A user app's `AppFeature` activation (§6.11.4) declares which global services it depends on; the planner ensures those services are running before `app:start` proceeds (§20.6.3).
- **Lifetime decoupled from any one user app.** `apps:poweroff` stops the global app by default (`--keep-global` opts out, §20.7); `app:destroy` of any single user app does **not** touch the global app.
- **Survives `app:destroy`.** Storage at `scope: global` (§6.5) inside global services persists across user-app destroy operations exactly as today; the global app simply makes this scope first-class instead of implicit.

What the global app is **not**:

- Not a daemon. The global app runs services through the active `RuntimeProvider`; Lando itself remains transactional. The deferred persistent agent (§14.2) is a separate concept that may, post-v4.0, hold a warm runtime *for the CLI* — orthogonal to the global app's *services*.
- Not a multiplexer for user-app services. Plugins MAY contribute *new* services to the global app; they MUST NOT promote a user-defined service into it.
- Not a replacement for `ProxyService` or `CertificateAuthority`. Those abstractions still exist in §4.2; their default Live Layers (§20.10) now realize their work *through* a service in the global app.

### 20.2 Identity

| Field | Value | Notes |
|---|---|---|
| `name` | `global` | Reserved literal in the Landofile schema (§7.4); user apps named `global` fail at slug derivation with `AppIdReservedError`. |
| `slug` | `global` | Identical to `name`; no normalization step. |
| `<app-id>` | `global` | Used in cache paths, env vars, provider labels. |
| App root | `<userDataRoot>/global/` | Lando-owned data, not user config (§20.3). |
| Provider | The active default provider | Resolved from global config `defaultProvider:` (§7.5). The global app does not support per-app provider override in v4.0; mixing providers across the host is deferred. |

The `LANDO_*` env contract (§6.9) reserves the namespace `LANDO_GLOBAL_*` for cross-app discovery; service-types and `AppFeature` implementations populate it. Inside the global app's *own* services, `LANDO_APP_NAME` and `LANDO_PROJECT` are literally `global`.

A user-authored Landofile that resolves to `name: global` is rejected at parse time:

```ts
export class AppIdReservedError extends Schema.TaggedError<AppIdReservedError>()(
  "AppIdReservedError",
  { reserved: Schema.String, suggested: Schema.optional(Schema.String) },
) {}
```

The error includes `reserved: "global"` and a remediation telling the user to choose a different `name:`. A user app whose directory basename normalizes to `global` is instructed to set an explicit `name:` per the §7.4 collision policy.

### 20.3 The global Landofile

The global app's Landofile lives at `<userDataRoot>/global/.lando.yml`. The directory acts as the global app's root and follows the §7.2 six-file merge order:

```text
1. <userDataRoot>/global/.lando.base.yml         [advanced]
2. <userDataRoot>/global/.lando.dist.yml          first-class — generated from plugin contributions
3. <userDataRoot>/global/.lando.upstream.yml     [advanced]
4. <userDataRoot>/global/.lando.yml               first-class — user-editable
5. <userDataRoot>/global/.lando.local.yml         first-class — per-host overrides
6. <userDataRoot>/global/.lando.user.yml         [advanced]
```

Layer responsibilities differ from a user app:

- **`.lando.dist.yml` is generated.** `GlobalAppService` (§20.5) regenerates this layer at level `plugins` from the registered `globalServices:` contributions plus the `enabled:` map in `<userConfRoot>/global.config.yml` (§20.3.1). Users MUST NOT edit it; an edit is overwritten on the next `meta:global:rebuild` and `meta:global:install/uninstall`. The file carries a `# DO NOT EDIT — regenerated by Lando` header.
- **`.lando.yml` is user-editable.** Users layer customization here — bumping a service version, adding `routes:`, overriding `appMount:`, contributing extra services that aren't from a plugin. Edited via `meta:global:config edit` (§20.7).
- **`.lando.local.yml` and `.lando.user.yml`** behave the same as user-app layers (per-host, per-user advanced overrides).

The directory is created on demand by `meta:setup` (which calls `GlobalAppService.ensureRoot`); a fresh install with no plugins contributing global services yields a directory containing only the `.lando.dist.yml` file with `name: global` and an empty `services: {}`. The `.lando.yml` canonical file is created lazily on first `meta:global:config set` / `edit` and is empty (`{}`) if no user overrides are present.

#### 20.3.1 The plugin enablement map

`<userConfRoot>/global.config.yml` is a small YAML file that lets the user enable or disable individual `globalServices:` contributions without editing the generated `dist` layer:

```yaml
# <userConfRoot>/global.config.yml
mailpit:        { enabled: true }
traefik:        { enabled: true }
experimental-x: { enabled: false }
```

Behaviors:

- A `globalServices:` contribution declares `enabledByDefault: true|false` (§20.4). The default is `true`. A user override in `global.config.yml` wins.
- `meta:global:install <plugin>` toggles `enabled: true` for every contribution that plugin owns; `meta:global:uninstall <plugin>` toggles `enabled: false`. The commands edit `global.config.yml`, never the generated layer.
- A disabled service is omitted from the generated `.lando.dist.yml` entirely. Disabled is *not* "stopped but plan-resident": the service is removed from the plan, its volumes (at `scope: global`) survive per the §6.5 contract, and re-enabling later picks up the existing volumes.
- Per-service config overlays (`mailpit: { config: { storage: persistent } }`) live in `.lando.yml`, not `global.config.yml`. The map's responsibility is *only* on/off.

#### 20.3.2 Discovery rules

The global app's directory is **not** discoverable through the §7.1 cwd walk or the `cwd-app-map` cache (§12.1). A user `cd`-ing into `<userDataRoot>/global/` does NOT make `lando start` start the global app as if it were the current user app. The discovery rule is:

- `app:*` commands resolve the current user app via the standard discovery path; `<userDataRoot>/global/` is excluded by an exact-path filter in `LandofileService` and the `cwd-app-map` writer.
- `meta:global:*` commands resolve the global app explicitly through `GlobalAppService` (§20.5); they do not consult the discovery walk.
- `apps:list` lists user apps; `apps:list --include-global` includes the global app at the end of the listing.
- `meta:events:follow` (§8.2) carries a synthetic `app: { id: "global", root: <abs> }` ref on every payload sourced from the global app's lifecycle.

This keeps the user mental model clean: `lando start` always means "this project," `lando meta global start` (or `lando global start`) always means "the cross-cutting services."

### 20.4 The `globalServices:` plugin contribution surface

`globalServices:` is the manifest field that lets a plugin contribute a service to the global app's generated `dist` layer.

```yaml
# Plugin manifest excerpt
provides:
  globalServices:
    - id: mailpit                                # service id inside the global Landofile
      module: ./src/global-services/mailpit.ts  # Effect that returns a ServiceConfig
      enabledByDefault: true
      requires:
        providerCapabilities: [sharedCrossAppNetwork]
      conflicts: []
      summary: SMTP capture server with web UI
      commands:                                  # canonical ids of plugin-contributed commands that operate on this service
        - meta:mail:open                         # surfaced in `meta:global:list` so users discover them
        - meta:mail:clear
```

Field semantics:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | The service id inside the global Landofile (`services.<id>`). MUST be unique across every loaded plugin's `globalServices:` contributions; conflicts fail at plugin load with `GlobalServiceCollisionError`. |
| `module` | yes | Path (per the §9.7 module-path containment rules) to a TypeScript module that default-exports an Effect returning a `ServiceConfig` (§6.2). The Effect MAY consume `LandoPluginContext` (§9.8) and the resolved plugin config; it MUST NOT consume the active `RuntimeProvider`. |
| `enabledByDefault` | optional, default `true` | Initial value in `global.config.yml` (§20.3.1) when the plugin is first installed. Subsequent edits are user-owned. |
| `requires.providerCapabilities` | optional | A list of `ProviderCapabilities` keys (§5.4) the contributed service depends on. The planner refuses to materialize the service into the `dist` layer when the active provider does not satisfy the list; the user gets `GlobalServiceCapabilityError` with remediation pointing at provider selection or `--keep-global` operation. `sharedCrossAppNetwork` is required for any service whose value is its DNS-discoverability across user apps; in practice almost every globalService declares it. |
| `conflicts` | optional | A list of other `globalServices.id` values that cannot coexist in the same global app. The classic case: two SMTP capture services. Conflicts surface at the `dist` regenerate step with `GlobalServiceConflictError` and remediation suggesting `meta:global:uninstall <name>`. |
| `summary` | optional | One-line description for `meta:global:list`/`info`. |
| `commands` | optional | List of canonical command ids (`<namespace>:<segments…>`) the plugin contributes that operate on this global service. The ids MUST also appear in the plugin's `provides.commands` block (§9.4) — `commands:` here is a discoverability pointer, not a separate registration. `meta:global:list` (§20.7) renders these alongside the service entry so users learn the plugin's per-service tooling without reading the plugin README. The canonical ids stay under their original namespace (typically `meta:<plugin-cspace>:*` or the plugin's own cspace topic); they do NOT move under `meta:global:*`, which is reserved for core (§20.14). |
| `deprecated` | optional | A `DeprecationNotice` (§18.2) attached to this contribution. Recorded by `DeprecationService` (§18.3) at install. |

**The contributed module shape:**

```ts
// Plugin-side
import { Effect } from "effect";
import type { ServiceConfig, GlobalServiceContext } from "@lando/sdk";

export default Effect.gen(function* () {
  const ctx = yield* GlobalServiceContext;          // typed access to LandoPluginContext + plugin config
  return {
    api: 4,
    type: "mailpit",                                 // resolves through the standard ServiceType registry
    routes: [{ hostname: `mailpit.${ctx.domain}` }], // ctx.domain == resolved global `domain:`
    storage: [{ scope: "global", destination: "/data" }],
    healthcheck: "wget -qO- http://localhost:8025/api/v1/info | grep -q Version",
  } satisfies ServiceConfig;
});
```

Required behaviors:

- The module's Effect runs at level `plugins` during `dist` regeneration. It MUST be pure relative to the global app's persistent state — no provider contact, no socket binds, no `Bun.spawn`. The same purity rules apply that govern Landofile expression evaluation (§7.3.1).
- The returned `ServiceConfig` is validated against the canonical service schema (§6.2) before insertion into the `dist` layer; validation failure surfaces as `GlobalServiceConfigError` with the offending plugin id, contribution id, and the schema diagnostic.
- `module:` paths follow the §9.7 plugin module-path containment rules.
- Plugins MUST NOT register a `globalServices:` entry whose `id` shadows a user-app service id with the same `<service>.<app>.internal` pattern (because both would compete for `mailpit.global.internal` if a user app named `global` existed; §20.2 disallows that anyway, but the validator keeps a defense-in-depth check).
- A plugin contributing a `globalServices:` entry MUST also publish a `ServiceType` for the service's `type:` value (the `mailpit` example above relies on a `mailpit` type also contributed by the same or another plugin). The validator rejects a contribution whose `type:` is unknown at plugin load.
- A plugin MAY pair a `globalServices:` contribution with one or more `appFeatures:` (§6.11.4) that select user-app services and inject env pointing at the global service. This is the canonical pattern (§20.11) and is what makes the user's PHP app automatically discover Mailpit without Landofile changes.

### 20.5 `GlobalAppService` core service

```ts
export class GlobalAppService extends Context.Service<GlobalAppService, {
  readonly id: "global";

  // Path management
  readonly root:       Effect.Effect<AbsolutePath, GlobalAppError>;
  readonly ensureRoot: Effect.Effect<void, GlobalAppError, Scope.Scope>;

  // Plan + lifecycle
  readonly regenerateDist: Effect.Effect<GlobalAppDistResult, GlobalAppError>;
  readonly plan:           Effect.Effect<AppPlan, GlobalAppError>;
  readonly start:    (opts?: GlobalStartOptions)    => Effect.Effect<GlobalAppStatus, GlobalAppError, Scope.Scope>;
  readonly stop:     (opts?: GlobalStopOptions)     => Effect.Effect<void, GlobalAppError>;
  readonly rebuild:  (opts?: GlobalRebuildOptions)  => Effect.Effect<GlobalAppStatus, GlobalAppError, Scope.Scope>;
  readonly destroy:  (opts?: GlobalDestroyOptions)  => Effect.Effect<void, GlobalAppError>;
  readonly info:     (opts?: GlobalInfoOptions)     => Effect.Effect<ReadonlyArray<ServiceInfo>, GlobalAppError>;

  // Auto-start orchestration (called by AppPlanner; §20.6.3)
  readonly ensureRunning: (services: ReadonlyArray<string>) => Effect.Effect<void, GlobalAppError, Scope.Scope>;

  // Plugin enablement (drives §20.3.1 map writes)
  readonly install:   (pluginName: string)               => Effect.Effect<void, GlobalAppError>;
  readonly uninstall: (pluginName: string)               => Effect.Effect<void, GlobalAppError>;
  readonly setServiceEnabled: (id: string, on: boolean)  => Effect.Effect<void, GlobalAppError>;
}>()("@lando/core/GlobalAppService") {}
```

Required behaviors:

- **Bootstrap level:** the service is a member of the AOT-composed `global` bootstrap layer (§20.6, §3.4 membership table). Library-mode hosts MAY construct it directly via `makeLandoRuntime({ bootstrapLevel: "global" })` (§16.3).
- **`Layer.suspend`-wrapped.** Constructing the runtime at level `app` (or higher) does NOT instantiate `GlobalAppService` until something actually requests it. A `lando info` against an already-running user app whose `AppFeature` activations happen to require no global services pays zero `GlobalAppService` cost.
- **One retained provider connection.** Like every other `RuntimeProvider` consumer, `GlobalAppService` reuses the active provider's connection (the same one user apps use); it does not open a second connection.
- **Idempotent `start`/`ensureRunning`.** Calling `start` against an already-running global app reconciles the plan against the running state and reports any drift; `ensureRunning` is the same idempotent semantics scoped to the requested service ids only.
- **`regenerateDist` is the single writer of `.lando.dist.yml`.** Manifest validation, contribution-module evaluation, conflict detection, capability checks, schema validation of every emitted service, and atomic write all happen here. Other code paths read the file but never write it.
- **Errors are tagged.** `GlobalServiceCollisionError`, `GlobalServiceCapabilityError`, `GlobalServiceConflictError`, `GlobalServiceConfigError`, `GlobalServiceUnknownTypeError`, `AppIdReservedError`, plus the umbrella `GlobalAppError` for state transitions.

`GlobalAppService` reuses every existing core service: `LandofileService` for parse/merge, `AppPlanner` for plan derivation, `BuildOrchestrator` for build, `ProxyService` and `CertificateAuthority` for routing/certs (with the §20.10 caveat that `ProxyService`'s default Live Layer is *itself* realized by a global service). Treating the global app as "just an app" with one extra orchestrator on top is the design's north star.

### 20.6 Lifecycle

#### 20.6.1 The `global` bootstrap level

A new `global` bootstrap level slots between `provider` and `app` in the §3.2 ladder:

| Level | Adds | Used by |
|---|---|---|
| `provider` | (unchanged) | `meta:setup`, `apps:poweroff`, `apps:list --all` |
| **`global`** | `GlobalAppService` (eager); `AppPlanner` constructed in single-app form bound to the global Landofile; `BuildOrchestrator` (lazy via `Layer.suspend`) | `meta:global:start`, `meta:global:stop`, `meta:global:info`, `meta:global:logs`, `meta:global:rebuild`, `meta:global:destroy`, `meta:global:install`, `meta:global:uninstall` |
| `app` | (unchanged) `AppPlanner`, `LandofileService` for the user app | `app:start`, `app:stop`, etc. |

Service-membership-per-bootstrap-level addendum to §3.4:

| Level | Eager additions | Lazy additions |
|---|---|---|
| `global` | `GlobalAppService` | `BuildOrchestrator`, `HealthcheckRunner`, `UrlScanner`, `HostProxyService` (only if the global app's plan declares the `lando.host-proxy` feature on a global service — uncommon) |

`app` bootstrap *includes* `global` because user-app start needs `GlobalAppService.ensureRunning` available. The standard `lando start` path therefore initializes `GlobalAppService` even when no `AppFeature` activations require a global service; the cost is bounded by `Layer.suspend` — `regenerateDist` and `plan` are not called unless `ensureRunning` actually needs to start something.

**`bootstrap: global` on a `LandoCommandSpec`** is a new value in the §8.3 enum. Plugins MAY use it for commands under their own namespace or cspace topic that operate on the global app through `GlobalAppService`; `meta:global:*` canonical ids remain reserved for core (§20.7, §20.14).

#### 20.6.2 Lifecycle event scope

A new **`Global`** scope joins the §3.5 event taxonomy:

| Scope | Standard events |
|---|---|
| Global | `pre-global-start`, `post-global-start`, `pre-global-stop`, `post-global-stop`, `pre-global-rebuild`, `post-global-rebuild`, `pre-global-destroy`, `post-global-destroy`, `pre-global-dist-regenerate`, `post-global-dist-regenerate` |

Events follow the same shape as the App scope and use canonical command ids on the CLI side (`cli-meta:global:start-init`, `-run`, `-error`). Payload schemas mirror the App scope's:

```ts
export const PreGlobalStartEvent = Schema.TaggedStruct("pre-global-start", {
  app: AppRef,                                         // id is literally "global"
  plan: AppPlan,
  triggeredBy: Schema.Union(
    Schema.Literal("meta:global:start"),
    Schema.Literal("apps:poweroff"),
    Schema.Literal("ensure-running"),                  // auto-start from a user-app dependency
    Schema.Literal("meta:setup"),
  ),
  ensuringServices: Schema.Array(Schema.String),       // services this invocation is checking; empty when not ensure-running
  cached: Schema.Boolean,                              // true iff every service in ensuringServices was already running+healthy and no work was performed
  timestamp: Schema.DateTimeUtc,
});
export type PreGlobalStartEvent = Schema.Schema.Type<typeof PreGlobalStartEvent>;
```

**Always-emit semantics.** `pre-global-start` and `post-global-start` MUST fire for every `GlobalAppService.ensureRunning` invocation, including the warm-cache case where every needed service is already running and healthy. The warm case fires with `cached: true` and the `ensuringServices` array still populated so subscribers see *what was checked*; the body of the orchestration is a fast no-op (no `regenerateDist`, no provider contact, no `pre-build` event scope). Suppressing the events on the warm path was rejected because (a) the §11.1 zero-subscriber short-circuit makes publishing essentially free when nothing is listening, (b) telemetry, audit, and executable-guide scenario transcripts need a predictable "every user-app start emits exactly this sequence" contract, and (c) consistency with the App scope, where `pre-start` always fires whether services are warm or cold. Subscribers that want to act only on cold-path starts gate their work on `event.cached === false`. Manual invocations from `meta:global:start` (no `triggeredBy: "ensure-running"`) always fire with `cached: false` because the user explicitly asked for the orchestration to run.

`pre-/post-global-dist-regenerate` carry the contribution diff:

```ts
export const PreGlobalDistRegenerateEvent = Schema.TaggedStruct("pre-global-dist-regenerate", {
  triggeredBy: Schema.Union(
    Schema.Literal("plugin-install"),
    Schema.Literal("plugin-remove"),
    Schema.Literal("plugin-update"),
    Schema.Literal("meta:global:install"),
    Schema.Literal("meta:global:uninstall"),
    Schema.Literal("config-edit"),
    Schema.Literal("setup"),
  ),
  contributions: Schema.Array(Schema.Struct({
    plugin: Schema.String,
    id:     Schema.String,
    enabled: Schema.Boolean,
    capabilitiesSatisfied: Schema.Boolean,
  })),
  timestamp: Schema.DateTimeUtc,
});
```

The `Build` event scope (§3.5, §6.13) fires inside the global app's start path exactly as it does for user apps, so global service builds get the same task-tree UI (§8.9.2), the same per-step transcripts (§12.4 — written under `<userDataRoot>/builds/global/...`), and the same `buildKey` up-to-date check (§6.13.5).

#### 20.6.3 Auto-start integration with user apps

When a user runs `app:start` for a user app, the planner walks the resolved plan's active `AppFeature` activations. Each feature's manifest MAY declare:

```ts
// In the app-feature manifest entry (§6.11.4)
export interface AppFeatureDefinition {
  // ...existing fields
  readonly requires?: {
    readonly providerCapabilities?: ReadonlyArray<keyof ProviderCapabilities>;
    readonly globalServices?: ReadonlyArray<string>;     // ids of global-app services this feature needs
  };
}
```

The planner aggregates `requires.globalServices` across every activated `AppFeature` for the current user app and yields a `ReadonlySet<string>` of needed global service ids. During the user app's `pre-start` phase, after early `pre-start` subscribers and before the user-app build block, the lifecycle orchestrator calls `GlobalAppService.ensureRunning(needed)`:

- `ensureRunning` ALWAYS publishes `pre-global-start` and `post-global-start` (§20.6.2) regardless of warm/cold state, so subscribers get a predictable per-start signal; the events carry `ensuringServices: needed` and `triggeredBy: "ensure-running"`.
- If the global app is already running and every needed service is `running`+`healthy`, the events fire with `cached: true` and the user-app `pre-start` proceeds immediately. No `regenerateDist`, no provider contact, no `pre-build` block fires inside `pre-global-start`.
- If the global app is not running (or any needed service is not yet healthy), `ensureRunning` triggers a `start({ services: needed })` and the events fire with `cached: false`. The user-facing renderer surfaces a "Starting global services for <app>" task tree alongside the user app's start; a `pre-build` block fires inside `pre-global-start` only when the global app's `BuildOrchestrator` finds a build step that's not up-to-date.
- If a needed service is not in the resolved global plan (the user disabled it, or the plugin contributing it is not installed), `ensureRunning` publishes `pre-global-start` then fails with `GlobalServiceMissingError`; the user-app `pre-start` aborts with remediation pointing at `meta:global:install <plugin>`. `post-global-start` does NOT fire on this failure path; instead `cli-app:start-error` carries the underlying `GlobalServiceMissingError`.

The dependency is **transitive** through `AppFeature.requires.globalServices` only. There is no Landofile syntax for a user to directly declare "my app needs `global:mailpit`" — the contract goes through `AppFeature` activations. This keeps the user mental model one-way: the user installs a plugin, the plugin's feature activates and injects env, the user's app gets the service for free. (§14.2 lists the explicit-`dependsOn` escape hatch as deferred.)

#### 20.6.4 Standard event sequence

Cold `lando start` against a user app whose plan requires `global:mailpit` and `global:traefik` (cold = neither service running yet):

```text
… (bootstrap-minimal..bootstrap-app per §11.4)
post-bootstrap
ready
cli-app:start-init
pre-init
post-init
pre-start
  pre-global-start { triggeredBy: "ensure-running", ensuringServices: ["mailpit", "traefik"], cached: false }
    pre-build (global)         (only fires when at least one service has a non-cached build step)
      …                                                                 (per §6.13)
    post-build (global)
    post-global-start { cached: false }
  pre-build (user-app)
    …
  post-build (user-app)
post-start
…
cli-app:start-run
before-exit
```

Warm `lando start` against the same user app, with both global services already running and healthy:

```text
… (bootstrap-minimal..bootstrap-app per §11.4)
post-bootstrap
ready
cli-app:start-init
pre-init
post-init
pre-start
  pre-global-start { triggeredBy: "ensure-running", ensuringServices: ["mailpit", "traefik"], cached: true }
  post-global-start { cached: true }                                    (no pre-build/post-build inside)
  pre-build (user-app)
    …
  post-build (user-app)
post-start
…
cli-app:start-run
before-exit
```

The `pre-global-start` … `post-global-start` block ALWAYS fires inside `pre-start` (§20.6.2 always-emit semantics). The `cached:` field on the payload distinguishes warm and cold; when `cached: true`, no `pre-build` block fires inside the pair and the body is a fast no-op. Subscribers that need to react before the global app starts cold (e.g., a custom observability sidecar) register at `pre-start` priority `early` and gate their work on `event.cached === false`; subscribers that react after the global app is ready and before the user-app build register at `pre-start` priority `default`.

`apps:poweroff` (default behavior — stop everything):

```text
cli-apps:poweroff-init
  pre-stop (foo)
    …
  post-stop (foo)
  pre-stop (bar)
    …
  post-stop (bar)
  pre-global-stop { triggeredBy: "apps:poweroff" }
    …
  post-global-stop
cli-apps:poweroff-run
```

`apps:poweroff --keep-global` skips the `pre-global-stop` block and reports "kept global app running" in the renderer's final summary.

### 20.7 CLI surface (`meta:global:*`)

The global app gets its own CLI subtree under the `meta:` namespace. Default top-level aliases use the `global:` prefix so they don't shadow the user-app aliases (`start`, `stop`, etc.) that operate on the current project.

| Canonical id | Default top-level alias | Bootstrap | Summary |
|---|---|---|---|
| `meta:global:config` | `global:config` | `minimal` | Read/write the global Landofile (`<userDataRoot>/global/.lando.yml`) and the plugin enablement map. Mirrors `app:config` (§8.2.1). |
| `meta:global:destroy` | `global:destroy` | `global` | Stop and tear down the global app's services and resources. Storage at `scope: global` survives unless `--purge` is passed. Requires confirmation unless `--yes`. |
| `meta:global:info` | `global:info` | `global` | Print global service runtime information. Supports `--service`, `--format`. |
| `meta:global:install` | `global:install` | `global` | Enable every `globalServices:` contribution from a named plugin (writes `global.config.yml`, regenerates `dist`, no service start). Pair with `meta:global:start` to bring up the new services. |
| `meta:global:list` | `global:list` | `minimal` | List every contributed global service with its `enabled:` state, source plugin, current status, and the canonical ids of plugin-contributed commands that operate on it (declared via the `commands:` field on the `globalServices:` contribution; §20.4). Replaces the v3-style "is Traefik running?" question with a single source of truth and gives users a discoverability surface for per-service tooling without reading each plugin's README. |
| `meta:global:logs` | `global:logs` | `global` | Stream global service logs. Supports `--service`, `--follow`, `--tail`, `--since`. Mirrors `app:logs` (§8.2). |
| `meta:global:rebuild` | `global:rebuild` | `global` | Stop, rebuild artifacts, and restart global services. Same up-to-date-check semantics as `app:rebuild` (§6.13.5). |
| `meta:global:restart` | `global:restart` | `global` | `meta:global:stop` + `meta:global:start`. |
| `meta:global:start` | `global:start` | `global` | Start the global app. Without `--service`, starts every enabled service; with `--service <id>` (repeatable), starts a subset. |
| `meta:global:stop` | `global:stop` | `global` | Stop the global app's services. Without `--service`, stops every running service. |
| `meta:global:uninstall` | `global:uninstall` | `global` | Disable every `globalServices:` contribution from a named plugin (writes `global.config.yml`, regenerates `dist`, stops affected services). |

Example `meta:global:list` output:

```text
SERVICE   PLUGIN                      STATUS    COMMANDS
mailpit   @lando/service-mailpit      running   mail:open, mail:clear
traefik   @lando/proxy-traefik        running   traefik:reload, traefik:logs
```

The COMMANDS column lists the top-level alias for each canonical id declared in the contribution's `commands:` field; `meta:global:list --format json` returns the canonical ids unchanged so embedding hosts and CI scripts get an unambiguous shape.

Behavioral requirements:

- `meta:global:start` (and the auto-start path) refuses to run when `<userDataRoot>/global/.lando.dist.yml` is missing and there are no contributions to materialize; the user is told to run `meta:setup` or install at least one plugin that contributes a global service.
- `meta:global:list --format json` is the canonical machine-readable shape of "what's available in the global app on this host"; embedding hosts and CI scripts MUST use it instead of parsing the rendered table.
- `meta:global:install <plugin>` and `meta:global:uninstall <plugin>` accept either the plugin's package name (`@lando/service-mailpit`) or any of its `globalServices.id` values (`mailpit`, `traefik`). Disambiguation: if multiple plugins contribute the same id (caught at load with `GlobalServiceCollisionError`), the install/uninstall command refuses with remediation listing both plugins.
- `meta:global:config` follows the `app:config` semantics in §8.2.1 with one substitution: writes target `<userDataRoot>/global/.lando.yml` (the user-editable canonical layer). The `.lando.dist.yml` layer is read-only from this command — `meta:global:config edit --target dist` is rejected with `GlobalDistReadOnlyError` and remediation pointing at the contributing plugin's manifest.

The `apps:poweroff` flag list (§8.2) is amended:

```text
lando apps poweroff [--keep-global] [--yes]
```

`--keep-global` suppresses the trailing `pre-global-stop`…`post-global-stop` block. The CLI help spells the default explicitly: "Stops every Lando-managed service across user apps and the global app. Use `--keep-global` to leave the global app's services running."

#### 20.7.1 Top-level alias reservation

The §8.1.2 alias-collision policy reserves the `global:` prefix for the `meta:global:*` defaults listed above. Plugin-contributed top-level aliases that begin with `global:` collide with the built-ins and are rejected with `CommandAliasConflictError`. User overrides via `commandAliases.custom:` MAY remap a `global:*` alias to a user-defined tooling task (escape hatch for users who want `lando global:start` to do something else in their app context); the underlying `meta:global:start` canonical id is always callable directly.

### 20.8 Networking and discovery

#### 20.8.1 DNS

`<service>.global.internal` resolves to the global service's container IP from inside any user-app service when the active provider declares `sharedCrossAppNetwork: true` (§5.4, §10.1). This is the single canonical address shape; `<service>.global` and bare `<service>` are NOT supported (the latter would conflict with the user app's own service names).

Providers that declare `sharedCrossAppNetwork: false`:

- The planner refuses to plan any `globalServices:` contribution whose `requires.providerCapabilities` includes `sharedCrossAppNetwork`. The contribution is dropped from the `dist` layer with a `GlobalServiceCapabilityError` recorded by `DoctorService` (§3.4) and a one-line warning at `meta:global:start`.
- `meta:global:list` shows the contribution as `disabled: capability-mismatch` with a remediation note.
- A user can still run `meta:global:install` on the affected plugin, but the corresponding services stay in the "want enabled, can't satisfy" state; `meta:global:list --json` exposes this through a `state: "blocked"` field for tooling.

#### 20.8.2 Environment variables

The §6.9 `LANDO_*` contract gains a new family populated for every user-app service whose plan resolves a dependency on a global service:

```text
LANDO_GLOBAL_<SERVICE>_HOST          # always; resolves to <service>.global.internal
LANDO_GLOBAL_<SERVICE>_PORT          # primary endpoint port; conditional
LANDO_GLOBAL_<SERVICE>_<EP>_PORT     # named endpoint port (e.g., LANDO_GLOBAL_MAILPIT_SMTP_PORT)
LANDO_GLOBAL_<SERVICE>_URL           # primary route URL; conditional
LANDO_GLOBAL_<SERVICE>_<KEY>         # plugin-defined extras (e.g., LANDO_GLOBAL_MAILPIT_API_TOKEN)
```

Population rules:

- The relevant `AppFeature` (§6.11.4) is what *declares* a dependency via `requires.globalServices: ["mailpit"]`. The planner walks every activated `AppFeature` for the user app, collects the set of needed global service ids, and resolves the corresponding `LANDO_GLOBAL_*` triplet from the global app's resolved `ServicePlan`.
- Plugins that want to expose extra fields (a Mailpit API token, a MinIO access key) declare them through their `AppFeature.apply()` body using the standard `addEnv` mutator: the AppFeature reads `services.<id>.creds` or `services.<id>.config.<key>` (cross-app via the §7.3.1 expression scope, lifted to the global app) and writes the env into the user-app service.
- `LANDO_GLOBAL_*` is intentionally a *projection* — only the values the user app's features actually depend on appear. A user app whose features don't activate Mailpit doesn't get `LANDO_GLOBAL_MAILPIT_*` populated.

#### 20.8.3 Cross-service expression scope addendum

The §7.3.1 cross-service expression scope is extended:

| Scope | Min bootstrap level | Source |
|---|---|---|
| `globalServices.<name>.{type,primary,creds,hostnames,routes,endpoints}` | `app` (the user-app planner reads it) | Read-only view of a global service's resolved plan. The named service must exist in the global app's plan and be in the user app's `AppFeature.requires.globalServices` list; any other reference fails with `ConfigExpressionScopeNotPermittedError` to avoid implicit cross-app coupling. |

This means an `AppFeature.apply()` body can write:

```ts
ctx.addEnv("MAIL_HOST", "{{ globalServices.mailpit.hostnames[0] }}");
ctx.addEnv("MAIL_PORT", "{{ globalServices.mailpit.endpoints.smtp.port }}");
```

…and the planner resolves it at level `app` against the live global plan.

### 20.9 Storage

The §6.5 storage scopes are unchanged. The clarifications:

| Scope inside a global service | Behavior |
|---|---|
| `service` | Owned by the one global service. Auto-name `global-<service>-<destination>`. Removed by `meta:global:destroy --purge`. |
| `app` | Shared across global services. Auto-name `global-<destination>`. Removed by `meta:global:destroy --purge`. |
| `global` | Shared with user apps' services that also declare `scope: global`. Auto-name `lando-<destination>` (matches §6.5). Survives `meta:global:destroy` even with `--purge`; only `meta:uninstall` (§17.7) removes it. |

`meta:global:destroy` without `--purge` removes container instances and `service`-scoped volumes but preserves `app`-scoped and `global`-scoped volumes (so reinstalling the same plugin recovers state). With `--purge`, `service`- and `app`-scoped volumes go too.

Provider labels (§6.5) on volumes created by global services:

```text
dev.lando.storage-volume:  "TRUE"
dev.lando.storage-scope:   <scope>
dev.lando.storage-project: "global"               # set for service/app scope; absent for scope: global
dev.lando.storage-service: <service>              # set for service scope only
dev.lando.storage-global-app: "TRUE"              # additional marker so apps:poweroff --keep-global can identify them
```

### 20.10 Proxy and CA realization through the global app

This subsection specifies the §1.3 "full unification" promise: the default `ProxyService` Live Layer in v4 realizes its work through a service in the global app, not through an out-of-band container managed by the proxy plugin.

#### 20.10.1 Default `ProxyService` Live Layer

```ts
// Bundled with @lando/proxy-traefik (§1.4)
export const ProxyServiceTraefikGlobalAppLive = Layer.effect(
  ProxyService,
  Effect.gen(function* () {
    const global = yield* GlobalAppService;
    // implementation reaches the running `traefik` global service via the active RuntimeProvider's exec/file-write
    // primitives and applies dynamic Traefik config files mounted into the service's appMount tree.
    return makeProxyServiceImpl({ global, /* ... */ });
  }),
);
```

Required behaviors:

- The plugin `@lando/proxy-traefik` contributes BOTH a `globalServices:` entry (id `traefik`, enabledByDefault `true`) AND a `proxyServices:` entry whose Live Layer talks to the `traefik` global service. The two contributions ship together; installing one without the other is rejected at plugin load with `ProxyContributionPairError`.
- `ProxyService.applyRoutes(routes, app)` writes the dynamic Traefik config under a Lando-managed directory mounted into the `traefik` global service via the standard `mounts:` machinery. The plugin author owns the on-disk format; core only owns the `RoutePlan` schema.
- `ProxyService.setup` calls `GlobalAppService.ensureRunning(["traefik"])` so the *first* `lando start` automatically brings the proxy up. The recurrent path (proxy already running) is the same warm no-op as any other `ensureRunning` call.
- The §10.2 proxy interface is unchanged; only the realization moved. Plugin authors who ship an alternative `ProxyService` (for an environment without a global app, e.g., a remote proxy) MAY contribute a Live Layer that does NOT touch `GlobalAppService`. Selection follows the standard §4.3 precedence: explicit Landofile `proxy:`, global config `defaultProxyService:`, plugin `defaultFor:` matchers, sole installed implementation.

#### 20.10.2 `CertificateAuthority` realization

The default `@lando/ca-mkcert` plugin remains a `CertificateAuthority` implementation; v4.0 does NOT migrate it into a global-app service. The CA is a host-level credential store, not a runtime service, and bundling it into the global app would gain little (no proxy round-trip needed; mkcert is invoked at setup time and its trust-store install runs through `PrivilegeService`).

A future plugin MAY contribute a global-app-resident CA service (e.g., for environments without `mkcert` host elevation); the architecture preserves the option through the standard §4.2 `CertificateAuthority` swap mechanism.

#### 20.10.3 Migration policy

A user who upgrades from a pre-§20 build to a v4 build with §20 implemented:

- The first `lando start` after the upgrade triggers `meta:setup` (or surfaces a remediation if setup is skipped) which generates `<userDataRoot>/global/.lando.yml` and `<userDataRoot>/global/.lando.dist.yml` from the installed plugin contributions.
- A previously-running v3-style proxy container (managed out-of-band by the old proxy plugin) is surfaced two ways:
  - **Read-only doctor diagnostic** `LegacyProxyContainerDetected` (§20.13) — surfaces in `lando doctor` output with remediation pointing at the plugin-supplied `meta:setup --migrate-proxy`. The diagnostic does not block any command on its own.
  - **Hard error at `meta:setup` and at first `meta:global:start`** as `LegacyProxyContainerConflictError` (§20.13). The global app's `traefik` service refuses to start while a legacy proxy container is present, because both would compete for ports 80/443/8443 and leave the host in a half-migrated state. The user MUST run the plugin-supplied migration (or manually `docker rm` / `podman rm` the legacy container) before the global proxy can come up.
- The hard error is provider-aware (the diagnostic side scans labels via the active `RuntimeProvider`'s metadata API and matches against an allowlist of v3-era proxy container labels published by the proxy plugin's manifest); core does not know the v3 container labels itself, but the failure path is core-owned so users can never silently end up with two proxies running.
- The migration command (`meta:setup --migrate-proxy`) is plugin-supplied. Core defines only (a) the diagnostic shape, (b) the hard-error shape, and (c) the contract that `meta:global:start` and `meta:setup` MUST consult the diagnostic before any `traefik` (or otherwise-named) global proxy service starts. Plugin authors who replace `@lando/proxy-traefik` with an alternative proxy MUST publish the same legacy-container detection contract so v3-era containers from any prior proxy plugin are caught.
- Users on the §20 implementation never see the legacy container after migration; the diagnostic clears once the legacy container is removed.

### 20.11 Plugins that contribute to the global app

#### 20.11.1 `@lando/service-mailpit` (canonical reference)

The bundled Mailpit plugin (added to the §1.4 reference bundle) is the canonical example of a global-app contribution paired with an `AppFeature`:

```yaml
# plugins/service-mailpit/plugin.yaml — excerpt
name: "@lando/service-mailpit"
version: "1.0.0"
api: 4

provides:
  serviceTypes:
    - name: mailpit
      module: ./src/service-types/mailpit.ts
      versions: ["latest", "v1"]
      base: lando

  globalServices:
    - id: mailpit
      module: ./src/global-services/mailpit.ts
      enabledByDefault: true
      requires:
        providerCapabilities: [sharedCrossAppNetwork]
      conflicts: [mailhog]

  appFeatures:
    - id: mailpit-smtp-injection
      module: ./src/app-features/mailpit-injection.ts
      priority: 800
      activatedBy:
        services:
          type: php                 # also matches: node, python, ruby, ...
      selectors:
        framework: [drupal, wordpress, laravel, symfony, magento, django, fastapi, rails]
      requires:
        globalServices: [mailpit]

# tooling contribution: `lando mail:open` opens mailpit's web UI in the host browser
  commands:
    - id: meta:mail:open
      namespace: meta
      module: ./src/commands/mail-open.ts
      topLevelAlias: "mail:open"
```

User experience after `lando plugin add @lando/service-mailpit`:

1. The plugin install triggers `GlobalAppService.regenerateDist`; `<userDataRoot>/global/.lando.dist.yml` gains a `mailpit` service.
2. The next `lando start` for any user app whose plan activates the `mailpit-smtp-injection` `AppFeature` (a Drupal site, a WordPress site, a Laravel project, etc.) triggers `GlobalAppService.ensureRunning(["mailpit"])`; Mailpit comes up alongside the user's services.
3. Inside the user's PHP service, `MAIL_HOST=mailpit.global.internal` and `MAIL_PORT=1025` are set; the framework picks them up.
4. The user opens `https://mailpit.lndo.site` (the global service's default route) and sees captured mail.
5. `lando mail:open` (the `meta:mail:open` top-level alias) opens the same URL through `HostProxyService` (§10.10) so it works from inside an interactive container shell too.

The user wrote zero Landofile content. The plugin author wrote one `globalServices:` entry, one `AppFeature`, one `ServiceType`, and one tooling command.

#### 20.11.2 Migration of `@lando/proxy-traefik`

The proxy-traefik plugin gains a `globalServices:` entry alongside its existing `proxyServices:` entry per §20.10.1. Users see no change in behavior; `lando meta global info` now shows the `traefik` service alongside any other plugin-contributed global services, and `lando meta global logs traefik --follow` is the canonical way to debug routing issues (replacing the v3-era `docker logs <container-name>`).

### 20.12 Discovery and resolution rules

A summary of the resolution rules this part establishes; the canonical source for each rule is the section listed.

| Rule | Source |
|---|---|
| `name: global` is reserved at Landofile parse time. | §20.2 |
| `<userDataRoot>/global/` is excluded from cwd-based app discovery. | §20.3.2 |
| Plugin `globalServices:` ids are globally unique across loaded plugins. | §20.4 |
| `globalServices.<id>.requires.providerCapabilities` is enforced at `dist` regenerate. | §20.4 |
| `AppFeature.requires.globalServices` drives auto-start inside `pre-start`, before the user-app build block. | §20.6.3 |
| `apps:poweroff` stops the global app by default; `--keep-global` opts out. | §20.7 |
| `meta:global:*` aliases reserve the `global:` top-level prefix. | §20.7.1 |
| `<service>.global.internal` requires `sharedCrossAppNetwork`; otherwise the contribution is dropped from the plan with a doctor warning. | §20.8.1 |
| `LANDO_GLOBAL_<SERVICE>_*` env vars are projected from the user app's `AppFeature.requires.globalServices` set. | §20.8.2 |
| `globalServices.<name>.*` cross-service expression scope is restricted to the user app's required globals. | §20.8.3 |
| `scope: global` storage survives `meta:global:destroy --purge`. | §20.9 |
| Default `ProxyService` Live Layer realizes routes through the `traefik` global service. | §20.10.1 |

### 20.13 Errors

Tagged errors specific to the global app live in `@lando/core/errors`:

- `AppIdReservedError` — a Landofile resolves to `name: global` (or to a slug normalizing to `global`). Payload: `{ reserved, suggested? }`.
- `GlobalServiceCollisionError` — two plugins contribute the same `globalServices.id`. Payload: `{ id, plugins: ReadonlyArray<string> }`.
- `GlobalServiceCapabilityError` — a contribution requires a provider capability the active provider does not satisfy. Payload: `{ id, plugin, missing: ReadonlyArray<keyof ProviderCapabilities> }`.
- `GlobalServiceConflictError` — two enabled contributions declare each other in `conflicts:`. Payload: `{ idA, idB }`.
- `GlobalServiceConfigError` — a contribution's emitted `ServiceConfig` fails schema validation. Payload: `{ id, plugin, schemaError }`.
- `GlobalServiceUnknownTypeError` — a contribution's `type:` is not a known `ServiceType` at plugin load. Payload: `{ id, plugin, type, suggestions }`.
- `GlobalServiceMissingError` — a user app's `AppFeature.requires.globalServices` references a global service id that is not in the resolved plan (disabled, unknown, or capability-blocked). Payload: `{ neededBy: AppFeatureId, app: AppRef, missing: ReadonlyArray<string> }`.
- `GlobalDistReadOnlyError` — a write target that resolves into the generated `dist` layer was attempted via `meta:global:config`. Payload: `{ path }`.
- `GlobalServiceCommandReferenceError` — a `globalServices:` entry's `commands:` field references a canonical command id that does not appear in the same plugin's `provides.commands` block. Payload: `{ plugin, serviceId, missingCommandId }`. Caught at plugin load; the plugin fails to register until the manifest is consistent.
- `ProxyContributionPairError` — `@lando/proxy-traefik` (or any plugin replacing it) contributes a `proxyServices:` entry without a paired `globalServices:` entry of the expected id, or vice versa. Payload: `{ plugin, missingSide }`.
- `LegacyProxyContainerDetected` — Read-only `lando doctor` diagnostic reporting an out-of-band proxy container from a pre-§20 install. Payload: `{ containerId, name, remediation }`. Informational; does not block commands.
- `LegacyProxyContainerConflictError` — Hard error raised at `meta:setup` and at first `meta:global:start` when the same condition the diagnostic detects is present. Refuses to start the global proxy service to prevent a half-migrated host where the legacy container and the new global-app `traefik` service would compete for ports. Payload: `{ containerId, name, conflictingService, remediation, migrationCommand }`. The migration command is plugin-supplied per §20.10.3.
- `GlobalAppError` — umbrella for state-transition failures (start failed, stop failed, plan derivation failed). Payload: `{ phase, cause }`.

### 20.14 Non-goals for v4.0

The global app concept opens design space we are deliberately NOT shipping in v4.0:

- **Multi-host shared global app.** Each host has one global app; the spec does not provide a distributed/shared registry of global services across machines.
- **User-controlled Landofile path.** The global app's root is `<userDataRoot>/global/` per §20.3; users cannot relocate it via global config in v4.0. (The `<userDataRoot>` itself is overridable per §7.5; relocating that relocates the global app's root with it.)
- **Per-app provider override for the global app.** The global app uses the active default provider. A user with multiple apps targeting different providers gets a single-provider global app; cross-provider global services are deferred to the same release that lifts the multi-provider non-goal in §5.9.
- **Explicit Landofile `dependsOn: ["global:<service>"]`.** User apps depend on global services through `AppFeature.requires.globalServices` only. A direct Landofile shape is open-decisioned in §14.2 and may land later.
- **Promoting a user-app service to global.** Plugins may contribute to the global app; users cannot ad-hoc move `services.foo` from their user app into the global app. The plugin contribution surface is the only path.
- **Plugin contribution of new `meta:global:*` commands.** The `meta:global:*` namespace is reserved for core in v4.0. Plugins may contribute commands under their own cspace topic that operate on the global app via `GlobalAppService` (e.g., `traefik:reload`); they MUST NOT register canonical ids under `meta:global:*`.
- **Sandboxing.** Like every plugin in v4.0, `globalServices:` contributions run with host permissions; there is no sandbox.

---
