# Lando v4 — CLI, Tasks, and Tooling

> **Part 8 of 18** · [Index](./README.md)
> **Read next:** [09 Embedding and Library Use](./09-embedding.md)

This part defines the CLI surface. OCLIF is consumed in exactly one place — `src/cli/oclif/` — and the moment a command's `run()` is invoked, control crosses into Effect and never goes back.

Covered here: the four kinds of commands (built-in, plugin, tooling, management), the three first-class command namespaces (`app`, `apps`, `meta`) and the top-level alias mechanism, the full list of built-in commands and their behavioral requirements (including the dedicated `app config` and `meta config` commands), the `LandoCommandSpec` contract and `CommandInput` shape, OCLIF integration policies (manifest-first, hooks bridging to Effect, `SIGINT` → `Effect.interrupt`, flexible taxonomy, namespace-to-topic mapping), the Taskfile-inspired tooling YAML schema with dynamic service resolution and config expressions, the `ToolingEngine` abstraction (default `providerExec`, plus `host`, `remote`, `dryRun` alternatives), the tooling compilation pipeline and its hot-path cache, `lando apps init` and the v4 recipe model (Yeoman-style scaffolds with Q&A prompts, file manifests, and post-init actions, replacing the v3 recipe-as-plugin model), and the `Renderer` service with built-in render events and selection precedence.

---

## 8. CLI, Tasks, and Tooling

### 8.1 Command kinds

Every command in Lando v4 belongs to exactly one of four **kinds** and is registered under exactly one **namespace** (§8.1.1). The kind determines who authors the command and how it is loaded; the namespace determines the canonical OCLIF topic prefix.

| Kind | Source | OCLIF representation |
|---|---|---|
| **Built-in command** | Core package | Static OCLIF `Command` subclass adapting Effect |
| **Plugin command** | Plugin manifest `provides.commands` | Lazy-loaded OCLIF `Command` subclass |
| **Tooling command** | Landofile `tooling:` | Generated OCLIF command shim metadata, read from the app command index during router bootstrap |
| **Management command** | Core or plugin, `hidden: true` | Hidden OCLIF command |

#### 8.1.1 Command namespaces

Lando commands live under **three first-class namespaces** that map directly to OCLIF topics. Every command — built-in, plugin-contributed, or tooling — has a canonical id of the form `<namespace>:<segments…>` and is invoked at that path.

| Namespace | OCLIF topic | Scope | Examples |
|---|---|---|---|
| `app` | `app:` | Operations on the current Lando app (or one referenced by `--path`) | `app:start`, `app:stop`, `app:logs`, `app:exec`, `app:config`, tooling tasks |
| `apps` | `apps:` | Operations across multiple apps or app discovery on the host | `apps:list`, `apps:poweroff`, `apps:init` |
| `meta` | `meta:` | Operations on Lando itself (config, plugins, host setup, distribution) | `meta:config`, `meta:setup`, `meta:plugin:add`, `meta:update`, `meta:version`, `meta:shellenv` |

Plugins MAY contribute commands to any of the three core namespaces or to a plugin-owned topic. A plugin's manifest declares the target namespace per command (§9.4). When a plugin contributes to its own topic (for example, a database plugin contributing `db:import`), the topic name SHOULD match the plugin's `cspace:` field.

Namespaces are stable parts of every command's canonical id and surface in:

- OCLIF help output (commands grouped under their topic).
- Lifecycle events: `cli-<canonical-id>-<phase>` (e.g., `cli-app:start-run`; §3.5/§11.4).
- Generated docs (one page per namespace plus per-command pages).
- The `command` cache index (§12.1), which keys by canonical id.

Because OCLIF runs with `flexibleTaxonomy: true` (§8.4), the canonical separator `:` and a single space are interchangeable in input: `lando app start`, `lando app:start`, and `lando app:start --` all resolve to the same command when unambiguous.

**Reserved namespace names:** `app`, `apps`, `meta`, plus `plugin` (used as a sub-topic of `meta`). Plugins MUST NOT contribute commands directly under `plugin:` at the top level; plugin-management commands live under `meta:plugin:*`. Plugin-owned topics MUST NOT shadow the three core namespace names.

**Multi-segment ids.** A canonical id MAY have more than two segments. `meta:plugin:add`, `meta:plugin:remove`, and `app:db:import` (plugin-contributed) are all legal. Each additional segment becomes a nested OCLIF topic.

#### 8.1.2 Top-level aliases

A **top-level alias** registers a command at the bare top level *in addition to* its canonical namespaced form. For example, `app:start` ships with `topLevelAlias: true`, so both `lando app start` and `lando start` invoke the same command. Top-level aliases are a CLI ergonomics affordance — they do not change the command's identity, lifecycle event name, or cache key.

Top-level aliases are configured per command via the `topLevelAlias` field on `LandoCommandSpec` (§8.3) or on a tooling task (§8.5.1).

| Value | Effect |
|---|---|
| `false` (default) | No top-level alias is registered. |
| `true` | Register the canonical id with its **namespace prefix stripped** as a top-level alias. `app:start` → `lando start`. `meta:plugin:add` → `lando plugin:add` (which OCLIF flexible taxonomy also accepts as `lando plugin add`). Multi-segment canonical ids therefore yield multi-segment top-level aliases that occupy a top-level OCLIF topic; conflict rules (below) apply to the alias's first segment. |
| `"name"` (string) | Register the given name as the top-level alias instead of the auto-derived name. `apps:poweroff` → `topLevelAlias: "halt"` produces `lando halt`. Multi-segment values like `"plugin:add"` are accepted and become a top-level OCLIF topic-and-command pair. |
| `["a", "b"]` (string[]) | Register multiple top-level aliases. The same conflict rules apply to each entry independently. |

**Conflict resolution.** A top-level alias MUST NOT collide with another top-level alias, a top-level OCLIF topic name (`app`, `apps`, `meta`, or any plugin cspace topic), or a reserved word (`help`, `--help`, `--version`). Conflicts are detected at command registration and reported as a tagged `CommandAliasConflictError` with remediation. The conflict policy is:

1. Built-in command top-level aliases never silently lose to plugin or tooling aliases. A plugin contribution that conflicts with a built-in alias is rejected with remediation pointing at the built-in.
2. Plugin-vs-plugin alias conflicts are resolved by the standard selection precedence (§4.3); otherwise rejected.
3. Tooling-vs-anything alias conflicts are rejected unless the user explicitly disables the conflicting alias in global config.

The `global:` top-level alias prefix is **reserved** for the `meta:global:*` namespace (§20.7.1). Plugin- and tooling-contributed top-level aliases that begin with `global:` collide with the built-ins and are rejected with `CommandAliasConflictError`. A user override via `commandAliases.custom:` MAY remap a `global:*` alias inside an app context (the underlying `meta:global:*` canonical id remains callable directly).

The `scratch:` top-level alias prefix and the bare `scratch` top-level alias are **reserved** for the `apps:scratch:*` namespace (§21.10.2). The bare `scratch` alias maps to `apps:scratch:start` (analogous to the bare `init` alias mapping to `apps:init`), and every other `scratch:<verb>` alias maps to its `apps:scratch:<verb>` canonical id. Plugin- and tooling-contributed top-level aliases that begin with `scratch:` or that are exactly `scratch` collide with the built-ins and are rejected with `CommandAliasConflictError`. A user override via `commandAliases.custom:` MAY remap a `scratch:*` alias inside an app context (the underlying `apps:scratch:*` canonical id remains callable directly).

**User override.** Top-level aliases are configurable in global config (§7.5) and at the Landofile level (§7.4). Landofile entries take precedence inside the app context.

```yaml
# <userConfRoot>/config.yml — applies to every app on the host
commandAliases:
  enabled: true                    # master switch; default true
  disabled:                        # opt out of specific top-level aliases
    - start                        # disables the top-level alias of app:start (still callable as `lando app start`)
    - poweroff
  custom:                          # add user-defined top-level aliases
    halt: app:stop                 # `lando halt` runs `lando app stop`
    setupall: meta:setup
```

```yaml
# .lando.yml — applies only when the user is in this app's context
commandAliases:
  custom:
    start: app:my-start            # in this app, `lando start` runs the user-defined `app:my-start` task
```

Setting `commandAliases.enabled: false` removes every top-level alias system-wide; users can then call commands only by their canonical id. `commandAliases.custom` entries are registered after built-in/plugin/tooling aliases and are subject to the same conflict rules.

**Landofile override semantics.**

- A Landofile `commandAliases.custom.<alias>: <canonical-id>` entry **overrides** any built-in, plugin, or global-config top-level alias of the same name for the app context. Outside the app context the override has no effect.
- The targeted canonical id remains callable directly. `lando app start` always invokes the built-in `app:start` regardless of any override; the override only re-binds the bare alias.
- Overrides MUST resolve to a canonical id that exists at registration time. Unknown ids fail with `CommandAliasTargetError` and remediation listing close matches.
- An override can target a built-in (`start: app:start`), a plugin command (`db: db:import`), or a tooling task in the same Landofile (`start: app:my-start`). The common pattern is to point the alias at a wrapping tooling task that uses `command:` (§8.5.2.1) to invoke the original built-in.
- Landofile `commandAliases.disabled:` removes a top-level alias for the app context only.
- Landofile `commandAliases.enabled: false` disables every top-level alias for the app context only.

The Landofile override path eliminates the alias-conflict scenario described above for the most common use case (overriding a built-in alias from a single project): the user does not need to manually disable the built-in before claiming its alias — the explicit override resolves the conflict by construction.

### 8.2 Built-in commands

Built-in commands are defined in core. Each declares its canonical namespaced id and whether it ships with a default top-level alias.

| Canonical id | Default top-level alias | Bootstrap | Summary |
|---|---|---|---|
| `app:cache:refresh` | *(none)* | `app` | Rebuild the app plan, tooling graph, and app command index without starting services |
| `app:config` | *(none — `config` is reserved by `meta:config`)* | `app` | Read/write the current app's Landofile (§8.2.1) |
| `app:config:translate` | *(none)* | `app` | Run config translators and optionally apply generated Landofile fragments (§8.2.1) |
| `app:destroy` | `destroy` | `app` | Destroy the current app's resources |
| `app:exec` | `exec` | `app` | Execute a command inside a service |
| `app:includes:update` | *(none)* | `minimal` | Refresh one or more `includes:` lockfile entries (§7.7.4); with no arguments, refreshes all |
| `app:includes:verify` | *(none)* | `minimal` | Re-check every `includes:` checksum without updating; succeeds without network access on a warm cache (§7.7.4, §15.C) |
| `app:info` | `info` | `app` | Print app/service runtime information |
| `app:logs` | `logs` | `app` | Stream service logs |
| `app:rebuild` | `rebuild` | `app` | Rebuild and restart services |
| `app:restart` | `restart` | `app` | Stop then start the app |
| `app:shell` | `shell` | `app` | Open an interactive Bun Shell with the current app's `LANDO_*` env, host paths, and provider-exec aliases pre-set (§8.2.3) |
| `app:ssh` | `ssh` | `app` | Alias of `app:exec` with default `--interactive --tty` |
| `app:start` | `start` | `app` | Start the current app |
| `app:stop` | `stop` | `app` | Stop the current app |
| `apps:init` | `init` | `minimal` | Generate a new Lando app (§8.8) |
| `apps:list` | `list` | `minimal` | List apps known to Lando |
| `apps:poweroff` | `poweroff` | `provider` | Stop every Lando-managed service across apps |
| `apps:scratch:destroy` | `scratch:destroy` | `scratch` | Destroy a scratch app's resources without first stopping; `<id>` required, `--keep-volumes` retains volumes for inspection (§21.10) |
| `apps:scratch:gc` | `scratch:gc` | `scratch` | Find orphaned scratch resources via the registry walk + provider-label scan; `--prune` reaps (§21.11) |
| `apps:scratch:info` | `scratch:info` | `scratch` | Print runtime info for a scratch app; `<id>` selects, `--service`, `--format` (§21.10) |
| `apps:scratch:list` | `scratch:list` | `scratch` | List every scratch app from the registry plus orphans found via provider labels; `--format table\|json` (§21.10) |
| `apps:scratch:logs` | `scratch:logs` | `scratch` | Stream scratch service logs; `<id>` selects, `--service`, `--follow`, `--tail`, `--since` (§21.10) |
| `apps:scratch:start` | `scratch:start`, `scratch` | `scratch` | Start a scratch app; `--fork` or `--from <recipe-ref>` is required, `--isolate=full\|baked\|cwd`, `--mount-cwd`, `--share-global-storage`, `--detach` (§21.10) |
| `apps:scratch:stop` | `scratch:stop` | `scratch` | Stop a scratch app; `<id>` selects (or stops the foreground scratch in this shell session); calls destroy (§21.10) |
| `meta:bun` | `bun` | `minimal` | Proxy to the embedded Bun CLI via `BunSelfRunner` (§3.4); the canonical user-visible BUN_BE_BUN entry point (§8.2.4) |
| `meta:config` | `config` | `minimal` | Read/write global Lando config (§8.2.2) |
| `meta:doctor` | `doctor` | `plugins` | Run diagnostics for app config, host/provider setup, and plugin-contributed checks (§10.9) |
| `meta:events:follow` | `events` | `minimal` | Follow the lifecycle event trace stream for diagnostics and e2e tests |
| `meta:global:config` | `global:config` | `minimal` | Read/write the global Landofile at `<userDataRoot>/global/.lando.yml` and the plugin enablement map (§20.3.1, §20.7) |
| `meta:global:destroy` | `global:destroy` | `global` | Destroy the global app's resources; `--purge` also removes `service`/`app`-scoped volumes (§20.7) |
| `meta:global:info` | `global:info` | `global` | Print global service runtime information; supports `--service`, `--format` |
| `meta:global:install` | `global:install` | `global` | Enable a plugin's `globalServices:` contributions (writes `global.config.yml`, regenerates `dist`); does not start services on its own (§20.7) |
| `meta:global:list` | `global:list` | `minimal` | List every contributed global service with `enabled:`, source plugin, status |
| `meta:global:logs` | `global:logs` | `global` | Stream global service logs |
| `meta:global:rebuild` | `global:rebuild` | `global` | Stop, rebuild artifacts, and restart global services |
| `meta:global:restart` | `global:restart` | `global` | `meta:global:stop` + `meta:global:start` |
| `meta:global:start` | `global:start` | `global` | Start the global app; `--service <id>` (repeatable) starts a subset (§20.7) |
| `meta:global:stop` | `global:stop` | `global` | Stop the global app's services |
| `meta:global:uninstall` | `global:uninstall` | `global` | Disable a plugin's `globalServices:` contributions and stop affected services (§20.7) |
| `meta:plugin:add` | `plugin:add` | `plugins` | Install a plugin |
| `meta:plugin:build` | *(none)* | `minimal` | Build the current plugin source via `BunSelfRunner.buildLib` (§9.10). Authoring command. |
| `meta:plugin:link` | *(none)* | `plugins` | Symlink the current plugin into the user-global plugin store via `BunSelfRunner` `link` semantics (§9.10). Authoring command. |
| `meta:plugin:login` | `plugin:login` | `minimal` | Authenticate with a plugin source |
| `meta:plugin:logout` | `plugin:logout` | `minimal` | Forget plugin source authentication |
| `meta:plugin:new` | *(none)* | `minimal` | Scaffold a new plugin from a built-in template via `BunSelfRunner.create` and the plugin authoring toolkit (§9.10). Authoring command. |
| `meta:plugin:publish` | *(none)* | `minimal` | Publish the current plugin via `BunSelfRunner.publishPkg` (§9.10). Reads `<userDataRoot>/plugin-auth.json` for registry tokens. Authoring command. |
| `meta:plugin:remove` | `plugin:remove` | `plugins` | Remove a plugin |
| `meta:plugin:test` | *(none)* | `minimal` | Run the current plugin's tests via `BunSelfRunner.run(["test"])` (§9.10). Authoring command. |
| `meta:plugin:unlink` | *(none)* | `plugins` | Reverse of `plugin:link`; remove the symlink and (optionally) restore the registry-installed copy (§9.10). Authoring command. |
| `meta:recipes:describe` | *(none)* | `minimal` | Print a recipe's prompts and metadata without running it (§8.8.11) |
| `meta:recipes:list` | `recipes` | `none` | List canonical recipes shipped with the binary; served from compile-time embedded recipe registry, no Effect runtime constructed (§3.2) |
| `meta:recipes:validate` | *(none)* | `minimal` | Validate a `recipe.yml` against the published schema (§8.8.11) |
| `meta:setup` | `setup` | `provider` | Run host setup (provider, CA, proxy, shell integration) |
| `meta:shellenv` | `shellenv` | `none` | Print shell-profile snippets from compile-time embedded templates; no Effect runtime constructed (§3.2) |
| `meta:uninstall` | `uninstall` | `minimal` | Remove Lando-owned installed files after confirmation (§17.7) |
| `meta:update` | `update` | `plugins` | Update Lando core and plugins |
| `meta:version` | `version` | `none` | Print Lando version information; served from compile-time embedded constant, no Effect runtime constructed (§3.2) |
| `meta:x` | `x` | `minimal` | One-shot package execution via `BunSelfRunner.x` (bunx-equivalent); the canonical npm/jsr-package runner (§8.2.4) |

**Command requirements** (canonical ids; the same behaviors apply when invoked through a top-level alias):

- `app:info` supports `--deep`, repeated `--filter`, `--path`, `--service`, `--format json|table|yaml`.
- `app:cache:refresh` performs full app bootstrap, rebuilds the app plan cache, compiled tooling graph, and `<userCacheRoot>/apps/<app-id>/commands.json`, then exits without contacting the provider unless app materialization needs missing Lando-managed dependencies.
- `app:includes:update [<source>...]` resolves the named include sources fresh, writes new `<appRoot>/.lando.lock.yml` entries with refreshed refs and checksums, and invalidates the app plan cache. With no positional arguments, refreshes every entry. Supports `--no-network` to fail fast when a refresh would require network and `--check` to report would-be drift without writing. Network access is required by definition.
- `app:includes:verify` re-reads every entry in `.lando.lock.yml` and re-computes the checksum of the cached fragment under `<userCacheRoot>/includes/`. Succeeds without network access when every entry resolves from the warm cache. Reports drift, missing cache entries, or checksum mismatches as a non-zero exit with `IncludeLockError` and remediation pointing at `app:includes:update`. Supports `--format json|table`.
- `apps:list` works inside and outside an app context, supports `--all`, filters, `--path`, JSON, table.
- `app:logs` streams app logs and supports `--service`, `--follow`, `--tail`, `--since`.
- `app:stop` stops the current app.
- `apps:poweroff` stops every Lando-managed service across apps (across providers when capability allows).
- `app:restart` is `app:stop` + `app:start`.
- `app:exec` runs a command in a service. `app:ssh` is `app:exec` with default `--interactive --tty`.
- `app:shell` requires a TTY; with `--no-interactive` it errors with `ShellRequiresTtyError`. Defaults to host mode (a `Bun.$`-backed REPL via `ShellRunner`) so ad-hoc commands run cross-platform without leaving the project's env; `--service <name>` runs the REPL inside a service via provider exec instead. Behavioral details in §8.2.3.
- `app:destroy` requires confirmation unless `--yes` is passed.
- `meta:events:follow` supports `--follow`, `--format json|table`, repeated `--event`, `--scope`, and `--since`; it reads the EventService trace sink used by diagnostics/e2e and does not subscribe to plugin events itself.
- `meta:uninstall` requires confirmation unless `--yes` is passed, supports `--dry-run`, removes the binary when Lando owns the install path, removes `<userDataRoot>` and `<userCacheRoot>`, and leaves provider-owned runtime resources to provider-specific cleanup docs.
- `--clear` is accepted at any level and purges relevant caches.
- `app:start` and `app:rebuild` materialize app-declared Lando dependencies when needed: app-scoped plugins from `plugins:`, remote includes without warm cache entries, provider artifacts, and provider/runtime metadata. After a successful materialization/build, repeating `app:start` for the same app MUST NOT require network access unless a declared source is missing from the cache, the lockfile changed, or the app's own build/tooling commands require network.

- `apps:poweroff` stops every Lando-managed service across user apps **and** the global app by default; `--keep-global` opts out and reports "kept global app running" in the renderer's final summary (§20.6.4, §20.7).
- `apps:poweroff` ALSO stops every running scratch Lando app by default; `--keep-scratch` opts out and reports "kept N scratch app(s) running" in the renderer's final summary (§21.6.3, §21.10). `--keep-global` and `--keep-scratch` compose: `apps:poweroff --keep-global --keep-scratch` stops only user apps.
- `meta:global:start` (and the auto-start path triggered by user-app `AppFeature.requires.globalServices`, §20.6.3) refuses to run when no `globalServices:` contributions are installed; the user is told to install at least one plugin that contributes a global service or to run `meta:setup`.
- `meta:global:list --format json` is the canonical machine-readable shape of "what's available in the global app on this host"; embedding hosts and CI scripts MUST use it instead of parsing the rendered table.
- `apps:scratch:start` requires either `--fork` (use the cwd-walk Landofile as the source) or `--from <recipe-ref>` (render a recipe into the scratch root); passing both, or neither, fails fast with `ScratchSourceUnresolvedError`. The default is foreground; `--detach` registers the scratch in `<userCacheRoot>/scratch/registry.bin` and exits 0 (§21.10.1, §21.11).
- `apps:scratch:start --fork` materializes the scratch by content-copying the resolved source app root, honoring `scratch.fork.excludes:` plus repeated `--exclude <pattern>` (§21.4.1). The default isolation is `--isolate=full` (the appMount binds the scratch's copy); `--mount-cwd` is sugar for `--isolate=cwd` and overrides the safer default (§21.7).
- `apps:scratch:start --from <recipe-ref>` runs the recipe pipeline against the scratch root and SKIPS the recipe's `postInit:` actions by default; `--run-post-init` opts back in. The default isolation is `--isolate=baked` (no appMount; an empty `/app` inside the container); `--mount-cwd` switches to bind-mounting the host cwd at the appMount destination (§21.4.2, §21.7).
- `apps:scratch:start` rewrites every `scope: global` storage entry in the resolved plan to `scope: app` at plan time so a scratch app does NOT touch user-app `scope: global` volumes; `--share-global-storage` opts back into the original semantics (§21.8).
- `apps:scratch:start` applies the built-in `ScratchHostnameSuffix` route filter at plan time so a scratch's routes do not collide with the source app's; `--no-hostname-suffix` (or per-host `--hostname <host>` overrides) opts out (§21.9.2).
- `apps:scratch:list --format json` is the canonical machine-readable shape of "what scratch apps are alive on this host"; embedding hosts and CI scripts MUST use it instead of parsing the rendered table.
- `apps:scratch:gc` is safe to run from cron and from post-host-reboot init scripts; without `--prune` it prints a report and exits 0 (§21.11).

Commands tolerate apps with no services when the command semantics allow it.

**Help organization.** `lando --help` shows top-level aliases under a "Common commands" group plus links to the three namespace topics (`app`, `apps`, `meta`). `lando app --help`, `lando apps --help`, and `lando meta --help` print the commands within each namespace, including any plugin- and tooling-contributed commands. Plugin-owned topics appear at the top level alongside the three core namespaces.

#### 8.2.1 The `app config` command

`lando app config` reads and writes the current Lando app's user-editable Landofile (default `.lando.yml`; basename configurable globally via `landoFile:` in §7.5). The merge layers `lando.base.yml`, `lando.dist.yml`, and `lando.upstream.yml` are read but never written. The lower-precedence `lando.local.yml` and `lando.user.yml` are likewise read-only from this command unless `--target` is given explicitly. The `translate` subcommand has canonical id `app:config:translate` so recipes, tooling `command:` steps, and embedding hosts can target it directly.

```text
lando app config [--format json|yaml|table] [--path <key.path>]
lando app config get <key.path>
lando app config set <key.path> <value> [--type string|number|boolean|json|yaml]
lando app config unset <key.path>
lando app config edit [--editor <bin>] [--target user|local|canonical]
lando app config validate
lando app config view [--source raw|merged|resolved] [--format json|yaml]
lando app config translate [--from <translator-id>] [--file <path>]... [--format yaml|json]
lando app config translate --detect [--format table|json]
lando app config translate --list [--format table|json]
lando app config translate --write [--target canonical|local|user] [--yes]
```

Subcommands:

| Subcommand | Behavior |
|---|---|
| (none) | Equivalent to `lando app config view --source resolved`. |
| `get <key.path>` | Print a single resolved value. Honors `--source`. |
| `set <key.path> <value>` | Write to the canonical user-editable Landofile. `--type` controls parsing of the value (default `string`; `json`/`yaml` parses structured values). Validates the resulting file before writing. |
| `unset <key.path>` | Remove a key from the canonical user-editable Landofile. |
| `edit` | Open the target Landofile in `$VISUAL`/`$EDITOR` (or `--editor`); validate before saving. `--target` selects the layer (`canonical` is the default user-editable file; `local` is `.lando.local.yml`; `user` is `.lando.user.yml`). |
| `validate` | Validate the merged Landofile against the published schema (§7.8). |
| `view --source` | `raw` is the canonical user-editable file. `merged` is the post-merge tree before expression resolution (§7.2). `resolved` (default) is the fully resolved, post-expression Landofile (§7.3.1). |
| `translate` | Run an explicit config translator (§7.4.1/§9.5) against external source files and preview the generated Landofile fragment. `--write` applies the fragment to an editable layer after validation. |
| `translate --detect` | Ask installed translators to detect supported source files under the app root and report matches without generating a patch. |
| `translate --list` | List installed config translators, their input kinds, and any required options. |

Rules:

- Write operations target the canonical user-editable Landofile (default `.lando.yml`). The six-file merge layers from §7.2 are read but never modified except via `edit --target`.
- Write operations validate the resulting file against the published Landofile schema (§7.8) before persisting. A validation failure aborts the write with no partial change and returns a tagged `LandofileWriteValidationError` with the offending path and remediation.
- Atomic-write semantics from §12.3 apply. The app-plan cache (§12.1) is invalidated after any successful write.
- `--path <key.path>` is dot-separated (`services.appserver.environment.APP_ENV`); array indexing uses bracket notation (`tooling.test.cmds[0]`).
- The command refuses to operate when there is no Landofile in scope and prints remediation suggesting `lando apps init`.
- Config-expression strings (§7.3.1) are written through unchanged; `set` does not evaluate expressions, and `view --source resolved` shows their resolved values.
- Setting a key to a `${secret:...}` reference is allowed; the literal reference is written and resolved at runtime per §7.3.1.
- `translate` is preview-only unless `--write` is set. Without `--from`, detection MUST produce exactly one `exact` or `likely` match; ambiguous matches fail with remediation listing `--from` choices. `--file` scopes translator input and is required when a translator cannot safely autodetect. Writes use the same target, validation, atomic-write, and cache-invalidation rules as `set`/`unset`.

#### 8.2.2 The `meta config` command

`lando meta config` reads and writes Lando's **global** config at `<userConfRoot>/config.yml`. The `config.d/*.yml` overlay layer and `LANDO_*` environment-variable overrides are read but never written from this command. The bare `lando config` invocation is the default top-level alias for this command.

```text
lando meta config [--format json|yaml|table] [--path <key.path>]
lando meta config get <key.path>
lando meta config set <key.path> <value> [--type string|number|boolean|json|yaml]
lando meta config unset <key.path>
lando meta config edit [--editor <bin>]
lando meta config view [--source raw|resolved] [--format json|yaml]
```

Subcommands mirror `app config` (§8.2.1), with these specifics:

- All write operations target `<userConfRoot>/config.yml`. The `config.d/*.yml` overlay and `LANDO_*` env-var overrides remain read-only.
- All write operations validate against the published global-config schema (§7.5) and are atomic per §12.3.
- `view --source raw` shows the contents of `config.yml` only. `view --source resolved` shows the post-merge, post-env-override values that the runtime will actually use.
- The command runs at bootstrap level `minimal` and is callable outside any app context.
- Plugin-config keys (`pluginConfig.<plugin>.…`) and provider extensions (`providers.<provider>.…`) are first-class write targets and are validated against each contributing schema (§9.4) before being persisted.

#### 8.2.3 The `app shell` command

`lando app shell` (default top-level alias `lando shell`) opens an interactive Bun Shell scoped to the current Lando app. The host-mode shell is intentionally lightweight: it gives developers a one-key way to run ad-hoc commands in the app's resolved environment without retyping `LANDO_HOST_IP=… composer install` or jumping into a service for host-only tooling.

```text
lando app shell [--service=<name>] [--no-history]
```

Behaviors:

- **Host mode (default).** A `Bun.$`-backed REPL runs on the host through `ShellRunner` (§3.4) with the app's `LANDO_*` env vars (§6.9) injected, the working directory set to the app root, and `host.lando.internal` resolution active. Interactive commands compose with Bun Shell's pipes, redirection, globs, and built-ins so the same syntax works on Linux, macOS, and Windows.
- **Service mode.** With `--service <name>`, the REPL runs *inside* the named service via `RuntimeProvider.exec` with TTY allocation (the same mechanism `app:exec` and `app:ssh` use). The user's shell of choice (`SHELL` env var inside the service, falling back to `/bin/bash`) is invoked. Cancellation propagates through `Effect.interrupt` (§3.4).
- **Secrets.** `${secret:…}` references resolve through `SecretStore` (§4.2) only when explicitly used in a command typed at the prompt; the shell does NOT preload secret values into the environment. Secrets that *are* resolved during the session redact in lifecycle events and the active `Logger` per §3.4.
- **History.** Host-mode history is persisted at `<userCacheRoot>/shell/<app-id>/history`. `--no-history` disables persistence for the session. Lines that contain a resolved `${secret:…}` value are redacted before write regardless of `--no-history`.
- **Bootstrap level:** `app`. Runtime resources (provider connection in service mode, the `ShellRunner` `Scope` in host mode) are released by `Effect.scoped` when the user exits the REPL.
- **Lifecycle events** publish `cli-app:shell-init` / `cli-app:shell-run` / `cli-app:shell-error` per §3.5/§11.4. Per-command shell invocations *inside* the REPL publish `pre-shell-exec` / `post-shell-exec` (host mode) or `pre-provider-exec` / `post-provider-exec` (service mode); subscribers receive the redacted command shape, not the raw line.
- **Errors.** Without a TTY (`--no-interactive`, redirected stdin, CI), the command fails with `ShellRequiresTtyError` and remediation pointing at `app:exec --interactive --tty -- <command>` for non-interactive use cases.

#### 8.2.4 The `meta bun` and `meta x` commands

`lando meta bun` (default top-level alias `lando bun`) and `lando meta x` (default top-level alias `lando x`) are the **user-visible front door to the embedded Bun CLI** (§2.1). They are thin wrappers over `BunSelfRunner` (§3.4) that exist for three reasons: a user with only `lando` installed gets a working package manager and TS runner with no extra prerequisite; recipes can rely on `lando bun` / `lando x` being callable from `postInit.command` without a host Bun (§8.8.8); and core gets one observable, redacted, lifecycle-eventing entry point for ad-hoc Bun work instead of inviting plugin authors to construct ad-hoc `BUN_BE_BUN=1` children of their own.

```text
lando meta bun [<bun-argv>...]            # alias: lando bun
lando meta bun -- [<bun-argv>...]         # explicit argv passthrough; everything after `--` is forwarded verbatim
lando meta x <package>[@<version>] [<args>...]   # alias: lando x
```

Behaviors:

- **`meta:bun`** forwards every argument after `bun` to `BunSelfRunner.run(args)`. `lando bun install`, `lando bun add lodash`, `lando bun outdated`, `lando bun audit`, `lando bun test`, `lando bun build ./entry.ts`, `lando bun create vite my-app`, `lando bun run my-script` all behave the way the upstream `bun` CLI documents them. The `cwd` defaults to the user's current working directory; flags Lando *also* defines (e.g., `--help`, `--version`) are NOT intercepted — `lando bun --version` reports the *embedded Bun's* version, not Lando's, by routing the call through `BunSelfRunner.run(["--version"])`. Use `lando version` (or `lando meta version`) to get Lando's version.
- **`meta:x`** is a structured alias for `BunSelfRunner.x(spec, argv)` with a stricter contract than freeform `lando bun x …`: the first non-flag positional MUST be a package spec, and the remainder is the package's argv. Examples: `lando x prettier --write .`, `lando x @astrojs/cli init`, `lando x degit user/repo my-clone`. The structured form lets the renderer print "Running prettier@latest…" before the spawn, lets the perf-budget suite (§13.1) instrument bunx invocations specifically, and lets sandboxed `BunSelfRunner` plugins (§4.2) decide whether to allow `x` separately from `add`.
- **Bootstrap level:** `minimal`. Both commands construct `BunSelfRunner` (lazy at `minimal`; §3.4) and the active `Logger` / `Renderer` for output streaming. They do NOT bootstrap plugins, providers, or the app planner — `lando bun add lodash` works inside a directory that has no Landofile.
- **Lifecycle events** publish `cli-meta:bun-init` / `cli-meta:bun-run` / `cli-meta:bun-error` and `cli-meta:x-init` / `cli-meta:x-run` / `cli-meta:x-error` per §3.5/§11. Each child Bun spawn additionally publishes `pre-bun-self-exec` / `post-bun-self-exec` (§11.2).
- **Streaming output.** Both commands stream stdout/stderr in real time via `BunSelfRunner.stream`/`lines` so progress (e.g., a long `bun install`, a long `bun build`) is observable through the active `Renderer`. Cancellation propagates: `Effect.interrupt` (Ctrl+C) kills the embedded Bun child within the §3.4 cancellation budget.
- **Recursion guard.** `BunSelfRunner` sets `LANDO_DISALLOW_BUN_BE_BUN_REENTRY=1` in the child (§3.4); a Bun script invoked through `lando bun run …` that itself tries to `lando bun …` is rejected with `BunSelfReentryError`. Use `lando bun --help` to see the embedded Bun's documented escape hatches (e.g., explicit script paths) when you genuinely need recursion.
- **Top-level alias conflicts.** `lando bun` and `lando x` follow §8.1.2. The default top-level aliases `bun` and `x` are reserved by core; plugin contributions and tooling tasks that try to claim them are rejected with `CommandAliasConflictError` per the built-in-wins rule.
- **`hostProxyAllowed: false`.** Both commands MUST NOT be on the in-container `lando` shim allowlist (§10.10). A container that needs Bun should declare a `lando.bun-self` service feature (§6.11) — the container-side Bun primitive — instead of round-tripping through the host. Allowing `lando bun` over the host proxy would let a container install host-global packages or run host-side `bun create` against the user's home directory, both of which violate the host-proxy threat model.
- **Offline mode.** When the user's effective configuration declares `offline: true` (§7.5), `meta:x` refuses uncached packages with `BunSelfOfflineError` and suggests `lando bun add <pkg>` (which writes the user's lockfile and lets the next `lando x` hit the cache). `meta:bun` passes the offline flag through to the embedded Bun unchanged.
- **Errors.** Non-zero embedded Bun exit produces `BunSelfExecError` with the redacted argv and the embedded Bun's stderr. The Lando exit code matches the embedded Bun's exit code so CI scripts can assert on it identically to a real `bun …` invocation.

### 8.3 Command contract

Every command, whether built-in or contributed by a plugin, conforms to the `LandoCommandSpec` shape. The OCLIF adapter compiles this into an OCLIF `Command` subclass.

```ts
export type CommandNamespace = "app" | "apps" | "meta" | string;

export interface LandoCommandSpec<A = void, E = LandoCommandError> {
  readonly id: string;                                   // canonical id, e.g. "app:start", "meta:plugin:add"
  readonly namespace: CommandNamespace;                  // "app" | "apps" | "meta" | a plugin cspace topic
  readonly summary: string;
  readonly description?: string;
  readonly aliases?: ReadonlyArray<string | { name: string; deprecated?: DeprecationNotice }>;
  readonly topLevelAlias?:
    | boolean
    | string
    | ReadonlyArray<string>
    | { name: string | ReadonlyArray<string>; deprecated?: DeprecationNotice };
  readonly examples?: ReadonlyArray<string>;
  readonly hidden?: boolean;
  readonly bootstrap: BootstrapLevel;                    // declares what the command needs
  readonly flags?: ReadonlyArray<FlagSpec>;
  readonly args?: ReadonlyArray<ArgSpec>;
  readonly deprecated?: DeprecationNotice;               // command-wide deprecation; see §18
  readonly recipePostInitAllowed?: boolean;              // true only for commands in the generated recipe allowlist (§8.8.8)
  readonly hostProxyAllowed?: boolean;                   // true only for commands safe to invoke from inside a container via the in-container `lando` shim (§10.10)
  readonly docs?: CommandDocsMetadata;
  readonly acceptance?: ReadonlyArray<AcceptanceCheckId>;
  readonly run: (input: CommandInput) => Effect.Effect<A, E, LandoCommandRequirements>;
}

export interface CommandInput {
  readonly args: Record<string, unknown>;
  readonly flags: Record<string, unknown>;
  readonly raw: ReadonlyArray<string>;                   // unprocessed argv after `--`
  readonly stdin: Stream.Stream<Uint8Array>;
  readonly stdout: Sink.Sink<unknown, Uint8Array>;
  readonly stderr: Sink.Sink<unknown, Uint8Array>;
}
```

Rules:

- `id` is the canonical id including the namespace prefix (`app:start`, `meta:plugin:add`). The OCLIF adapter parses the prefix to derive the topic path.
- `namespace` MUST equal the prefix segment of `id`. Mismatches are rejected at registration with a tagged `CommandRegistrationError`.
- `aliases` is a list of additional **namespaced** aliases (for example, `apps:halt` aliasing `apps:poweroff`). Each entry may be a bare string (the alias name) or an object `{ name, deprecated? }` declaring a per-alias `DeprecationNotice` (§18.5). Top-level aliases use `topLevelAlias` instead and are interpreted per §8.1.2.
- `topLevelAlias` defaults to `false`. The shipped built-ins in §8.2 declare their default top-level aliases explicitly. The object form `{ name, deprecated }` declares a `DeprecationNotice` for the top-level alias independently of the canonical command (§18.5).
- `deprecated` declares a command-wide `DeprecationNotice` (§18.2). When set, every invocation of the command (canonical id or any alias) records a `deprecation-used` event with `kind: "command"` and `id: <canonical-id>`. A non-deprecated alias of a deprecated canonical raises `DeprecationContradictionError` at registration (§18.3).
- `FlagSpec.deprecated?` and `ArgSpec.deprecated?` declare `DeprecationNotice`s scoped to the flag or arg. Using a deprecated flag/arg records `kind: "flag"` / `kind: "arg"` with `id: "<canonical-id>.<flag-or-arg-name>"`.
- `recipePostInitAllowed` defaults to `false`. Setting it to `true` adds the command to the generated recipe post-init command allowlist, subject to §8.8.8 constraints and tests.
- `hostProxyAllowed` defaults to `false`. Setting it to `true` adds the command to the generated **host-proxy `runLando` allowlist** (§10.10) — the set of canonical command ids the in-container `lando` shim is permitted to forward to the host. Lifecycle commands (`app:start`, `app:stop`, `app:rebuild`, `app:destroy`, `apps:poweroff`) MUST NOT set this true; they would self-destruct the container that issued the call. Read-only and laterally-scoped commands (`app:info`, `app:logs`, `app:exec`, `app:ssh`, `apps:list`, `meta:version`, `meta:doctor`, `meta:events:follow`, `app:config get|view`) are the typical opt-ins. The flag generates the `host-proxy-allowlist` cache (§12.1); the host-side `HostProxyService` rejects any `runLando` request whose canonical id is not in that cache with `HostProxyCommandNotAllowedError`.
- `docs` and `acceptance` metadata feed generated command reference docs and acceptance coverage checks; public commands MUST provide both.

The adapter wires `process.stdin/stdout/stderr` into Effect `Stream`/`Sink` instances so commands compose cleanly with Effect's IO.

### 8.4 OCLIF integration

OCLIF is consumed in *one place only*: `src/cli/oclif/`. Outside that directory, no module imports `@oclif/core`. The integration policies:

- **Pre-OCLIF level-`none` fast path.** Before any `import("@oclif/core")` resolves, `bin/lando.ts` MUST argv-sniff for the level-`none` shapes enumerated in §3.2 and short-circuit to a static-print exit on match. The fast path is hand-rolled string matching against `process.argv`; it never imports OCLIF, the Effect runtime, or any plugin code. An argv shape that *looks* like a level-`none` command but carries unrecognized flags falls through to the OCLIF path.
- **Manifest-first.** `oclif.manifest.json` is generated at build time for built-in command shims. Lando's plugin and app command indexes (`plugin-command`, `app-command`; §12.1) provide runtime command metadata and are refreshed on plugin install/remove/update, app planning, and `app:cache:refresh`.
- **Hooks bridge to Effect.**
  - OCLIF `init` hook runs the router phase only: load embedded command metadata, read command indexes from cache, consult the `cwd-app-map` cache (§12.1), register command shims and aliases, and avoid full Effect runtime construction.
  - After OCLIF resolves the canonical command id, the command base class provides the AOT-composed bootstrap layer (§17.2 codegen, "Bootstrap layers") for that command's declared/effective `BootstrapLevel` and then publishes the `cli-<canonical-id>-init` lifecycle event (e.g., `cli-app:start-init`).
  - OCLIF `postrun` hook publishes the `cli-<canonical-id>-run` event on success (e.g., `cli-app:start-run`).
  - OCLIF error path / `command_not_found` publishes `cli-<canonical-id>-error`. The full mapping is in §11.4.
- **No live discovery in the router.** Router bootstrap reads the generated OCLIF manifest plus Lando's command indexes. It MUST NOT parse Landofiles, resolve includes, contact plugin sources, import plugin command modules, or initialize providers. Plugin command modules are imported only after their shim has been resolved and the command runtime bootstrap has completed.
- **`SIGINT` → Effect interruption.** The OCLIF entrypoint installs a signal handler that calls `Effect.interrupt` on the running fiber. Providers' resource scopes finalize automatically.
- **Help rendering** uses OCLIF's standard help class, customized to:
  - Group built-in commands by namespace (`app`, `apps`, `meta`) and plugin-owned topic.
  - Surface Lando's `bootstrap:` level on each command page.
  - Render tooling commands grouped under `app:` (with their `toolingIncludes:` sub-namespace where applicable).
  - Print a "Common commands" group at the top of `lando --help` listing every active top-level alias with a pointer to its canonical id.
- **Topic separators.** Both `:` and ` ` are accepted (`flexibleTaxonomy: true`). `lando app:start` and `lando app start` are equivalent.

**Namespace-to-topic mapping.** A canonical command id like `app:start` is a two-segment OCLIF id (topic `app`, command `start`). Three-segment ids like `meta:plugin:add` produce a nested topic (`meta` topic, `plugin` sub-topic, `add` command). The OCLIF adapter generates `Topics` entries from the registered namespaces and registers each canonical command under its topic. **Top-level aliases** (§8.1.2) are registered as additional OCLIF commands sharing the same `run()` implementation; they are flagged in the manifest with an `aliasOf:` pointer to the canonical id and rendered in the "Common commands" help group rather than under their topic.

### 8.5 Tooling schema

`tooling:` is Lando's Taskfile-inspired task runner surface. It is not a promise of 1:1 compatibility with `Taskfile.yml`; Lando borrows the durable concepts (`cmds`, `deps`, `vars`, `sources`, `generates`, `status`, `preconditions`, `run`) and adapts execution to services, providers, lifecycle events, Effect Schema, and the hot-path cache.

The canonical Landofile key remains `tooling:` for v4. A tooling entry is also called a **Lando task** when describing dependency graphs and step execution.

**Tooling tasks register under the `app:` namespace by default** (§8.1.1). A task named `composer` is invoked canonically as `lando app composer`; setting `topLevelAlias: true` on the task additionally registers `lando composer`. A task MAY opt into a different namespace by setting `namespace:` (rare; documented in §8.5.1). Task names MAY contain `:` for sub-namespaces inside `app:`; for example, `tooling.db:wait` produces canonical id `app:db:wait`.

```yaml
toolingDefaults:
  method: checksum
  run: always
  dotenv:
    - .env
  vars:
    APP_ENV: "{{ .env.APP_ENV | default \"local\" }}"

toolingIncludes:
  frontend:
    file: ./frontend/.lando.tasks.yml
    dir: ./frontend
    aliases: [fe]
    optional: true
    flatten: false

tooling:
  composer:
    desc: Run Composer in appserver
    service: appserver
    cmd: composer
    passThrough: true

  assets:
    desc: Build frontend assets
    service: node
    dir: /app/frontend
    sources:
      - package.json
      - bun.lock
      - src/**/*
    generates:
      - dist/manifest.json
    cmds:
      - bun install
      - bun run build

  test:
    desc: Run the test suite
    deps:
      - assets
      - task: db:wait
        silent: true
    service: appserver
    cmds:
      - composer install
      - "php vendor/bin/phpunit {{ .raw | shellJoin }}"

  db:wait:
    internal: true
    service: database
    status:
      - mysqladmin ping -h database
    cmds:
      - ./scripts/wait-for-db.sh
```

#### 8.5.1 Task definition

```yaml
tooling:
  <name>:
    cmd: <Command>
    cmds: <Command[]>
    deps: <TaskDependency[]>

    desc: <string>                       # short help/list text
    summary: <string>                    # long help/summary text
    description: <string>                # alias of summary for v3-familiar docs
    usage: <string>
    examples:
      - <string>
    aliases:                             # additional namespaced aliases (within the task's namespace)
      - <string>
    topLevelAlias: true | <string> | <string[]>   # registers a top-level alias (§8.1.2); default false
    namespace: app | apps | meta | <plugin-cspace> # default: app
    internal: true | false               # hidden from help/list, callable by other tasks

    service: <string | ":flag-name" | ":host">
    engine: <toolingEngine-id>
    bootstrap: tooling | provider | app
    user: <string>
    dir: <portable-path>
    appMount: <portable-path>
    stdio: inherit | pipe
    interactive: true | false            # forces TTY allocation
    passThrough: true | false            # forwards argv after -- into .raw / command

    vars: <map>
    env: <map>
    dotenv:
      - <path>

    sources: <Glob[]>
    generates: <Glob[]>
    method: checksum | timestamp | none
    status: <Command[]>
    preconditions: <Precondition[]>
    if: <Expression | shell-test-string>
    run: always | once | when_changed
    platforms:
      - linux | darwin | win32 | wsl | <os>/<arch> | <arch>

    prompt: <string | string[]>
    silent: true | false
    output: interleaved | group | prefixed
    failFast: true | false
    disabled: true | false
    hostProxyAllowed: true | false       # opt-in: allow this task to be invoked via the in-container `lando` shim (§10.10); default false

    deprecated: <DeprecationNotice>      # task-wide deprecation notice; see §18

    flags:
      <name>: <FlagSpec>                 # Effect Schema-defined; FlagSpec accepts `deprecated` per §18.5
    args:
      <name>: <ArgSpec>                  # ArgSpec accepts `deprecated` per §18.5
```

Shorthands:

- `tooling.<name>: <string>` means `{ cmd: <string> }`.
- `cmd` is a single command shorthand for `cmds: [{ cmd: ... }]`.
- `cmds: ["a", "b"]` is a sequential command list in the task's resolved service.
- `description` is accepted as an alias for `summary`; generated docs SHOULD render `desc` and `summary` as the preferred names.
- `tooling.<name>: disabled` and `tooling.<name>: false` disable an inherited or fragment-provided task (§7.7, §8.5.8).

**Namespace and aliases.**

- `namespace:` defaults to `app`. Most tasks live in `app:` and never set this field. A task MAY set `apps`, `meta`, or a plugin-owned topic when its semantics warrant it; setting a core namespace not under `app` requires the user to acknowledge the implication (these tasks run without an app context unless they declare `bootstrap: app`).
- Task names MAY contain `:` for sub-namespaces within the task's chosen namespace. With `namespace: app` (default), `tooling.db:wait` becomes canonical id `app:db:wait`. With `namespace: meta`, `tooling.cleanup:caches` becomes `meta:cleanup:caches`.
- OCLIF flexible taxonomy (§8.4) means `lando app db:wait` and `lando app db wait` resolve to the same command when unambiguous.
- `topLevelAlias` is interpreted per §8.1.2. A task with `topLevelAlias: true` exposes the task's last segment as a bare top-level alias (`db:wait` → `lando wait`); use a string to set an explicit alias name (`topLevelAlias: db-wait`).

**Conflict rules.** Built-in command ids are reserved; a tooling task that collides with a built-in or plugin command at the same canonical id MUST be namespaced differently or rejected with remediation. Top-level alias collisions follow §8.1.2.

**Host-proxy opt-in.** `hostProxyAllowed: true` adds the task's canonical id to the `host-proxy-allowlist` cache (§12.1) so the in-container `lando` shim may forward to it (§10.10). Tasks default to `false` because most projects' tooling tasks have lifecycle side effects (e.g., `assets` rebuild) that are surprising when invoked from inside a service. A task that wraps a host-side helper (e.g., `lando launch <url>` running `service: :host`) is the natural opt-in case.

#### 8.5.2 Commands and dependencies

```yaml
tooling:
  build:
    deps:
      - clean
      - task: assets
        vars:
          MODE: production
    cmds:
      - cmd: composer install
        service: appserver
      - task: assets:manifest
      - command: app:info             # invoke another canonical command
        flags:
          format: json
          deep: true
      - cmd: php artisan cache:warm
        if: "{{ eq .vars.APP_ENV \"prod\" }}"
      - defer: php artisan down --retry=60
        service: appserver
```

Command entries can be:

- **String** — shell command executed by the selected `ToolingEngine`.
- **Object with `cmd`** — command plus per-step overrides (`service`, `dir`, `env`, `user`, `platforms`, `if`, `silent`, `ignoreError`, `interactive`).
- **Object with `task`** — serial call to another tooling task, optionally with `vars` and `silent`.
- **Object with `command`** — invoke another canonical command (built-in, plugin-contributed, or tooling) by its canonical id (§8.5.2.1).
- **Object with `defer`** — command or task to run in LIFO order when the current task exits, including on failure or interruption when the engine can guarantee finalization.
- **Object with `for`** — loop over an explicit list, a variable, `sources`, `generates`, or a matrix; each iteration receives `.item` and, for maps, `.key`.

Dependencies (`deps`) run before the task's own `cmds`. Independent dependencies run concurrently by default through Effect fibers. `failFast: true` interrupts remaining dependencies when one fails. Serial composition uses `cmds: [{ task: ... }, ...]`.

##### 8.5.2.1 The `command:` step

A `command:` step invokes another canonical command from inside a tooling task. This is the structured way to wrap, extend, or compose around built-ins and plugin commands. Combined with the Landofile-level `commandAliases:` override (§8.1.2), it lets a project redefine what `lando start` (or any top-level alias) actually does without losing access to the underlying built-in.

```yaml
cmds:
  - command: <canonical-id>          # required; e.g. "app:start", "meta:plugin:add", "app:db:wait"
    flags:                           # optional; structured flags map, validated against the target's spec
      <name>: <value>
    args:                            # optional; structured args map, validated against the target's spec
      <name>: <value>
    raw:                             # optional; raw argv passed after `--`
      - <string>
    silent: true | false             # optional; suppress the target's renderer output
    ignoreError: true | false        # optional; continue the parent task on target failure
    if: <expression>                 # optional; conditional invocation
```

Semantics:

- **Resolution.** The `<canonical-id>` MUST resolve to a registered command at compile time. Unknown ids fail with `ToolingCommandLookupError` and remediation listing close matches.
- **Schema validation.** `flags`, `args`, and `raw` are validated against the target command's `LandoCommandSpec` (§8.3) at compile time when the values are literal, and at invocation time when they are expression-resolved. Mismatches surface as `CommandInputValidationError` with the offending key and the expected schema.
- **No flag passthrough.** The outer task does **not** automatically forward its flags/args to the inner command. Pass values explicitly via expressions: `flags: { rebuild: "{{ .flags.rebuild | default false }}" }`.
- **Recursion guard.** Direct cycles (`app:my-start` → `command: app:my-start`) are rejected at compile time with `ToolingCommandCycleError`. Indirect cycles are detected at the same pass over the task graph; runtime invocation cannot loop because the cache stores the resolved acyclic graph.
- **Bootstrap escalation.** A task's effective `bootstrap:` level is the maximum of its declared level and the target of every `command:` step it contains (transitively). A task at `bootstrap: tooling` that contains `command: app:start` is auto-escalated to `bootstrap: app`. The escalation is computed at compile time and stored in the cached `ToolingProgram`; the hot path stays optimal when no `command:` step needs escalation.
- **Lifecycle events.** The target command publishes its own `cli-<canonical-id>-init`, `cli-<canonical-id>-run`, and `cli-<canonical-id>-error` events (§3.5/§11). Subscribers that watch for `cli-app:start-run` still fire when `app:start` is invoked from inside a wrapper task.
- **Output.** The target's output flows through the same `Renderer` as the parent task. `silent: true` suppresses only the target's renderer events; the target's logs still go through the active `Logger` at their declared level.
- **Cancellation.** `Effect.interrupt` propagates from the outer task to the inner command. The target's resource scopes finalize per §2.4 and §3.6.
- **Bare canonical ids only.** `command:` accepts canonical ids (`app:start`), not top-level aliases (`start`). This keeps the wrap explicit and prevents an alias override from accidentally short-circuiting itself.

The `command:` step does **not** re-parse argv through OCLIF. It calls the same Effect program that backs `@lando/core/cli`'s `appStart`, `metaPluginAdd`, etc. (§16.7), so wrap behavior in the CLI and in an embedding host is identical.

The intended composition pattern is a Landofile `commandAliases.custom:` entry (§8.1.2) pointing at a wrapper tooling task whose `cmds:` invoke the original built-in via `command:`. Subscribers to the wrapped command's lifecycle events still fire because the inner invocation goes through the canonical Effect program; the canonical id (e.g., `lando app start`) remains callable directly.

##### 8.5.2.2 Wrapping a built-in: worked example

To make `lando start` print a banner, run the built-in start, then probe a health endpoint, the user combines a Landofile-level alias override (§8.1.2) with a tooling task that uses `command:`:

```yaml
# .lando.yml
commandAliases:
  custom:
    start: app:my-start              # in this app, `lando start` runs `app:my-start`

tooling:
  my-start:
    desc: Start with welcome banner and health probe
    cmds:
      - cmd: 'echo "Welcome! Starting your app…"'
        service: :host

      - command: app:start           # invoke the actual built-in
        flags:
          rebuild: "{{ .flags.rebuild | default false }}"

      - cmd: 'curl -sf http://appserver:8080/healthz | jq .'
        service: appserver
```

When the user runs `lando start --rebuild`:

1. OCLIF resolves `start` via the Landofile-overridden alias → canonical id `app:my-start`.
2. The runtime bootstraps at level `app` (auto-escalated because `command: app:start` requires it).
3. The banner step runs on the host through `ShellRunner` via the `host` ToolingEngine.
4. The `command: app:start` step invokes the built-in's Effect program with `--rebuild` forwarded explicitly. Subscribers to `cli-app:start-run` still fire.
5. The health probe runs in `appserver` through the active `ToolingEngine`.

`lando app start --rebuild` (canonical) is unaffected; it always runs the built-in. The override only re-binds the bare top-level alias for the app's command registry.

#### 8.5.3 Variables and environment

`vars` are expression values; `env` are environment variables passed to commands. Resolution order, highest precedence first:

1. Task-call `vars` from a dependency or `cmds[].task` entry.
2. CLI flag/arg-derived values.
3. Task-local `vars` / `env`.
4. Included tooling file `vars`.
5. `toolingIncludes.<namespace>.vars`.
6. `toolingDefaults.vars` / `toolingDefaults.env`.
7. Process environment exposed under `.env`.

Static values are expression-resolved with the config-wide expression language (§7.3.1). Dynamic command variables use explicit `sh` and are evaluated at invocation time, not during command registration:

```yaml
tooling:
  version:
    service: :host
    vars:
      GIT_SHA:
        sh: git rev-parse --short HEAD
    cmd: echo "{{ .vars.GIT_SHA }}"
```

Dynamic `sh` values run through the task's selected engine. For `service: :host` they run through `ShellRunner` (the `Bun.$`-backed primitive; §3.4) so multi-line `sh:` snippets, pipes, redirection, and built-in `rm`/`mkdir`/glob behavior work cross-platform without a per-OS code path; for service tasks they run through provider exec. Interpolated values inside `sh:` (including `{{ … }}` expression results and `${secret:…}` references) are escaped by default per Bun Shell's safe-by-default rules (§3.4); explicit `{ raw: "…" }` is required to opt out, and use of `raw:` is rejected at compile time inside `vars.<name>.sh:` because dynamic vars are not a place that needs unsafe interpolation. Dynamic vars are not written to the command cache or app-plan cache.

#### 8.5.4 Expressions in tooling

Tooling uses the config-wide expression language (§7.3.1) and adds the following invocation scopes. Per the staged-resolution model in §7.3.1, every scope below has an effective bootstrap level of "tooling invocation"; expressions that reference these scopes are held as AST thunks in the cached `ToolingProgram` (§8.7) and resolved when the step actually runs, not at parse, plan, or registration time.

| Scope | Meaning |
|---|---|
| `task.name` | Task name as defined under `tooling.<name>:` (e.g., `db:wait`) |
| `task.subnamespace` | Prefix of `task.name` before the final `:` segment, if any (e.g., `db`); empty string when the task name has no `:` |
| `task.commandNamespace` | The command namespace the task registers under (`app` by default; §8.1.1) |
| `task.canonicalId` | Full canonical command id (e.g., `app:db:wait`) |
| `flags.<name>` | Parsed flag values |
| `args.<name>` | Parsed arg values |
| `raw` | Raw argv after `--` when `passThrough: true` |
| `service` | Resolved service target for the current command step |
| `sources`, `generates` | Expanded file lists for the task |
| `checksum` | Stable checksum of `sources` when `method: checksum` |
| `timestamp` | Last-run timestamp when `method: timestamp` |
| `item`, `key` | Loop item/key during `for` execution |

Examples (showing both filter-pipe and call-style helper forms — they are equivalent per §7.3.1):

```yaml
tooling:
  phpunit:
    service: appserver
    passThrough: true
    cmd: "php vendor/bin/phpunit {{ raw | shellJoin }}"

  build-image-tag:
    service: :host
    vars:
      # Filter-pipe form
      TAG: "{{ env.CI_COMMIT_SHA | default(checksum) }}"
    cmd: echo "{{ vars.TAG | lower }}"

  serve:
    service: appserver
    # Native shell-parameter-expansion is part of the same engine —
    # CI templates that already use ${VAR:-default} keep working.
    cmd: "node server.js --port=${PORT:-3000}"

  list-endpoints:
    service: :host
    cmd: |
      {{ for ep in service.endpoints }}
      echo "{{ ep.protocol }}://localhost:{{ ep.port }}"
      {{ end }}
```

Expressions are evaluated before each command step runs, after flags/args, dynamic service resolution, dependency call vars, and dynamic vars are known. An expression that references `service.endpoints` is naturally gated to bootstrap level `app` (§7.3.1 scope-to-level table); the tooling engine resolves it after `LandoRuntimeLive` is constructed at the task's effective level.

#### 8.5.5 Dynamic service resolution

- `service: <name>` — fixed service.
- `service: :flag-name` — value from `--flag-name` flag.
- `service: :host` — bypass the provider, run on host through the bundled `host` ToolingEngine, which is `ShellRunner`-backed (§8.6, §3.4). Multi-line `cmds:` get pipes, redirection, globs, command substitution, and built-in `rm`/`mkdir`/`cat`/`mv`/`which` that work the same on Linux, macOS, and Windows without `cross-env`, `rimraf`, or PowerShell branches.

Command objects MAY override `service`. Host execution is explicit and potentially dangerous; renderers SHOULD show a warning for first-time host tasks unless `silent: true` or non-interactive mode suppresses prompts. Host tasks still flow through `ShellRunner` for redaction, lifecycle events (`pre-shell-exec` / `post-shell-exec`), and cancellation, and through `PrivilegeService` for escalation when the task declares it needs root/admin; they MUST NOT shell out through ad hoc platform APIs. Tasks that need argv-precise execution against an external binary (no shell parsing) SHOULD pick a `ProcessRunner`-backed engine via `engine:` rather than emulating it through a single-string `cmd:` (§3.4).

#### 8.5.6 Up-to-date checks and run policy

`sources`, `generates`, `status`, `method`, and `run` prevent unnecessary work:

- `method: checksum` hashes expanded `sources` and stores the result in the app task cache.
- `method: timestamp` compares source mtimes against generated files or the task's last successful run.
- `method: none` disables file fingerprinting.
- `status` commands returning exit code `0` mark the task up to date.
- `preconditions` are the inverse: they must return `0`; otherwise the task fails before dependencies or commands run.
- `run: always` always attempts execution after up-to-date checks.
- `run: once` runs only once per top-level invocation graph.
- `run: when_changed` runs once for each unique combination of task name, vars, flags, args, and source fingerprint.

`lando <task> --force` bypasses status/fingerprint skips. `lando <task> --status` exits non-zero if the task is not up to date and does not execute commands.

#### 8.5.7 Events as tasks

Landofile `events:` can call tooling tasks, shell commands, and canonical commands:

```yaml
events:
  post-start:
    - task: db:wait
    - task: assets
      vars:
        MODE: development
    - command: app:info             # invoke a canonical command from a lifecycle hook
      flags:
        format: json
        deep: false
      silent: true
```

Event entries accept the same step types as `cmds:` (§8.5.2): string, `cmd:`, `task:`, `command:`, `defer:`, `for:`. Event task and command calls execute through the same tooling graph compiler and expression evaluator. Event expressions add `.event` containing the decoded event payload. Event-triggered tasks MUST NOT register OCLIF commands; they execute directly through the runtime.

Event subscribers that wrap a CLI command (e.g., adding a banner before `app:start`) SHOULD prefer the wrap pattern in §8.5.2.1 over `events.pre-start:`, because lifecycle events fire on every code path that triggers the lifecycle (including `app:restart`, `app:rebuild`, and embedding-host invocations) while a `commandAliases.custom` override + wrapper task fires only when the user invokes that specific top-level alias.

#### 8.5.8 Tooling includes

Tooling definitions are imported through the unified `includes:` surface (§7.7) with `kind: tooling`. The legacy shorthand `toolingIncludes:` is preserved as idiomatic sugar; both forms resolve through the same machinery and may be used interchangeably.

```yaml
# Canonical form
includes:
  - source: ./docs/.lando.tasks.yml
    kind: tooling
    namespace: docs
    flatten: false
    internal: false
    aliases: [documentation]
    excludes: [publish]
    vars:
      DOCS_PORT: 4321

# Equivalent shorthand
toolingIncludes:
  docs:
    file: ./docs/.lando.tasks.yml
    dir: ./docs
    optional: false
    flatten: false
    internal: false
    aliases: [documentation]
    excludes: [publish]
    vars:
      DOCS_PORT: 4321
    checksum: sha256:...
```

Rules:

- Included files use the same `tooling`, `toolingDefaults`, and `toolingIncludes` shape as the parent, not a full Landofile unless explicitly named `.lando.yml`.
- Relative paths resolve from the file that declares the include.
- Included tasks are namespaced as `<include-namespace>:<task>` unless `flatten: true`. The include-namespace is a sub-namespace **within the task's command namespace** (default `app`). For example, an include declared as `toolingIncludes.frontend:` produces canonical command ids of the form `app:frontend:<task>`.
- `aliases` alias the include-namespace at the same command-namespace level (a `frontend` include with `aliases: [fe]` produces both `app:frontend:<task>` and `app:fe:<task>`).
- `optional: true` suppresses missing-file errors.
- `internal: true` marks all included tasks internal.
- `checksum` is required for remote includes when remote includes are enabled in a future release; v4.0.0 only requires local file includes.
- `excludes` removes tasks from the include before flattening or namespace registration.
- Cyclic includes are rejected with a tagged `ToolingIncludeCycleError`.

Per-include `topLevelAlias` settings on individual tasks within an included file behave identically to top-level Landofile-defined tasks (§8.5.1). An include MAY NOT set a single `topLevelAlias` at the include level that applies to all of its tasks; per-task aliases keep collision detection precise.

#### 8.5.9 `.bun.sh` script-backed tasks

For tooling whose body is "run this multi-line cross-platform shell script," the YAML form gets noisy. The `.bun.sh` source form lets a project ship a script file that becomes a first-class tooling task at compile time without a `tooling:` entry.

**Discovery.**

- `.lando/scripts/<name>.bun.sh` files under the app root are auto-discovered during the tooling compilation pipeline (§8.7).
- Each file becomes a tooling task at canonical id `app:<name>` (subject to the namespace rules in §8.5.1). Sub-namespaces are encoded by directory: `.lando/scripts/db/wait.bun.sh` registers `app:db:wait`.
- A `tooling.<name>:` entry in the Landofile of the same canonical id wins over an auto-discovered script and is reported during compilation as an explicit override.
- `.bun.sh` task discovery is ON by default for the CLI imperative shell when the app root contains a `.lando/scripts/` directory and OFF by default for library mode (the embedding host opts in via `makeLandoRuntime({ autoDiscoverBunShellScripts: true })`; §16.5).

**Front-matter.**

The first contiguous comment block at the top of a `.bun.sh` file is parsed as YAML front-matter when wrapped in `# ---` markers and uniformly prefixed with `# `. The front-matter supplies the same metadata fields a `tooling:` entry would: `desc`, `summary`, `aliases`, `topLevelAlias`, `service`, `bootstrap`, `flags`, `args`, `passThrough`, `sources`, `generates`, `status`, `preconditions`, `run`, `platforms`, `internal`, `disabled`. Front-matter MUST validate against the `BunShellScriptFrontMatter` schema published from `@lando/sdk`; a missing or malformed front-matter block fails the compile pass with `BunShellScriptFrontMatterError`. An empty `.bun.sh` file is rejected with `BunShellScriptEmptyError`.

Without an explicit `service:` field, scripts default to `service: :host` and execute through the `host` ToolingEngine (§8.6).

**Example.**

```sh
#!/usr/bin/env bun
# ---
# desc: Build the app for production
# topLevelAlias: build
# sources:
#   - src/**/*
#   - package.json
#   - bun.lock
# generates:
#   - dist/manifest.json
# ---
import { $ } from "bun";

await $`bun run build`;
await $`tsc -b && bun build src/index.ts --outdir dist`;
```

**Execution.**

- Scripts run through `ShellRunner.runScript()` (§3.4). The runner verifies that the resolved file path stays inside the app root (or the user-config-root recipe cache, for recipe-bundled scripts; §8.8.8) and refuses paths whose realpath escapes the permitted base with `ShellScriptOutsideRootError`.
- The Bun runtime invoked is the `bun` binary on PATH (library-mode) or the binary embedded in the compiled CLI. Scripts MUST NOT depend on host-installed Node.js.
- Cancellation, redaction, lifecycle events, and `${secret:…}` resolution behave identically to YAML-defined host tasks (§8.5.5).
- `sources`/`generates`/`status`/`run` (§8.5.6) work the same way as for YAML tasks. The cached fingerprint includes the script's checksum so editing the script invalidates the up-to-date result.
- Front-matter `flags:` and `args:` produce parsed values available as `process.env.LANDO_FLAG_<NAME>` / `process.env.LANDO_ARG_<NAME>` and as a JSON document on `process.env.LANDO_INPUT` (the same shape as `CommandInput` in §8.3, serialized). Scripts MAY parse the JSON for typed access.
- The script body MAY use any Bun API. In particular, `Bun.$` is available without import for shell-shaped composition.

Bun.$'s built-in `cd`/`ls`/`rm`/`mkdir`/`mv`/`which` make `.bun.sh` scripts portable to Windows without `cross-env`, `rimraf`, or PowerShell branching (§3.4 ProcessRunner-vs-ShellRunner table).

### 8.6 The `ToolingEngine` abstraction

The `ToolingEngine` is the pluggable component that turns a compiled Lando task graph into provider or host operations.

```ts
export class ToolingEngine extends Context.Service<ToolingEngine, {
  readonly id: string;
  readonly canHandle: (spec: ToolingSpec) => boolean;
  readonly compile: (spec: ToolingSpec) => Effect.Effect<ToolingProgram, ToolingCompileError>;
  readonly execute: (program: ToolingProgram, input: CommandInput) => Effect.Effect<ExecResult, ToolingExecError, RuntimeProvider | ProcessRunner | ShellRunner>;
}>()("@lando/core/ToolingEngine") {}
```

**Default tooling engine: `providerExec`.** The default tooling engine is distinct from the default runtime provider: it means service-targeted tooling runs through the active `RuntimeProvider`, whose default is the Lando-managed runtime (`@lando/provider-lando`) unless app/global config selects another provider. `providerExec` prefers `RuntimeProvider.exec` against running services, falling back to `RuntimeProvider.run` (ephemeral) only when explicitly configured. Multi-line scripts are encoded and executed through the engine's choice of mechanism (typically a base64-encoded `sh -c` script, but engines may use mounted files, persistent helpers, or other techniques). The engine receives already-validated task graphs but evaluates invocation-time expressions and dynamic vars only when the corresponding step runs.

**Built-in alternative: the `host` engine.** Core ships a `host` engine alongside `providerExec` for tasks that target `service: :host` or set `engine: host`. The `host` engine is `ShellRunner`-backed (§3.4): it executes each step through `Bun.$` so pipes, redirection, globs, command substitution, and built-in `rm`/`mkdir`/`cat`/`mv`/`which` work the same on Linux, macOS, and Windows without `cross-env`, `rimraf`, or PowerShell branches. Multi-line `cmds:` are concatenated into one Bun Shell template per step; `${…}` interpolation runs through Bun Shell's safe-by-default escaping. The `host` engine is also what backs `.bun.sh` script-backed tasks (§8.5.9), tooling `vars.<name>.sh:` evaluation for host-targeted tasks (§8.5.3), and the `lando shell` REPL (§8.2.3).

**Other plugin-shipped engines:**

- `processExec` — argv-precise host execution through `ProcessRunner` (no shell parsing). Plugin-supplied for tasks that wrap an external binary whose arguments must NOT be re-interpreted by Bun Shell. Core does not bundle a `processExec` engine in v4.0.0 because every observed core need is shell-shaped; users who need it install a plugin.
- `remote` — runs against a remote provider (SSH, k8s exec).
- `dryRun` — prints what would run without executing. Useful for CI.

**Selection precedence:** command-step `engine` → `tooling.<name>.engine` → `toolingDefaults.engine` → Landofile-level `toolingEngine` → global config `toolingEngine` → default `providerExec`.

### 8.7 Tooling compilation pipeline

```text
Landofile tooling entries + tooling includes
  + .lando/scripts/**/*.bun.sh discovery (§8.5.9)
      ↳ YAML front-matter parsed against `BunShellScriptFrontMatter` (Effect Schema)
      ↳ canonical id derived from path (`.lando/scripts/db/wait.bun.sh` → `app:db:wait`)
      ↳ Landofile `tooling.<id>:` entry of the same canonical id wins; otherwise the script is registered
  → raw schema validation (Effect Schema accepts expression-bearing values; `.bun.sh` tasks validate against `BunShellScriptFrontMatter` and the common `ToolingTask` shape together)
  → config expression resolution for compile-time values
  → resolved schema validation (Effect Schema)
  → include flattening / namespace registration (script-backed tasks merge in alongside YAML-backed tasks under the same canonical id space)
  → task graph construction + cycle detection
  → command-registry lookup for every `command:` step (compile-time)
  → command-step recursion / cycle detection
  → effective bootstrap level deduction (max of declared + every reachable command target)
  → service + flag/arg metadata resolution
  → engine selection
  → engine.compile(spec) → ToolingProgram(s)
  → OCLIF command shim metadata generation
  → app command index + app-plan cache write
  → on invocation: OCLIF parses argv → invocation expressions/dynamic vars → engine.execute(program, input)
```

**Cache hot path.** Tooling routing metadata is stored in the app command index, while the compiled `ToolingProgram` graph is stored in the app plan cache. The app command index contains only routing-safe metadata: canonical ids, namespace assignments, summaries, flag/arg specs, aliases, top-level aliases, effective bootstrap levels, and the app-plan cache key. The `ToolingProgram` includes task metadata, dependencies, command step plans (including resolved `command:` targets and their input schemas), expression ASTs, static vars/env, source/generate glob specs, status/precondition plans, engine ids, **resolved canonical command ids, namespace assignments, the resolved top-level alias list per task, and the per-task effective bootstrap level**. It excludes dynamic `vars.<name>.sh` results, decrypted secrets, runtime service info, and any provider connection state. Storing the alias, namespace, and bootstrap metadata in the app command index means OCLIF command registration in the router phase is a pure data lookup — no Landofile parse, no expression resolution, no include traversal, no command-registry walk.

On invocation at bootstrap level `tooling`:

1. Resolve the command from the app command index loaded during router bootstrap.
2. Read the cached `ToolingProgram` from `CacheService` using the stored app-plan cache key.
3. Parse argv with OCLIF using the cached flag/arg specs.
4. Resolve invocation-time expressions, dynamic service targets, dependency call vars, status/precondition checks, and dynamic vars.
5. Build `LandoRuntimeLive` at the task's **effective bootstrap level** (which already accounts for any `command:` step's requirements, §8.5.2.1).
6. Run `engine.execute(program, input)` and propagate exit code. `command:` steps invoke the target command's Effect program directly; they do not re-parse argv through OCLIF.

If the app command index is missing or stale, router bootstrap omits app tooling commands rather than reparsing the Landofile. `command_not_found` detects that the current directory is inside a Lando app with a missing/stale command index and prints remediation pointing to `lando app cache refresh` or any full app-planning command such as `lando start` / `lando rebuild`.

Provider initialization is the single hot-path cost when a task needs provider execution. The cached plan is read in microseconds, and no network, plugin install, fragment fetch, or provider contact occurs before invocation semantics require it. A wrapping task whose only escalation cost is a single `command: app:start` pays exactly the same cost as a direct `lando app start` invocation. Tooling hot path MUST remain usable offline after the app's Lando-managed dependencies and task graph are materialized.

### 8.8 `lando apps init` and the v4 recipe model

`lando apps init` (default top-level alias `lando init`) scaffolds a new Lando app from a **recipe**. A recipe in v4 is a Yeoman-style scaffolding artifact — a directory of source files plus a Q&A manifest — that produces a real, fully-visible Landofile (and any helper files) the user owns and can edit.

The v3 recipe-as-plugin model is removed. There is no `recipe:` Landofile key (§7.4), no `RecipeDefinition` plugin contract, no `recipes:` plugin manifest contribution, no runtime recipe expansion, and no core migration path. The word "recipe" is preserved as the user-facing term; the implementation is a one-shot scaffold consumed at init time and never referenced again. External config translator plugins MAY provide legacy import flows outside core (§7.4.1).

#### 8.8.1 Command surface

```text
lando apps init [<destination>]
                [--recipe=<ref>]
                [--source=<source>]
                [--name=<name>]
                [--answer=<key=value>]...
                [--answers=<file>]
                [--no-interactive]
                [--yes]
                [--full]
                [--from-source=<source-args>]
```

Behavior:

- `<destination>` is the output directory. Defaults to `--name` if given, otherwise to the current directory. The destination MUST be empty unless `--full` is passed (which permits writing into a directory that already contains files; conflicts are reported and the user is prompted).
- `--recipe=<ref>` selects a recipe by reference (§8.8.4). When omitted in interactive mode, Lando prompts with the list of canonical recipes shipped in the binary.
- `--source=<source>` (optional) provides source materials in addition to the recipe. Sources are plugin-contributed (`cwd`, `git`, `tarball`); the recipe's file manifest is layered on top of the source's files. Most users do not pass `--source`.
- `--answer key=value` (repeatable) provides a value for a single recipe prompt. Bypasses the interactive prompt for that key.
- `--answers <file>` reads a JSON or YAML map of answers. Combines with `--answer` (later wins).
- `--no-interactive` disables prompting. Every prompt without a default and without an `--answer` value fails fast with `RecipeMissingAnswerError`.
- `--yes` accepts every prompt's default without asking and is mutually exclusive with `--no-interactive` only when defaults exist; otherwise behaves like `--no-interactive` for unanswered prompts.
- The command runs at bootstrap level `minimal`; no provider is contacted.

#### 8.8.2 Recipe directory layout

A recipe is a directory with this structure:

```text
<recipe-id>/
├── recipe.yml           # Q&A definition + file manifest + post-init (schema below)
├── templates/           # source files rendered into the user's project
│   ├── .lando.yml.tmpl
│   ├── config/
│   │   ├── php.ini.tmpl
│   │   └── …
│   └── README.md.tmpl
├── fragments/           # optional fragments shipped alongside; available to the
│                        # generated Landofile via includes:
│   └── <name>.yml
├── assets/              # optional verbatim assets (binary, large files); copied without templating
└── README.md            # human-facing recipe docs; rendered to the docs site
```

Files under `templates/` are rendered through the recipe expression engine (§8.8.6). Files under `assets/` are copied byte-for-byte. Files under `fragments/` are copied byte-for-byte and become available to the generated Landofile via `includes:` (§7.7).

#### 8.8.3 The `recipe.yml` schema

```yaml
id: <kebab-case-id>                      # required; matches directory name
title: <string>                          # required; human-facing name
description: <string>                    # required; one-line summary
version: <semver>                        # required; recipe version
authors: [<string>]                      # optional
tags: [<string>]                         # optional; surfaced in `lando init` listing
deprecated: <DeprecationNotice>          # optional; recipe-wide deprecation; see §18
requires:                                # optional; soft preconditions
  lando: "^4.0.0"                        # core version constraint
  hostTools: [<tool-name>]               # host binaries that must be on PATH (e.g. git, composer)

runs:                                    # optional; canonical commands the recipe may invoke during init
  - <canonical-command-id>               # e.g. `pantheon:list-sites`; consulted by `ctx.run` (§8.8.14)

fetchAllowlist:                          # optional; URL hosts the recipe may HTTP GET during init
  - https://api.example.com              # exact-host match; subdomains are not implied

prompts:                                 # ordered; later prompts may reference earlier answers
  - name: <identifier>
    type: text | select | multiselect | confirm | number | secret | path | editor
    message: <string>
    default: <value | expression>        # optional
    when: <expression>                   # optional; skip prompt when falsy
    deprecated: <DeprecationNotice>      # optional; per-prompt deprecation; see §18
    validate:                            # optional; per-type validation
      pattern: <regex>                   # text/path
      message: <string>                  # human-readable failure
      min: <number>                      # number
      max: <number>                      # number
      exists: true | false               # path
    choices:                             # required for select/multiselect; static list, OR
      - <value> | { value: <v>, label: <string>, description?: <string> }
    choicesFrom:                         # optional; dynamic choices via a canonical command (§8.8.14 ctx.run)
      run: <canonical-command-id>        # MUST appear in the recipe's `runs:` allowlist
      args:                              # optional; expressions resolved against earlier answers
        <flag>: <value | expression>
      map: <expression>                  # optional; transforms command output into the choices array shape

files:                                   # ordered; written in this order
  - src: <path-under-templates-or-assets>
    dest: <path-relative-to-destination>
    when: <expression>                   # optional
    mode: <octal>                        # optional; e.g. "0755" for executable scripts
    template: true | false               # default: true for paths under templates/, false for assets/

postInit:                                # optional; declarative actions run after files are written
  - type: gitInit
  - type: message
    text: <string-with-expressions>
  - type: command
    cmd: <canonical-command-id>          # MUST be a Lando canonical id from the recipe post-init allowlist; arbitrary shell forbidden
    args: [<string>]
    when: <expression>
```

Constraints:

- The schema is published from `@lando/sdk` as `RecipeManifest` and exported as JSON Schema (§13.2). Editor integration validates `recipe.yml` files in real time.
- `id` MUST match the directory basename. Mismatch is a hard error.
- A `deprecated:` notice on the recipe records `kind: "recipe"` with `id: <recipe-id>`; a `deprecated:` notice on a prompt records `kind: "recipe-prompt"` with `id: "<recipe-id>.<prompt-name>"`. Both are observed at init time, emit a `message.warn`, and are listed by `lando doctor --deprecations` (§18.4–§18.6).
- Prompt `name` values MUST be unique within a recipe.
- `default` and `when` strings are recipe expressions (§8.8.6). They MAY reference earlier prompts via `answers.<name>` and the standard recipe context.
- `postInit` actions are limited to the declarative set above. Recipes MUST NOT execute arbitrary shell. The `command` action MAY only invoke canonical Lando command ids from the recipe post-init allowlist (§8.8.8); the allowlist prevents arbitrary host execution and keeps recipes inert until the user starts the app.

#### 8.8.4 Recipe sources

`--recipe=<ref>` accepts the same source schemes as `includes:` (§7.7), with one extra default scheme for built-in recipes:

| Form | Resolution |
|---|---|
| `<id>` (bare) | Built-in recipe shipped with the binary under `recipes/<id>/`. |
| `./path/to/recipe` or `/abs/path` | Local directory. |
| `github:owner/repo[/path][@ref]`, `git+https://…` | Cloned (shallow) into `<userCacheRoot>/recipes/git/<sha>/`. |
| `npm:@scope/pkg[/path][@version]` | Installed under `<userCacheRoot>/recipes/npm/`. |
| `registry:<id>[@version]` | Resolved against `recipes.lando.dev` (post-v4.0; reserved at v4.0). |

Resolution is content-addressed and cached. Repeated `lando init --recipe wordpress` reuses the same resolved snapshot when offline.

#### 8.8.5 Prompt types

| Type | Input | Notes |
|---|---|---|
| `text` | Single-line string | Validated with `pattern:` regex when present. |
| `select` | Single value picked from `choices:` | Choice list MAY be objects with `value`, `label`, `description`. |
| `multiselect` | Array picked from `choices:` | Empty selection allowed unless `validate.min: 1`. |
| `confirm` | Boolean | TTY shows `(Y/n)` or `(y/N)` based on `default`. |
| `number` | Integer or float | Validated with `min:` / `max:`. |
| `secret` | Single-line string, masked input | Never echoed; redacted in logs and error messages per §7.3.1's secret-redaction rules. Stored only in the resolved templates if the recipe author binds it explicitly. |
| `path` | Filesystem path with shell completion | `validate.exists: true` requires the path to exist; relative paths are resolved against the destination directory. |
| `editor` | Multi-line string entered via `$VISUAL` / `$EDITOR` | Falls back to `text` when no editor is configured or when `--no-interactive` is set. |

`when:` is honored uniformly across all types. Prompts whose `when:` evaluates falsy are skipped silently and their `name` resolves to `undefined` in subsequent expressions.

#### 8.8.6 Recipe expressions

Recipes render through the `TemplateRenderer` and use the same default `lando` engine as the rest of Lando (§7.3.1, §7.3.2). Templates under `templates/**/` MAY override the engine per file via the `files:` manifest entry (§8.8.3 — set `engine: handlebars` to render a `.hbs` template through the bundled Handlebars engine; see §7.3.2 for the bundled engine list and selection precedence). The `recipe.yml` file itself uses the `lando` engine for its string fields and does not accept an `engine:` override.

The `lando` engine accepts the full §7.3.1 grammar: `{{ … }}` interpolation with bracket-or-dotted paths, both pipe and call-style helper forms, native `${VAR}` shell-parameter-expansion, comments, and whitespace trim. Whole-file recipe templates additionally support control-flow blocks:

```text
{{ if <expr> }} … {{ else if <expr> }} … {{ else }} … {{ end }}
{{ for <name> in <expr> }} … {{ end }}
{{ for <key>, <value> in <expr> }} … {{ end }}
```

Control-flow blocks are valid inside `templates/**/` files but NOT inside `recipe.yml`'s string fields, where only single-expression interpolation is permitted. This keeps `recipe.yml` declarative.

The recipe render context extends the standard `TemplateRenderContext` (§7.3.2) with recipe-specific scopes. Per §7.3.1, all scopes here have an effective bootstrap level of "recipe init"; recipe rendering runs at level `minimal` and never consults a provider:

| Scope | Meaning |
|---|---|
| `answers.<name>` | Resolved prompt answers (only those preceding the current evaluation) |
| `recipe.id`, `recipe.title`, `recipe.version` | Recipe metadata |
| `destination.path`, `destination.basename` | Output directory |
| `cwd.basename`, `cwd.path` | Initial working directory before `--destination` resolution |
| `host.os`, `host.arch`, `host.platform`, `host.isWsl` | Host facts (matches §7.3.1) |
| `env.<NAME>` | Process env (matches §7.3.1) |
| `flags.<name>` | Init-command flags (`--full`, `--yes`, `--no-interactive`, etc.) |

Examples (filter-pipe and call-style helper forms are equivalent):

```text
# Filter-pipe form
{{ answers.appName | default(destination.basename) | lower }}

# Call-style form (identical AST)
{{ lower(default(answers.appName, destination.basename)) }}

# Native shell-parameter-expansion works in templates too
LISTEN_PORT=${PORT:-8080}
DOCROOT=${DOCROOT:?docroot is required}
```

The portable function set from §7.3.1 is available unchanged. Recipes MUST NOT call shell or filesystem functions; the registry exposed to recipe expressions is the §7.3.1 portable subset minus any function whose evaluation has side effects (in v4.0 the published portable set is already side-effect-free, so the subset and the full set are equivalent).

Literal `{{` is escaped as `{{{{`; literal `${` is escaped as `$${`. Inside `templates/**/` files, content outside `{{ … }}`, `${…}`, and `{{ if … }} … {{ end }}` blocks is copied verbatim.

#### 8.8.7 File manifest semantics

- Files are written in the order they appear under `files:`. Conflicts (a destination path written by an earlier entry) fail closed unless `flags.full` is set, in which case the user is prompted per-file.
- A file with `template: false` is copied byte-for-byte (no expression resolution). Files under `assets/` default to `template: false`; files under `templates/` default to `template: true`.
- `mode:` (octal string) sets file permissions on POSIX hosts. Ignored on Windows. Useful for shell scripts and entrypoints.
- A file with a falsy `when:` is skipped and reported in the init summary.
- The destination directory is created on demand. Atomic-write semantics from §12.3 apply per file.
- `.lando.yml` (or whatever the configured Landofile basename is per §7.5) is validated against the published Landofile schema (§7.8) after rendering and before being written. A validation failure aborts the entire init with `RecipeOutputValidationError` and no partial files; the user sees the failing path with line/column.

#### 8.8.8 Post-init actions

After every file is written, `postInit:` actions run in declared order:

| Action | Behavior |
|---|---|
| `gitInit` | `git init` + initial commit "Lando recipe `<id>` v`<version>`" if `git` is on PATH and the destination is not already a git repo. No-op otherwise. |
| `message` | Print a renderer-aware message; expressions resolve against the recipe context plus `answers`. |
| `command` | Invoke an allowlisted canonical Lando command (`cmd`) with `args:`. The command runs at its declared bootstrap level. Useful for triggering `app:config:translate` or an opt-in `app:start` after scaffolding. |
| `bun` | Dispatch to `BunSelfRunner` (§3.4). The `verb:` field selects one of the allowlisted operations below. All variants share the same `cwd:`, `when:`, `env:`, and bounded-by-construction rules; verb-specific fields configure the operation. |

The `bun` action's `verb:` allowlist:

| `verb:` | Verb-specific fields | Behavior |
|---|---|---|
| `script` | `script: <path>`, `args: [<string>]` | Run a recipe-bundled `.bun.sh` file through `ShellRunner.runScript()`. The script path MUST resolve under the recipe's `templates/` or `assets/` tree; arbitrary host-shipped paths are rejected. Useful for "open the docs URL", "stamp a generated `.gitattributes`", or "print a localized welcome banner" without inflating the canonical-command allowlist. |
| `install` | *(none)* | Run `bun install` in `cwd:`. Resolves the scaffold's declared `package.json` (or `bun.lock`) and writes `node_modules/`. The user needs no host Bun. Rejected if `cwd:` has no `package.json`. |
| `add` | `dependencies: [<spec>]`, `devDependencies: [<spec>]`, `peerDependencies: [<spec>]`, `optionalDependencies: [<spec>]` | Add explicit packages. Specs MAY reference `${secret:…}` registry tokens (resolved through `SecretStore`, redacted in events). Useful for stack-pickers that conditionally pull packages. |
| `create` | `template: <name>`, `dest: <path>` | Run `bun create <template> <dest>`. `dest:` MUST resolve under the recipe destination; absolute paths outside the destination are rejected with `BunCreateOutsideDestinationError`. Bridges the `bun create` ecosystem into Lando recipes. |
| `run` | `script: <name>` | Run a script entry from `cwd:`'s `package.json` via `BunSelfRunner.runScript(scriptName)`. Useful for post-`install` scaffold steps the framework's own `package.json` defines. |
| `x` | `spec: <package-spec>`, `argv: [<string>]` | Run a one-shot package via `BunSelfRunner.x(spec, argv)`. Useful for generators that publish to npm but do not ship a `bun create` template. The active runtime's offline policy applies (§8.2.4). |

Allowed `postInit.command` targets in v4.0.0 are generated from command metadata (`recipePostInitAllowed: true`). The initial allowlist is `app:config:translate` and `app:start`. `app:start` MUST be guarded by an explicit recipe prompt or CLI answer; recipes MUST NOT start services by default. Adding another target requires updating the command registry and generated recipe-action docs. Recipes MUST NOT use `postInit.command` to install plugins, update Lando, mutate global config, run setup/shell-integration commands, or run arbitrary tooling tasks.

The `bun` action is bounded by construction across every verb:

- All verbs route through `BunSelfRunner` (§3.4): the same recursion-guarded, redacted, lifecycle-eventing Bun child the rest of core uses. Recipes do NOT spawn `bun` directly, do NOT write a temporary script and shell into it, and do NOT bypass the §3.4 verb-shape contract. A misformed payload (e.g., a `verb: add` spec list containing `--global`) is rejected at `lando meta recipes validate <path>` time with `BunSelfArgvShapeError`.
- The `cwd:` for any verb defaults to the recipe destination directory and MAY be a declared subdirectory of it. Paths that escape the destination via `..` or symlinks are rejected after realpath resolution with `BunActionOutsideDestinationError`.
- For `verb: script`, the `script:` field is a path under the recipe's bundled tree (`templates/<…>.bun.sh` or `assets/<…>.bun.sh`); paths outside those bases are rejected with `BunScriptOutsideRecipeError` after realpath resolution. The bundled-recipes generator (§17.2) checksums every script at build time and embeds the checksum into the recipe manifest; runtime execution verifies the checksum before launch and a mismatch fails with `BunScriptChecksumError`.
- Arguments to `verb: script` are passed via `args: [<string>]` (resolved through the recipe expression engine) and via `LANDO_RECIPE_ANSWER_<NAME>` environment variables (one per resolved prompt answer). `secret`-typed answers are NOT exported as env vars and require explicit `args:` passing through `${secret:…}` reference, which redacts in lifecycle events.
- Each action's redacted argv is published through `pre-bun-self-exec` / `post-bun-self-exec` events with `callerSubsystem: "recipe:bun:<verb>:<recipe-id>"` so subscribers can inspect what a recipe scaffolded.
- Cancellation: `Effect.interrupt` propagates through `BunSelfRunner` to the embedded Bun child. The recipe init aborts with `RecipeInterruptedError`. `verb: install`-written `node_modules/` directories are NOT auto-removed because they may contain partially extracted artifacts the user wants to inspect; the failure message points at `rm -rf node_modules && lando bun install` for retry.
- Network: `verb: install`, `add`, `create`, and `x` may contact registries; this is the legitimate exception to the §1.4 "recipes MUST NOT contact the network" rule and is the same exception the existing `--recipe` source resolution already carries. Recipe authors SHOULD scope network-bound actions behind a `when:` expression so users on offline runs can opt out.
- Failures are reported but do NOT roll back files already written. A recipe author who needs file rollback on a `bun` failure must pre-validate before the file-write phase via `prompts:` `validate.exists` / `validate.pattern` / `validate.message`.
- The action MUST NOT install Lando plugins into the user-global plugin set; `lando plugin add` is the only canonical path for that and is forbidden in `postInit.command`'s allowlist by construction. The action is bounded to the destination directory's package graph.

Recipes MUST NOT define arbitrary shell hooks outside `bun: { verb: script }`. The action set is intentionally small. New top-level actions require a spec change; new `bun` verbs require updating the verb allowlist and the generated recipe-action docs.

#### 8.8.9 Init flow

```text
1. Resolve --recipe through the source-scheme registry; cache or refetch as needed.
2. Validate recipe.yml against the RecipeManifest schema; reject unknown action types.
3. Resolve destination; create the directory if missing; refuse to proceed in non-empty
   directories unless --full is set.
4. Run prompts in order:
     a. Skip if `when:` is falsy.
     b. Use --answer/--answers value when provided.
     c. Use the recipe's default when --yes or --no-interactive is set.
     d. Otherwise prompt interactively via the renderer (TTY) or fail when --no-interactive.
5. Render every file under `files:`; validate the generated Landofile against §7.8.
6. Write files atomically (per §12.3).
7. Run `postInit:` actions in order.
8. Print a final summary including the Next-Steps message from the recipe (or a default).
```

Lifecycle events publish at canonical command id `apps:init` per §11. Init itself does not contact a provider; an explicit, opt-in `postInit.command: app:start` action runs as a separate allowlisted command at its own bootstrap level after scaffolding completes.

#### 8.8.10 Canonical recipes shipped in core

The following recipes ship in the binary at v4.0 under `recipes/<id>/`. Each ships its own `recipe.yml`, templates, and README:

| Recipe id | Stack |
|---|---|
| `wordpress` | WordPress with PHP, MariaDB, optional Redis |
| `laravel` | Laravel with PHP, MariaDB or PostgreSQL, Redis, optional queue worker |
| `symfony` | Symfony with PHP, PostgreSQL or MariaDB, Redis |
| `lamp` | Generic LAMP starter: Apache, PHP, MariaDB |
| `lemp` | Generic LEMP starter: nginx, PHP, MariaDB |
| `node-api` | Node API with Express / Fastify / Hono framework picker, optional PostgreSQL or MongoDB |
| `astro` | Astro frontend with optional content-source and DB picker |
| `sveltekit` | SvelteKit frontend with optional adapter and DB picker |
| `nextjs` | Next.js frontend with optional DB and Auth helper picker |
| `django` | Django with PostgreSQL, Redis, optional Celery worker |
| `fastapi` | FastAPI with PostgreSQL, Redis |
| `rails` | Ruby on Rails with PostgreSQL, Redis |
| `jekyll` | Jekyll static site |
| `hugo` | Hugo static site |
| `eleventy` | Eleventy static site |
| `empty` | Blank Landofile starter: service catalog selection only, no opinion |

Core ships a canonical recipe set under `recipes/<id>/`. The set is defined at build time via `scripts/build-bundled-recipes.ts` which generates `src/recipes/bundled.ts`; recipes are statically imported into the compiled binary (§13.5). The bundled set MAY grow in any v4.x release; removals require a major version bump and a `DeprecationNotice` per §18.

The v4.0 set covers common PHP, Node, Python, Ruby, and static-site stacks plus an `empty` starter. Out of scope for the v4.0 bundle: Drupal (community can publish via npm/git/registry) and v3-style recipe compatibility shims (external config translators may provide them; §7.4.1).

#### 8.8.11 Recipe authoring surface

Recipes are authored as plain directories. There is no SDK package to install, no plugin manifest to write, no Bun build step. A recipe author:

1. Creates a directory with the layout in §8.8.2.
2. Writes a `recipe.yml` validated by `lando meta recipes validate <path>`.
3. Tests interactively with `lando init --recipe ./<path> /tmp/<dest>`.
4. Publishes to git, npm, or the future registry.

Recipes are versioned independently of core. Core's canonical recipes live alongside core source; community recipes live wherever their authors prefer.

`lando meta recipes validate <path>` and `lando meta recipes describe <ref>` are first-class meta commands (canonical ids `meta:recipes:validate` and `meta:recipes:describe`) that authors and consumers use to verify recipe shape and inspect the prompt set without performing an init.

#### 8.8.12 Constraints

- Recipes MUST NOT execute arbitrary code at any point. The Q&A, file rendering, and post-init action set are the entire surface.
- Recipes MUST NOT install plugins. The generated Landofile MAY declare `plugins:` (§7.4); plugin install happens through the app build/materialization flow when first needed.
- Recipes MUST NOT mutate global config or `<userConfRoot>`. They write only inside the destination directory.
- Recipes MUST NOT contact the network outside source resolution (which is cached and lockfile-pinned). An explicit, opt-in `postInit.command: app:start` is a separate Lando command after scaffolding and may perform the normal app materialization/build network operations described elsewhere.
- Recipes are inert after init: once files are written, the recipe is no longer referenced. Lando reads only the resulting `.lando.yml`.

#### 8.8.13 Init sources beyond recipes

`--source=<source>` plugs a parallel mechanism for fetching source materials (existing repo, tarball, etc.) and is plugin-contributed via the `InitSource` abstraction (§4.2). When both `--source` and `--recipe` are provided:

1. The source provides initial files (clone, extract, copy).
2. The recipe's file manifest is layered on top, with recipe files winning on conflict unless `flags.full` triggers per-file prompts.
3. Both `--source` and `--recipe` must succeed; any failure aborts the init with no partial state.

Default init sources: `cwd` (use existing directory), `git`, `tarball`. A provider may be required by a specific source (e.g., a hypothetical "lando-template" source that uses ephemeral container exec); core does not require a provider for `apps:init` in general.

#### 8.8.14 Programmatic recipes (`recipe.ts`)

A recipe MAY ship a `recipe.ts` file *instead of* `recipe.yml`. The TypeScript form is the programmatic counterpart to the declarative YAML form, in the same way `.lando.ts` (§7.1.1) is the programmatic counterpart to `.lando.yml`. The use case is recipes whose prompt graph or file manifest depends on earlier answers in non-trivial ways.

`recipe.ts` and `recipe.yml` are mutually exclusive within a recipe directory. A recipe ships one or the other, never both.

The TS form's contract:

- `defineRecipe(value | factory)` is a thin identity helper exported from `@lando/core/schema` (and re-exported from `@lando/sdk`); it pins the argument's TS type to the inferred `RecipeManifest` (or factory) shape so authors get full editor completion. Runtime decode still goes through the canonical schema.
- The default export MUST be either a static `RecipeManifest` value or an `async (ctx: RecipeContext) => RecipeManifest` factory. The static form is rare; if a recipe does not need TS-driven prompt branching, it should ship YAML.
- `ctx.prompt(prompt)` is the only way the factory may ask the user a question. It accepts the same prompt schema (§8.8.5) the YAML form uses; under the hood it delegates to the same renderer-aware prompt engine. Each call adds the resolved answer to `ctx.answers.<name>` so subsequent calls can branch on it.
- `ctx.prompt` honors `--no-interactive` and `--answer key=value` exactly as the YAML form's prompt loop does. A factory that asks a prompt without a default in `--no-interactive` mode aborts with `RecipeMissingAnswerError`.
- The factory's returned `RecipeManifest` is validated against the published schema (§7.8) before any file is written. A factory that returns an invalid shape aborts with `RecipeOutputValidationError` and points at the offending path.
- Side effects at module top level are forbidden, identical to the `.lando.ts` rule (§7.1.1). Imports + `defineRecipe(...)` + `export default`. Any I/O the factory needs runs inside the factory body and is bounded by `Effect.timeout` (default 30 s; configurable via global `recipe.tsTimeoutMs:`).
- The factory MUST NOT execute arbitrary shell, install plugins, mutate global config, or contact the network outside the two `ctx` carve-outs:
  - `ctx.run(commandId, input?)` — invoke a canonical command (§8.1.1) declared in the recipe's `runs:` allowlist; out-of-allowlist calls abort with `RecipeForbiddenCommandError`.
  - `ctx.fetch(url, opts)` — HTTP GET against the recipe's `fetchAllowlist:` hosts; out-of-allowlist calls abort with `RecipeForbiddenFetchError`. Prefer `ctx.run` when a canonical command exists.
- The factory MUST NOT re-emit existing built-in `postInit:` actions in a way that escapes the recipe destination. The `RecipeManifest` schema validation enforces this at the same point §8.8.7 does for the YAML form.
- `lando meta recipes describe <ref>` (§8.8.11) and `lando meta recipes validate <path>` work on `recipe.ts` recipes by invoking the factory in a sandboxed evaluation that returns a synthetic prompt graph: each `ctx.prompt` resolves to a placeholder describing the prompt's shape rather than asking the user. The synthetic walk produces a static description of the recipe's prompt-shape graph even when answers branch the file manifest.
- Caching: a `recipe.ts`'s decoded factory result is not cached the way YAML decode is, because the factory's output depends on user answers. The compiled `recipe.ts` module is cached under `<userCacheRoot>/recipes/ts/<contentHash>.bin` (a new entry that joins the §12.1 catalog) so the factory only re-imports when the file changes. Each `lando init` execution invokes the factory fresh.
- Bundled-recipe codegen (§17.2 "Bundled recipes index") handles `recipe.ts` recipes by including the file in the recipe's tar and running `BunSelfRunner.buildLib` against it at build time, embedding the bundled JS output alongside the source. The runtime loader prefers the prebuilt JS so the binary's recipe-init path does not pay TS-load cost.

A `recipe.ts` recipe is otherwise indistinguishable from a YAML recipe at runtime: the same source schemes (§8.8.4), the same destination semantics (§8.8.7), the same post-init action set (§8.8.8), and the same constraints (§8.8.12). A user invoking `lando init --recipe foo` has no way to tell whether `foo` was authored as `recipe.ts` or `recipe.yml` from the prompt experience alone.

### 8.9 Renderers and messages

Renderers are plugin-contributed output strategies.

```ts
export class Renderer extends Context.Service<Renderer, {
  readonly id: string;
  readonly capabilities: RendererCapabilities;
  readonly render: (events: Stream.Stream<RenderEvent>) => Effect.Effect<void, RenderError, Scope.Scope>;

  // First-paint API — see "First-paint contract" below.
  readonly emitImmediate: (line: ImmediateLine) => Effect.Effect<void, RenderError>;
}>()("@lando/core/Renderer") {}
```

Built-in render events:

- `task.start`, `task.progress`, `task.complete`, `task.fail`
- `task.tree.start`, `task.tree.complete` — open/close a parent container around N concurrent sibling tasks. Carries `parentId`, `label`, `children: TaskId[]`, and an optional `mode` that hints renderer layout (`"grid"` for tabular siblings, `"list"` for vertically stacked siblings; the default Lando renderer uses `"list"` for the build phases). The §6.13 `BuildOrchestrator` emits one `task.tree.start` per phase and one inner `task.start` per `BuildStep`.
- `task.detail` — streaming tail of a single task's output. Carries `taskId`, `stream: "stdout"|"stderr"`, and `line: string`. Renderers MUST keep an in-memory ring buffer of at least 4 lines per task and surface the most recent N as a dimmed indented panel under the task line. The build orchestrator publishes `task.detail` events derived from `build-step-progress` (chunks split on `\n`, redacted per §6.13.6).
- `task.detail.expand`, `task.detail.collapse` — TTY input events emitted by the renderer (not by callers) when the user presses `Enter` on a focused task or `Esc` to leave the expanded view. Renderers MUST publish these on the `EventService` so subscribers (e.g., screen recordings, executable-guide scenario transcripts) can capture the interaction.
- `log.line`
- `message.info`, `message.warn`, `message.error`
- `table.row`, `table.end`
- `prompt.start`, `prompt.complete`
- `paint.banner` — emitted by the pre-bootstrap fast path (see below).

**Default renderer** is the Lando renderer (interactive, colorful, listr-style). Plugins may ship:

- `json` — line-delimited JSON for CI/automation.
- `plain` — minimal text, no colors, no spinners.
- `verbose` — full debug output inline with task progress.

**Renderer selection:** `--renderer=` → `LANDO_RENDERER` → global `renderer:` → TTY/CI auto-detection (`json` for non-TTY/CI, default otherwise).

**Messages** are typed app output records published after lifecycle steps. The renderer decides how to present them. Schemas are published in `@lando/sdk` so plugins can contribute domain-specific message types.

#### 8.9.1 First-paint contract

The Renderer is responsible for the perceived-performance budget in §2.1. The contract every Renderer MUST honor:

| Event | Required behavior |
|---|---|
| **Pre-bootstrap banner** | After OCLIF resolves the canonical command id and *before* the AOT bootstrap layer is provided, the command base writes a single-line banner (e.g., `▲ Starting (using lando runtime)…`) directly to stdout via a tiny pre-renderer module that does not require the full `Renderer` Layer. The banner MUST appear within the §2.1 first-byte budget (50 ms cold). For level ≥ `plugins`, this MUST land before any plugin module is imported. |
| **Streaming output** | The Renderer MUST NOT buffer for TTY mode. Each `RenderEvent` is flushed to stdout/stderr as it arrives. Only `--format json` (the structured-output mode) MAY buffer — it must emit one valid document, so it accumulates until completion. |
| **Skeleton-first tables** | `table.row` events stream as rows resolve. Renderers MUST emit column headers on the first `table.row` (or via a synthetic `table.start`) within the first-meaningful-line budget (80 ms cold) when the command produces tabular output (`info`, `list`). Computed-row latency does not count against first-paint. |
| **Spinner threshold** | When a `task.start` event has no `task.progress` follow-up within 100 ms, the Renderer MUST display a spinner / activity indicator until the task completes or progresses. Below 100 ms, no spinner is shown (avoids flashing). |
| **Completion line latency** | After the last `task.complete` / `message.*` event of a run, the final completion line (e.g., `✓ Done in 312 ms`) MUST land within 50 ms of that event. |
| **No first-paint for level `none`** | Level-`none` commands (§3.2) print directly from `bin/lando.ts` without involving the `Renderer` service at all. The contract above does not apply to them; their end-to-end budget already covers the first-paint case. |

**The pre-renderer module.** A tiny `src/cli/oclif/pre-renderer.ts` exposes synchronous functions that write directly to `process.stdout` / `process.stderr` for the pre-bootstrap banner. It MUST NOT import Effect, the `Renderer` service, `@oclif/core`, or any plugin code. It is the only direct-stdout-write path in the CLI; once the `Renderer` Layer is forced (§3.4), all subsequent output flows through `Renderer`.

**Hand-off.** When the `Renderer` Layer is constructed, it consumes a synthetic `paint.banner` event carrying the pre-renderer's banner so the renderer's internal state machine knows what was already shown. This avoids double-banners and lets renderers like `json` rewrite/erase the pre-renderer's TTY line on first valid JSON emission.

**Non-TTY (CI / pipe) exemption.** In non-TTY contexts, the spinner-threshold and skeleton-first-tables rules are relaxed: spinners are never emitted; tables MAY emit only after computation completes (one full payload). The first-byte and first-meaningful-line budgets still apply because they affect log-streaming UX in CI.

**JSON renderer special case.** `--format json` / `--renderer=json` emits exactly one JSON document on stdout (the command's typed result) plus structured events on stderr. The first stderr event MUST land within the first-meaningful-line budget; the stdout document is buffered until completion by design.

These rules are tested by the perf-budget test layer (§13.1), which captures stdout/stderr timing at byte resolution and asserts against the §2.1 perceived-performance table.

#### 8.9.2 Concurrent task tree contract

When the active runtime is driving multiple concurrent tasks under a common parent — the canonical case is `BuildOrchestrator` (§6.13) running per-service `composer install` and `npm ci` siblings under the `app` build phase, but the same shape applies to any caller that emits `task.tree.start` with `children: [a, b, c, …]` — every Renderer MUST honor the contract below. The contract is what makes the OpenCode/Claude-Code-style "list of running tasks with a per-task tail and a select-to-expand full view" UX work uniformly across renderers without callers having to know which renderer is active.

| Surface | Required behavior |
|---|---|
| **Default Lando renderer (TTY)** | Renders one parent line per `task.tree.start` (`▼ Building app dependencies (2/4 running)`), with one indented child line per `task.start`. Each running child shows `[spinner] <stepId>  <last line of task.detail, dimmed and truncated to one terminal column>`. Below each running child, an indented panel of at least 4 lines surfaces the most recent `task.detail` lines for that child (dimmed, monospaced). On `task.complete` / `task.fail`, the spinner becomes `✓` (green) / `✗` (red), the panel collapses, the child line is left as a one-line summary (`✓ appserver: composer install (12.4s · cached)` / `✗ node: npm ci (exit 1 — see lando logs node --build)`). On `task.tree.complete`, the parent line collapses to `▶ Built app dependencies (3 ✓ · 1 ✗)` with a hint to expand it. |
| **Selection / expand (TTY)** | The renderer MUST honor keyboard input while a tree is rendered: `↑`/`↓` move focus across visible children; `Tab` cycles between trees when more than one is visible; `Enter` enters the **alt-screen full-tail view** for the focused child; `Esc` returns to the tree. The full-tail view swaps to the terminal's alternate screen buffer, hides the tree until exit, and shows the live tail of the focused child read directly from its transcript file (§6.13.6 / §12.4). Scrollback (PgUp / PgDn / arrows) is honored within the alt screen. Exiting the alt screen MUST restore the tree to its current state without redrawing-from-scratch artifacts. The renderer MUST publish `task.detail.expand` on enter and `task.detail.collapse` on exit so executable-guide scenario transcripts (§19) and screen-recording subscribers can capture the interaction. |
| **Post-completion expand** | After `task.tree.complete`, the focused-child Enter behavior remains live: the tree stays as a static summary, but pressing Enter still drops into the alt-screen full-tail view against the persisted transcript file. The renderer is permitted (but not required) to leave the tree visible for up to the renderer's normal completion-line latency budget after the last `task.tree.complete`; after that, it MAY collapse the trees and only re-render them if the user pages back via a renderer-defined affordance. |
| **Default Lando renderer (non-TTY / CI / pipe)** | Per the §8.9.1 non-TTY exemption, no spinners and no alt-screen behavior. Every child's `task.detail` events MUST be emitted as interleaved log lines with a stable prefix (`[<stepId>]`), one event per line, in the order they arrive at the renderer. `task.tree.start` and `task.tree.complete` MUST emit a single header / summary line each (`▼ Building app dependencies (4 services)` / `▶ Built app dependencies (3 ✓ · 1 ✗ · 12.4s)`). Children whose only output is `task.detail.expand` / `task.detail.collapse` MUST NOT emit anything in non-TTY mode. |
| **`--renderer=json`** | NDJSON of every `task.tree.*`, `task.start`, `task.detail`, `task.complete` / `task.fail` event on stderr, with the standard JSON-renderer guarantees (§8.9.1). Embedding hosts and CI consumers get the same structured stream the renderer would consume, suitable for piping into a custom UI. |
| **`--renderer=plain`** | One line per `task.complete` / `task.fail` carrying the summary; no task tree, no detail tail, no spinners, no input handling. |

**Renderer state machine (informative).** The default renderer maintains a small per-tree state machine driven by the event stream:

```text
task.tree.start  →  open tree, allocate child slots
task.start       →  show spinner; start consuming task.detail into the per-child ring
task.detail      →  push line into ring buffer; redraw the child's tail panel
task.complete    →  swap spinner for ✓; collapse panel; render summary line
task.fail        →  swap spinner for ✗; collapse panel; render summary line with hint
task.tree.complete  →  collapse to summary; tree is now passive (focused-child Enter still works)
```

**Redaction.** The renderer MUST treat every `task.detail.line` as already-redacted by the publisher. The build orchestrator's emitter (§6.13.6) applies the same `${secret:…}` and registry-token redaction the `Logger` and lifecycle-event payloads receive. The alt-screen full-tail view, however, reads the *unredacted* per-step transcript file from disk — it is a local-only diagnostic surface bounded by the user data root and is never propagated to telemetry, executable-guide scenario transcripts, or NDJSON renderers. Guide authors who need to capture an alt-screen session use the `<Inspect>` component (§19.3) which reads the redacted `task.detail` event stream, not the file.

**Cancellation.** `Effect.interrupt` (Ctrl+C) propagates from the imperative shell through the orchestrator to every in-flight child; the renderer MUST receive a `task.fail` for each affected child within the §2.1 cancellation budget. While the alt-screen view is active, the renderer MUST NOT swallow Ctrl+C; the input is still routed to the runtime so the user can cancel from inside the expanded view without first pressing Esc.

**Test coverage.** The §13.1 perf-budget suite exercises the contract end-to-end: a fixture with three services whose `build.app` scripts sleep for known durations asserts that wall-clock time is approximately `max(t_a, t_b, t_c)` (within 20%) rather than `sum(…)`, that every child emits at least one `task.detail` event during the sleep window, and that the renderer publishes `task.detail.expand` / `task.detail.collapse` events when synthetic Enter / Esc inputs are fed to its TTY. The non-TTY mode is asserted on the same fixture by piping output and matching the `[<stepId>]`-prefixed line set.

---
