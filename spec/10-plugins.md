# Lando v4 — Plugin Specification

> **Part 10 of 17** · [Index](./README.md)
> **Read next:** [11 Subsystems](./11-subsystems.md)

This part is the contract for plugin authors. A v4 plugin is a Bun-loadable package with a manifest declaring its public surface entirely through a `provides:` block. Side-effecting top-level code is forbidden and rejected at load.

Covered here: plugin identity (manifest locations, distribution forms via `PluginSource` adapters), runtime rules (ESM only, no sandbox in v4.0.0, manifest-declared surface), discovery order across bundled/system/user/app-local sources, trusted app-scoped plugin resolution at app build time, the full manifest schema (config, provides, subscribers, requires, conflicts) including command-namespace and top-level-alias rules per §8.1, the contribution surfaces table mapping each surface to its loader, the install/update flow for `meta:plugin:add` / `meta:plugin:remove` / `meta:update` (top-level aliases `lando plugin add`, `lando plugin remove`, `lando update`), plugin loading rules including lazy-load behavior under the compiled binary, and the constrained `LandoPluginContext` that plugins receive instead of internal core objects.

For *what* is pluggable, see [04 Pluggability](./04-pluggability.md). This part is *how* to author.

---

## 9. Plugin Specification

### 9.1 Plugin identity

A v4 plugin is a Bun-loadable package with:

- A `package.json` containing at least `name` and `version`.
- A manifest in one of: `package.json#lando`, `plugin.yaml`, `plugin.yml`, `plugin.json`, or `plugin.ts`/`plugin.js`.
- `api: 4` in the manifest.

The `lando-plugin` keyword in `package.json#keywords` marks registry packages as discoverable when the manifest is not in `package.json#lando`.

**Distribution forms** (via `PluginSource` adapters):

- Registry package (`bun add` / `npm install` semantics).
- Local directory (`file:`).
- Git URL or shorthand (`git+https://...`, `gh:user/repo`).
- Remote tarball (`https://...`).
- Bundled (statically imported into the compiled CLI binary).

### 9.2 Plugin runtime rules

- ESM is the preferred plugin authoring format. Plugin entry modules SHOULD be ESM.
- TypeScript entries are allowed when Bun can load them directly. Build outputs are also accepted.
- CommonJS is supported through the plugin loader's interop layer; CommonJS authoring is not encouraged.
- Plugins receive a constrained `LandoPluginContext`, not internal core objects.
- Plugins MAY return Effect Layers, plain values, or factory functions; the loader normalizes to Layers.
- Plugin code runs with host permissions. There is no sandbox in v4.0.0.
- Plugins MUST declare their public surface entirely through the manifest's `provides:` block. Manifest validation, compatibility checks, and module path containment run before any plugin module is imported.
- Core does not promise to detect arbitrary top-level side effects in JavaScript. Plugin authors SHOULD keep module top levels cheap and side-effect-light because imports are lazy but still execute as trusted host code.

### 9.3 Discovery order

```text
1. Bundled plugins (statically imported into the binary)
2. System plugins (`<systemPluginRoot>/plugins/*`)
3. User plugins (`<userDataRoot>/plugins/*`)
4. App-local `pluginDirs:` (Landofile)
5. Explicit Landofile `plugins:` (with source spec)
6. Experimental plugins (when `experimental: true`)
```

Later sources override earlier sources unless dependency constraints forbid it. `disablePlugins:` removes a plugin before resolution.

App-local plugins are trusted by design. A Landofile that declares `pluginDirs:` or `plugins:` is opting into those plugins with the same host permissions as user-installed plugins; core does not prompt separately for app-local plugin execution in v4.0.0.

`pluginDirs:` are local directories and never require network access. `plugins:` entries are app-scoped plugin dependencies. They are resolved during app materialization/build (typically the first `lando start` or any later `lando rebuild` after plugin declarations change), installed into an app-scoped plugin store under `<userDataRoot>`, and locked in `.lando.lock.yml` (§7.7.4). Once resolved, normal app startup uses the locked local copy and MUST NOT contact the plugin source unless the lockfile changes, the cached package is missing/corrupt, or the user explicitly requests an update.

**CLI vs library mode.** The order above is the default for the **CLI** imperative shell. Embedding hosts (§16) opt into each source independently; by default, library-mode runtimes have **no** plugins beyond what the host explicitly contributes. This is enforced in `makeLandoRuntime`'s `plugins.discovery` policy (§16.4). The discovery pipeline itself is identical in both modes — only the per-source enable flags differ. A host that wants CLI-equivalent discovery passes `discovery: { bundled: true, system: true, user: true, app: true }` and the resolver behaves exactly as it does for the CLI.

### 9.4 Manifest schema

```yaml
name: "@lando/example"
version: "1.0.0"
api: 4
description: Example plugin
enabled: true
updateable: true
cspace: example                          # used in plugin command namespacing

# Optional: deprecate the whole plugin (§18). When set, every contribution
# this plugin provides records a `deprecation-used` event with `kind: "plugin"`.
deprecated:
  since: "4.2.0"
  removeIn: "5.0.0"
  replacement: "@lando/example-next"
  note: "Replaced by @lando/example-next which targets the new provider extension API."

# Plugin-level config schema
config:
  schema: ./src/config.schema.ts         # exports an Effect Schema
  defaults:
    foo: bar

# Public contributions
provides:
  providers:
    - id: lando
      module: ./src/provider.ts
      defaultFor:
        platform: [darwin, linux, win32, wsl]
  serviceTypes:
    - name: php
      module: ./src/services/php.ts
      versions: ["8.2", "8.3"]
    - name: mailhog
      module: ./src/services/mailhog.ts
      deprecated:                        # per-contribution deprecation; see §18.5
        since: "4.2.0"
        removeIn: "5.0.0"
        replacement: mailpit
        note: "MailHog is unmaintained; use the mailpit service type instead."
  features:
    - id: php-extensions
      module: ./src/features/extensions.ts
  commands:
    - id: app:composer                    # canonical namespaced id; namespace must equal the prefix
      namespace: app                      # required; one of "app", "apps", "meta", or this plugin's cspace
      module: ./src/commands/composer.ts
      topLevelAlias: false                # optional; default false. See §8.1.2.
  initSources:
    - id: github
      module: ./src/init/github.ts
  proxyServices:
    - id: traefik
      module: ./src/proxy.ts
  certificateAuthorities:
    - id: mkcert
      module: ./src/ca.ts
  loggers:
    - id: pretty
      module: ./src/logger.ts
  renderers:
    - id: lando
      module: ./src/renderer.ts
  toolingEngines:
    - id: providerExec
      module: ./src/tooling/provider-exec.ts
  routeFilters:
    - id: requestHeader
      module: ./src/filters/request-header.ts
  healthcheckRunners:
    - id: providerExec
      module: ./src/health/provider-exec.ts
  urlScanners:
    - id: fetch
      module: ./src/scan/fetch.ts
  pluginSources:
    - id: registry
      module: ./src/sources/registry.ts
  secretStores:
    - id: env
      module: ./src/secrets/env.ts
  configTranslators:
    - id: terraform
      module: ./src/translators/terraform.ts
      inputKinds: [terraform, cloud]
      detects: ["*.tf", "terraform/*.tf"]
      optionsSchema: ./src/translators/terraform-options.schema.ts
  templateEngines:
    - id: handlebars
      module: ./src/engines/handlebars.ts
      extensions: [".hbs", ".handlebars"]
      capabilities:
        wholeFile: true                     # supports multi-line render with control flow
        stringInterpolation: false          # cannot replace the `lando` engine for Landofile values
        partials: true                      # `{{> name}}` partials supported when site supplies them
        unsafe: false                       # honors the §7.3.1 purity guarantees
  doctorChecks:
    - id: terraform
      module: ./src/doctor/terraform.ts
      summary: Diagnose Terraform translator configuration
      tags: [config, terraform]
  messages:
    - id: example
      module: ./src/messages/example.ts

# Event subscribers
subscribers:
  - event: post-start
    scope: app
    module: ./src/subscribers/post-start.ts
    priority: 5

# Compatibility
requires:
  "@lando/core": "^4.0.0"
conflicts: {}
```

The manifest is itself an Effect Schema. Validation runs before any plugin module is imported.

**Deprecation.** The manifest root and every entry under `provides.<surface>[]` MAY carry a `deprecated:` field of type `DeprecationNotice` (§18.2). A root-level notice deprecates the whole plugin; a per-entry notice deprecates a single contribution. Subscribers under `subscribers:` MAY also carry `deprecated:` per the same shape. The plugin loader registers each notice with `DeprecationService` (§18.3) at install / refresh time, and runtime use records a `deprecation-used` event (§18.4) with the appropriate `kind` (`plugin`, `manifest-contribution`, `command`, `service-type`, etc.) per the surface deprecation matrix in §18.5.

### 9.5 Contribution surfaces

| Surface | Purpose | Loaded by |
|---|---|---|
| `providers` | `RuntimeProvider` implementations | Provider registry |
| `serviceTypes` | `ServiceType` resolvers | App planner |
| `features` | `ServiceFeature` functions | Service planner |
| `commands` | OCLIF + Lando commands (declare `namespace` and optional `topLevelAlias`; §8.1.1, §8.1.2) | Command registry |
| `initSources` | `apps:init` sources | Init command |
| `proxyServices` | `ProxyService` implementations | Proxy subsystem |
| `certificateAuthorities` | `CertificateAuthority` impls | Certs subsystem |
| `loggers` | `Logger` impls | Logging service |
| `renderers` | `Renderer` impls | Renderer service |
| `toolingEngines` | `ToolingEngine` impls for compiled Lando task graphs | Tooling service |
| `routeFilters` | Provider-neutral route transforms | Proxy subsystem |
| `healthcheckRunners` | `HealthcheckRunner` impls | Healthcheck subsystem |
| `urlScanners` | `UrlScanner` impls | Scanner subsystem |
| `pluginSources` | `PluginSource` impls | Plugin install |
| `secretStores` | `SecretStore` impls | Config expression resolution + tooling |
| `configTranslators` | Translators from external config formats to Landofile fragments | `app config translate` / embedding hosts |
| `templateEngines` | `TemplateEngine` impls for whole-file or string template rendering (§7.3.2) | Template renderer + mount materializer + recipe scaffold |
| `doctorChecks` | Diagnostic checks with automatic or manual remediations | `doctor` command / `DoctorService` |
| `messages` | Message factories | Lifecycle service |
| `subscribers` | Event handlers | Lifecycle service |

There are no legacy autoload directories. All contributions go through the manifest.

**Config translator contribution rules:**

- Each `configTranslators:` entry MUST declare a unique `id`, `module`, and `inputKinds:` metadata.
- `detects:` glob patterns are advisory metadata for help, docs, and cheap discovery. The translator module's `detect()` result is authoritative.
- `optionsSchema:` is optional. When present, CLI and library callers validate translator-specific options against it before invoking `translate()`.
- Translators return Landofile fragments plus diagnostics. They MUST NOT return an `AppPlan`, mutate files directly, contact providers, or install plugins.
- Translators run only on explicit request; they never participate in normal app bootstrap.

**Template engine contribution rules:**

- Each `templateEngines:` entry MUST declare a unique `id`, `module`, `extensions:` (the file-extension list the engine claims by default), and `capabilities:` (see §7.3.2 — `wholeFile`, `stringInterpolation`, `partials`, `unsafe`).
- `id: lando` is reserved for the built-in default engine. Plugins MUST NOT contribute an entry with `id: lando`.
- An engine MUST NOT declare `stringInterpolation: true` unless its syntax is fully compatible with the §7.3.1 expression grammar — Landofile string-value interpolation is the contract for the `lando` engine and only the `lando` engine. Plugin-contributed engines render whole files only.
- An engine that cannot honor the §7.3.1 purity rules MUST declare `capabilities.unsafe: true`. Unsafe engines are disabled by default and require explicit opt-in via global config (`templateEngines.<id>.allowUnsafe: true`). The plugin loader emits `TemplateEngineUnsafeRejectedError` when an unsafe engine is selected without opt-in.
- Engines MUST register through the published `@lando/sdk/services` `TemplateEngine` tag and accept the canonical `TemplateRenderContext` shape (§7.3.2) without engine-specific shape mutations.
- Engines SHOULD register the §7.3.1 portable function set under the engine's idiomatic registration API so users see the same helper names regardless of engine.

**Command contribution rules:**

- Each entry under `commands:` MUST declare `id` (canonical namespaced id) and `namespace`. The `namespace` value MUST equal the prefix segment of `id`.
- Acceptable `namespace` values are `app`, `apps`, `meta`, or the plugin's own `cspace:`. Plugins MUST NOT contribute commands to a topic that does not match one of these names.
- Plugins MUST NOT contribute commands directly under `plugin:`; the `meta:plugin:*` topic is reserved for core plugin-management commands.
- `topLevelAlias` is optional and follows §8.1.2. Top-level aliases that conflict with built-in or other plugin aliases are rejected with remediation.
- A command's `aliases:` field defines additional **namespaced** aliases (e.g., `app:composer-install` could alias `app:composer install`); top-level aliases use `topLevelAlias:`.

**Doctor check contribution rules:**

- Each `doctorChecks:` entry MUST declare a unique `id` and `module`; `summary:` and `tags:` are metadata for filtering and help.
- A doctor check module exports a `DoctorCheck` whose `run()` method returns a `DoctorCheckResult` with zero or more issues.
- Issues MUST include either an `automatic` solution command, a `manual` solution with user instructions, or enough detail to explain why no remediation is available.
- Automatic solution commands run only when the user explicitly passes `--fix`; default doctor runs are read-only.
- Checks MUST redact secrets and MUST NOT require provider-native commands for normal diagnosis unless the provider itself is the subject of the check.

### 9.6 Plugin install and update

`lando meta plugin add <spec>` (top-level alias `lando plugin add`) and `lando meta plugin remove <name>` (top-level alias `lando plugin remove`) are core commands implemented by:

1. Resolving the spec through the active `PluginSource` adapter chain.
2. Validating the manifest against the Effect Schema.
3. Resolving dependency and API compatibility (rejects on conflict).
4. Installing the package via `BunSelfRunner` (§3.4): the running binary self-spawns with `BUN_BE_BUN=1` and the resolved Bun verb (`add` for registry/git/tarball specs in the user-global plugin store; `install` for app-scoped `plugins:` resolution against an app's plugin store). The plugin install dir is the spawn `cwd`. Spawning a system `bun` from `$PATH` is forbidden; the compiled binary is itself Bun (§2.1). The library form falls back to a system `bun` when no embedded Bun is available, per the §3.4 contract.
5. Refreshing the Lando plugin cache, plugin command index, and OCLIF command shim metadata.

The user therefore needs no separate Bun installation to install plugins. A user with only the Lando binary on PATH can run `lando plugin add @lando/provider-docker` and the binary self-spawns its embedded Bun to perform the install. This contract is checked by an end-to-end test on a clean container with no prior Bun in the §13.6 CI matrix.

**Plugin postinstall scripts.** Bun's `lifecycleScripts` policy applies. By default, `BunSelfRunner.add` and `.install` MUST disable arbitrary `postinstall` script execution (`--ignore-scripts`-equivalent behavior) for any plugin not on the trusted-postinstall allowlist (`<userConfRoot>/plugin-trust.yml`, populated explicitly by the user via `lando plugin trust <name>` — TBD §14.2). Trusted postinstall scripts run inside the same `BunSelfRunner` recursion-guarded child (§3.4) and surface as `pre-bun-self-exec` / `post-bun-self-exec` events (§11.2) with `verb: "install"` and the plugin id in `callerSubsystem`. This is the principal user-facing motivation for routing every plugin install through `BunSelfRunner`: untrusted-by-default, lifecycle-observable, redacted, cancellable, and consistent across `meta:plugin:add` and app-scoped `plugins:` resolution.

`lando meta update` (top-level alias `lando update`) consults each installed plugin's release channel via the `UpdateService`. Channels: `stable`, `next`, `dev`. A plugin's manifest may specify `channels:` to constrain which channels it appears in. Plugin update writes use `BunSelfRunner.add` against the resolved version specifier; the `meta:update` command itself updates the Lando binary via the §17.6 self-update protocol, which is unrelated to `BunSelfRunner`.

`lando meta plugin login` (top-level alias `lando plugin login`) and `lando meta plugin logout` (top-level alias `lando plugin logout`) write to `<userDataRoot>/plugin-auth.json` and are consumed by the registry plugin source for private packages. The `BunSelfRunnerBunLive` reads `plugin-auth.json` to populate `BUN_AUTH_TOKEN` / scoped `_authToken` env vars on the spawned child for `add` / `install` verbs only; tokens never appear in argv, are redacted from `pre-bun-self-exec` / `post-bun-self-exec` events (§11.2), and never reach the `Logger` above debug level.

App-declared `plugins:` do not install into the user-global plugin set. They are scoped to the app that declared them, because they are part of that app's reproducible build. App-scoped install runs through the same `BunSelfRunner` with the app's `<userDataRoot>/apps/<app-id>/plugins/` as `cwd` and writes a `bun.lock` whose entries are mirrored into `.lando.lock.yml` (§7.7.4). Global `meta:plugin:add` remains the user-level install path for plugins the user wants available across apps.

### 9.7 Plugin loading rules

- Manifest validation happens before any plugin module is loaded.
- Bundled plugin modules are statically imported through the generated `src/plugins/bundled.ts` file and are part of the compiled binary.
- User, system, app-local, and app-scoped plugin modules are loaded from disk outside the binary with dynamic `import()` of an absolute `file://` URL.
- External plugin loading is staged: resolve/install the source, validate the manifest, resolve the contribution module path, verify API compatibility, verify the resolved realpath stays inside the plugin package root (or declared local plugin root), then import.
- Manifest `module:` paths MUST be relative paths or package-export entries that resolve inside the plugin package root after realpath resolution. Paths that escape via `../`, symlinks, absolute paths, or `file://` URLs outside the root are rejected with `PluginModulePathError`.
- Runtime imports use absolute `file://` URLs only. CWD-relative dynamic imports are forbidden.
- App-scoped plugins from Landofile `plugins:` load only from the locked local copy recorded in `.lando.lock.yml`; routine app startup MUST NOT re-resolve the remote source.
- Plugin command metadata is read from the validated plugin command cache during router bootstrap. Plugin command implementation modules are imported only after OCLIF resolves that command and runtime bootstrap reaches the command's declared level.
- Each contribution module is loaded lazily on first request (e.g., `provider` is loaded when a provider is selected; `command` modules are loaded when OCLIF resolves them).
- Config translator modules are loaded only when `app config translate`, `app config translate --detect`, or an embedding host explicitly requests translation.
- A plugin module returning an Effect Layer is composed into `LandoRuntimeLive` at load time.
- A plugin module returning a plain object is wrapped via `Layer.succeed`.
- A plugin module that throws on load is reported as a `PluginLoadError` and the plugin is marked unhealthy; other plugins continue.

### 9.8 The `LandoPluginContext`

Plugins receive a typed context with constrained access to core services:

```ts
export interface LandoPluginContext {
  readonly id: string;                        // plugin name
  readonly version: string;
  readonly config: PluginConfig;              // resolved per-plugin config
  readonly cwd: AbsolutePath;
  readonly userConfRoot: AbsolutePath;
  readonly userCacheRoot: AbsolutePath;
  readonly userDataRoot: AbsolutePath;
  readonly platform: HostPlatform;
  readonly logger: Logger.Logger<unknown, unknown>;
}
```

Plugins do not receive the full `LandoRuntimeLive` Layer. They receive precisely the services declared in their contribution requirements; this is enforced by the manifest's `requires.services:` field (TBD, §14).

### 9.10 Plugin authoring toolkit

The compiled `lando` binary is itself Bun (§2.1). That makes it possible to ship a complete plugin-authoring workflow inside the binary without requiring contributors to install a separate Bun, Node, npm, yarn, or any TypeScript toolchain. The toolkit is a small set of `meta:plugin:*` authoring commands (registered alongside the install/update commands in §8.2) that route every spawn through `BunSelfRunner` (§3.4).

The authoring toolkit is **not** a plugin contribution surface. It is core code that ships in core. Plugins MUST NOT contribute commands under `meta:plugin:*`.

#### 9.10.1 Authoring command catalog

| Canonical id | Bootstrap | Verb | Purpose |
|---|---|---|---|
| `meta:plugin:new <name> [<destination>]` | `minimal` | `BunSelfRunner.create` | Scaffold a new plugin source tree from a bundled template. |
| `meta:plugin:test [<paths>...]` | `minimal` | `BunSelfRunner.run(["test", ...paths])` | Run `bun test` in the current plugin source tree. |
| `meta:plugin:build` | `minimal` | `BunSelfRunner.buildLib` | Run `bun build` per the plugin's declared entry points and emit a publishable artifact tree. |
| `meta:plugin:link [<path>]` | `plugins` | `BunSelfRunner` | Symlink a local plugin source tree into the user-global plugin store and refresh plugin caches. |
| `meta:plugin:unlink <name>` | `plugins` | `BunSelfRunner` | Reverse of `link`; the previously installed registry copy is restored when the lockfile records one. |
| `meta:plugin:publish` | `minimal` | `BunSelfRunner.publishPkg` | Publish the built artifact to a registry. Reads tokens from `<userDataRoot>/plugin-auth.json`; redacts them in lifecycle events. |

None of these commands carries a default top-level alias; they are namespaced under `meta:plugin:` for discoverability and to keep the bare top-level surface uncluttered. OCLIF flexible taxonomy still accepts `lando plugin new <name>`, `lando plugin test`, etc.

#### 9.10.2 `meta:plugin:new` templates

`meta:plugin:new` invokes `BunSelfRunner.create(template, dest)` with a Lando-curated template id. The bundled template set is generated at build time by a new `scripts/build-bundled-plugin-templates.ts` codegen step (added to §17.2) and embedded via `Bun.embeddedFiles` (§17.3):

| Template id | Scaffolds |
|---|---|
| `service-type` | A service-type plugin (manifest, `serviceTypes:` entry, schema, scenario fixture) |
| `provider` | A `RuntimeProvider` plugin (manifest, capability matrix, `apply`/`exec`/`logs` skeletons, contract-suite hookup) |
| `tooling-engine` | A `ToolingEngine` plugin |
| `template-engine` | A `TemplateEngine` plugin (capabilities matrix and contract-suite hookup) |
| `route-filter` | A `RouteFilter` plugin |
| `config-translator` | A `ConfigTranslator` plugin (detection patterns, options schema, fragment emitter) |
| `recipe` | A directory tree containing `recipe.yml`, `templates/`, `assets/`; published as an npm package consumable by `--recipe=npm:…` |
| `bare` | An empty plugin manifest plus a `provides:` skeleton; the user fills in the rest |

Every template emits, at minimum: a `package.json` with the correct `keywords` and `lando` block, a `plugin.yaml` (or `package.json#lando`) with `api: 4`, an `Effect Schema`-typed config schema, a `bun test`-ready test fixture, a `tsconfig.json` aligned with §2.2 strict settings, and a `README.md`. The generated tree is buildable, testable, and linkable with no further setup.

`lando plugin new` prompts interactively for `name`, `template`, `cspace`, and `description` unless `--no-interactive` is passed; `--answer key=value` (repeatable) and `--answers <file>` follow the §8.8.1 init-prompt conventions so an embedding host can scaffold non-interactively.

#### 9.10.3 `meta:plugin:test` and `meta:plugin:build`

Both commands resolve the *current plugin source tree* by walking up from `cwd` looking for a `package.json` whose `keywords` include `lando-plugin` (or whose `package.json#lando` block validates as a manifest). The first match is the plugin root; failure surfaces as `PluginAuthoringRootNotFoundError` with remediation pointing at the directory layout the templates produce.

`meta:plugin:test` runs `BunSelfRunner.run(["test", ...args])` with the plugin root as `cwd`. The argv after `--` is forwarded to Bun unchanged, so `lando plugin test -- --watch` works exactly as a user would expect from `bun test --watch`.

`meta:plugin:build` runs `BunSelfRunner.buildLib({ entrypoints, outdir, target: "bun" })` per the plugin's `package.json#exports` map, with TS declarations emitted via `BunSelfRunner.run(["build", "--declaration", ...])` or an equivalent type-emit pass. Output lands at `<plugin-root>/dist/`. The command refuses to run if a previous build's output is mixed with source files (no `dist/` polluting `src/`).

Both commands publish `cli-meta:plugin:test-*` and `cli-meta:plugin:build-*` lifecycle events alongside the per-spawn `pre-bun-self-exec` / `post-bun-self-exec` pair.

#### 9.10.4 `meta:plugin:link` and `meta:plugin:unlink`

`meta:plugin:link [<path>]` resolves a plugin source tree (defaulting to `cwd` per §9.10.3), validates the manifest, then registers the local path in the user-global plugin store at `<userDataRoot>/plugins/<name>` as a symlink. The plugin command index, OCLIF shim cache, and plugin cache are refreshed (§12.1). Subsequent `lando` invocations import the linked plugin's modules from the live source tree, so plugin authors get a real edit-build-test loop without re-running `meta:plugin:add`.

`meta:plugin:unlink <name>` reverses the operation. If the user's plugin lockfile (`<userDataRoot>/plugins/.lando.lock.yml`) records a registry-installed copy that the link replaced, the registry copy is restored via `BunSelfRunner.add`. Otherwise the plugin is simply removed.

Linked plugins are flagged in the plugin cache with `source: "linked"` and `linkedPath: <abs>`; `lando doctor` reports linked plugins separately so a user investigating an issue knows which plugins are running from local development trees rather than published versions.

`meta:plugin:link` rejects symlinks whose realpath escapes any of the user's permitted authoring roots (`<userDataRoot>/plugins/.authoring-roots/*`, populated by the user via `lando plugin trust-authoring-root <abs>` — TBD §14.2). This prevents a malicious package from pretending to be a plugin during `lando init` flows that recurse through unrelated directories. The default authoring-roots list is empty; users opt in explicitly.

#### 9.10.5 `meta:plugin:publish`

`meta:plugin:publish` runs `BunSelfRunner.publishPkg({ tag, dryRun, registry })` with the plugin's built artifact directory as `cwd`. Pre-publish, the command:

1. Re-runs `meta:plugin:build` if the artifact directory is missing or older than any source file.
2. Re-runs `meta:plugin:test` unless `--no-test` is passed.
3. Validates the manifest one more time and asserts that every `module:` path in `provides:` resolves under the artifact directory (no source-only paths leak into the published package).
4. Reads the active registry token from `<userDataRoot>/plugin-auth.json` (§9.6) for the registry the plugin's `package.json#publishConfig` declares.

The token is passed to the embedded Bun via env (`BUN_AUTH_TOKEN` or scoped `_authToken`); it never appears in argv and is redacted in `pre-bun-self-exec` / `post-bun-self-exec` events (§11.2). `--dry-run` runs the entire flow including `bun publish --dry-run`, prints the package contents, and exits 0 without actually publishing.

#### 9.10.6 Authoring policies

- Authoring commands MUST NOT modify any global Lando state outside `<userDataRoot>/plugins/`. They MUST NOT mutate global config, MUST NOT install user-facing recipes, and MUST NOT run app lifecycle commands.
- The `.bun.sh` and `.bun.ts` script execution paths from §3.4 / §8.5.9 are reused for any authoring task that needs in-binary scripting (e.g., a template's post-scaffold hook). Templates MUST NOT bundle a freeform shell script outside that contract.
- Authoring commands route every Bun child through `BunSelfRunner`; arbitrary `Bun.spawn(["bun", …])` calls are forbidden in the authoring command implementations under `src/cli/commands/meta/plugin/*`. The §13.4 lint gate enforces this.
- The plugin templates MUST keep their top-of-tree imports cheap (§2.4); a freshly-scaffolded plugin MUST cold-start within the level-`plugins` budget on the reference runner (§2.1, §13.1).

---
