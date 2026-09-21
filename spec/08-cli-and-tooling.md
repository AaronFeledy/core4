# Lando v4 — CLI, Tasks, and Tooling

> **Part 8 of 18** · [Index](./README.md)
> **Read next:** [09 Embedding and Library Use](./09-embedding.md)

This part defines the CLI, tooling, recipe, renderer, interaction, and machine-output contracts. One native command registry and dispatcher own source and compiled operation; command execution crosses into Effect at `run()` and does not return to an imperative command body.

---

## 8. CLI, Tasks, and Tooling

### 8.1 Command kinds

Every command has exactly one kind and one namespace.

| Kind | Source | Registry representation |
|---|---|---|
| Built-in | Core | Static `LandoCommandSpec` entry adapting Effect command logic |
| Plugin | Plugin manifest `provides.commands` | Lazy-loaded `LandoCommandSpec` |
| Tooling | Landofile `tooling:` | Generated registry shim from the app command index |
| Management | Core or plugin with `hidden: true` | Hidden registry entry |

#### 8.1.1 Command namespaces

Canonical ids use one colon-form token, `<namespace>:<segments…>`. Multi-segment ids are valid.

| Namespace | Scope | Examples |
|---|---|---|
| `app` | Current app or `--path` app | `app:start`, `app:config`, tooling tasks |
| `apps` | Host-wide discovery and multi-app operations | `apps:list`, `apps:init` |
| `meta` | Lando configuration, plugins, setup, and distribution | `meta:config`, `meta:plugin:add` |

Plugins MAY contribute to core namespaces or a plugin-owned topic; a plugin-owned topic SHOULD match manifest `cspace:`. `app`, `apps`, `meta`, and top-level `plugin` are reserved. Plugin management lives under `meta:plugin:*`, and plugin topics MUST NOT shadow core namespaces.

Canonical ids determine lifecycle names `cli-<canonical-id>-<phase>`, generated docs, and `command` cache keys (§3.5, §11.4, §12.1). The parser requires colon form except for §8.4.1 compatibility forms. Native routing reserves a bare namespace head only when a registered canonical id or colon-qualified alias owns it; an otherwise valid `app:<tool>` remains eligible for app-command-cache routing.

#### 8.1.2 Top-level aliases

`LandoCommandSpec.topLevelAlias` and tooling `topLevelAlias` register additional top-level tokens without changing canonical identity, lifecycle names, or cache keys.

| Value | Effect |
|---|---|
| `false` or omitted | No top-level alias |
| `true` | Strip the namespace prefix; multi-segment results remain colon-form tokens |
| string | Register that token |
| string array | Register each token independently |
| `{ name, deprecated }` | Register named alias or aliases with a `DeprecationNotice` |

Aliases MUST NOT collide with another top-level alias, a top-level topic, or `help`, `--help`, or `--version`. Conflicts produce `CommandAliasConflictError`: built-ins win; plugin conflicts use §4.3 precedence or fail; tooling conflicts fail unless global config explicitly disables the existing alias.

`global:` is reserved for `meta:global:*` (§20.7.1). `scratch:` and bare `scratch` are reserved for `apps:scratch:*` (§21.10.2). Plugin and tooling claims collide unless app-context `commandAliases.custom:` remaps them.

Global and Landofile `commandAliases:` expose `enabled`, `disabled`, and `custom`; Landofile values win in app context. `enabled: false` removes all aliases in scope. `disabled` removes named aliases. `custom` binds an alias to an existing canonical id after ordinary alias registration. Unknown targets fail with `CommandAliasTargetError`. Overrides never replace the canonical id itself and MAY target built-ins, plugin commands, or same-Landofile tooling tasks.

### 8.2 Built-in commands

The registry is authoritative for ids, aliases, bootstrap levels, flags, and result schemas.

| Canonical id | Default alias | Bootstrap | Contract |
|---|---|---|---|
| `app:cache:refresh` | none | `app` | Rebuild app plan, tooling graph, and `<userCacheRoot>/apps/<app-id>/commands.bin` without starting services |
| `app:config` | none | `app` | Read or write the current Landofile (§8.2.1) |
| `app:config:explain` | none | `plugins` | Report recipe provenance; `--format json` |
| `app:config:migrate` | none | `plugins` | Commit recipe migrations; `--yes`, `--dry-run`, `--format json` |
| `app:config:translate` | none | `plugins` | Convert with `--from`, `--to`, `--file`, `--write`; never plans or contacts a provider |
| `app:destroy` | `destroy` | `app` | Destroy resources; confirmation unless `--yes` |
| `app:exec` | `exec` | `app` | Execute in a service |
| `app:includes:update` | none | `minimal` | Refresh selected or all `.lando.lock.yml` entries; `--no-network`, `--check` |
| `app:includes:verify` | none | `minimal` | Verify cached includes; `--format json\|table` |
| `app:info` | `info` | `app` | Runtime info; repeatable `--service/-s`; `--format json\|table\|yaml` |
| `app:logs` | `logs` | `app` | Stream logs; `--service`, `--follow`, `--tail`, `--since`, `--no-viewer` |
| `app:open` | `open` | `app` | Open or print URLs; `--service`, `--route`, `--all`, `--print` |
| `app:rebuild` | `rebuild` | `app` | Rebuild selected prerequisite closure; repeatable `--service/-s` |
| `app:restart` | `restart` | `app` | Stop then start inside restart events |
| `app:shell` | `shell` | `app` | Interactive host or service shell; `--service`, `--no-history` |
| `app:share` | `share` | `app` | Start tunnel; `--target`, `--provider`, `--detach`, `--format json` |
| `app:share:list` | none | `app` | List tunnel sessions |
| `app:share:stop` | none | `app` | Stop a detached tunnel session |
| `app:ssh` | `ssh` | `app` | `app:exec` with `--interactive --tty` defaults |
| `app:start` | `start` | `app` | Start current app |
| `app:stop` | `stop` | `app` | Stop current app |
| `apps:init` | `init` | `plugins` | Scaffold an app (§8.8) |
| `apps:list` | `list` | `minimal` | List apps; `--all`, filters, `--path`, JSON, table |
| `apps:poweroff` | `poweroff` | `provider` | Stop managed services; `--keep-global`, `--keep-scratch` |
| `apps:scratch:destroy` | `scratch:destroy` | `scratch` | Destroy by `<id>`; `--keep-volumes` |
| `apps:scratch:gc` | `scratch:gc` | `scratch` | Report or reap orphans; `--prune` |
| `apps:scratch:info` | `scratch:info` | `scratch` | Scratch info; `<id>`, `--service`, `--format` |
| `apps:scratch:list` | `scratch:list` | `scratch` | List registry and provider-label orphans; `--format table\|json` |
| `apps:scratch:logs` | `scratch:logs` | `scratch` | Scratch logs; `<id>`, `--service`, `--follow`, `--tail`, `--since` |
| `apps:scratch:run` | `scratch:run`, `run` | `scratch` | Scope-bound toolbox execution; `--keep` detaches |
| `apps:scratch:start` | `scratch:start`, `scratch` | `scratch` | `--fork` or `--from`; isolation, cwd mount, global-storage, detach controls |
| `apps:scratch:stop` | `scratch:stop` | `scratch` | Stop selected or foreground scratch and destroy it |
| `meta:bun` | `bun` | `minimal` | Embedded Bun proxy through `BunSelfRunner` |
| `meta:config` | `config` | `minimal` | Edit `<userConfRoot>/config.yml` |
| `meta:doctor` | `doctor` | `none` | Self-resilient diagnostics (§10.9.1) |
| `meta:events:follow` | `events` | `minimal` | Trace events; `--follow`, `--format`, `--event`, `--scope`, `--since` |
| `meta:global:config` | `global:config` | `minimal` | Edit `<userDataRoot>/global/.lando.yml` and plugin enablement |
| `meta:global:destroy` | `global:destroy` | `global` | Destroy global resources; `--purge` includes service/app volumes |
| `meta:global:info` | `global:info` | `global` | Global info; `--service`, `--format` |
| `meta:global:install` | `global:install` | `global` | Enable `globalServices:`, write `global.config.yml`, regenerate `dist`; does not start |
| `meta:global:list` | `global:list` | `minimal` | List global services, enablement, source, status |
| `meta:global:logs` | `global:logs` | `global` | Stream global logs |
| `meta:global:rebuild` | `global:rebuild` | `global` | Stop, rebuild, restart global services |
| `meta:global:restart` | `global:restart` | `global` | Global stop then start |
| `meta:global:start` | `global:start` | `global` | Start all or repeated `--service` subset |
| `meta:global:status` | `global:status` | `global` | Report global app status |
| `meta:global:stop` | `global:stop` | `global` | Stop global services |
| `meta:global:uninstall` | `global:uninstall` | `global` | Disable contributions and stop affected services |
| `meta:mcp` | `mcp` | `plugins` | MCP over stdio; `--allow`, `--deny`, `--tooling`, `--list` |
| `meta:plugin:add` | `plugin:add` | `plugins` | Install plugin |
| `meta:plugin:build` | none | `minimal` | Build through `BunSelfRunner.buildLib` |
| `meta:plugin:link` | none | `plugins` | Link current plugin |
| `meta:plugin:login` | `plugin:login` | `minimal` | Authenticate plugin source |
| `meta:plugin:logout` | `plugin:logout` | `minimal` | Forget authentication |
| `meta:plugin:new` | none | `minimal` | Scaffold plugin through `BunSelfRunner.create` |
| `meta:plugin:publish` | none | `minimal` | Publish; reads `<userDataRoot>/plugin-auth.json` |
| `meta:plugin:remove` | `plugin:remove` | `plugins` | Remove plugin |
| `meta:plugin:test` | none | `minimal` | Run plugin tests |
| `meta:plugin:unlink` | none | `plugins` | Remove link and optionally restore registry copy |
| `meta:recipes:describe` | none | `minimal` | Print recipe prompts and metadata |
| `meta:recipes:list` | `recipes` | `none` | List compile-time bundled recipes |
| `meta:recipes:validate` | none | `minimal` | Validate `recipe.yml` |
| `meta:setup` | `setup` | `provider` | Configure provider, CA, router, shell integration |
| `meta:shellenv` | `shellenv` | `none` | Print embedded shell snippets |
| `meta:uninstall` | `uninstall` | `minimal` | Remove recorded v4-owned files; `--yes`, `--dry-run` |
| `meta:update` | `update` | `plugins` | Update core and plugins |
| `meta:version` | `version` | `none` | Print embedded version |
| `meta:x` | `x` | `minimal` | One-shot package execution through `BunSelfRunner.x` |

Command-wide rules:

- `app:cache:refresh` performs full app bootstrap and refreshes the plan, tooling graph, and app command index. It MUST NOT contact the provider unless materialization requires a missing managed dependency.
- `app:info` and `app:rebuild` deduplicate services on first occurrence and validate all names before provider action. `app:info` selects no dependencies. `app:rebuild` selects transitive prerequisites in stable plan order and MUST leave unrelated services and dependents untouched.
- `app:includes:verify` MUST work offline from warm `<userCacheRoot>/includes/`; failures return `IncludeLockError` with update remediation.
- `app:restart` MUST preserve inner events and publish `pre-restart` and `post-restart` (§3.5, §11.4).
- `app:exec` and `app:ssh` forward §6.9.1 agent context. `app:open` is `hostProxyAllowed: true`. `meta:mcp`, `meta:bun`, and `meta:x` are not host-proxy or recipe-post-init allowed.
- `meta:events:follow` reads the `EventService` trace sink used by diagnostics and e2e tests; it does not subscribe to plugin events itself.
- `meta:uninstall` MUST remove only recorded v4-owned entries. Unrecorded root contents, Lando 3 state, foreign installs, and provider resources MUST remain untouched.
- `--clear` is universal and purges relevant caches.
- `app:start` and `app:rebuild` materialize declared dependencies. Repeating a successful start MUST NOT require network unless a source is absent, the lock changed, or app commands require it.
- `apps:poweroff` includes user, global, and scratch apps by default. `--keep-global` and `--keep-scratch` compose and MUST be reported.
- `meta:global:start` refuses an empty global app. `meta:global:list --format json` is canonical for automation.
- Scratch behavior is owned by §21. `ScratchSourceUnresolvedError` rejects both or neither of `--fork` and `--from`. Scratch JSON list output is canonical for automation.
- Commands tolerate apps with no services when semantics allow it.

Root TTY help contains **COMMON**, optional **THIS APP**, and **MORE**. Full catalog surfaces are `lando help --all` and `lando help --format json`; topic pages are `lando help <topic>` and `lando <topic> --help` (§8.4.2).

#### 8.2.1 The `app config` command

`app:config` owns `get`, `set`, `unset`, `edit`, `validate`, and `view`; conversion and provenance use `app:config:translate`, `app:config:explain`, and `app:config:migrate`.

| Surface | Contract |
|---|---|
| default / `view` | Read `raw`, `merged`, or default `resolved`; supports `--path` and structured formats |
| `get` | Read one key path |
| `set` | Write a typed value with `--type string\|number\|boolean\|json\|yaml` |
| `unset` | Remove a key |
| `edit` | Open `$VISUAL`/`$EDITOR`; `--target canonical\|local\|user` |
| `validate` | Validate merged Landofile (§7.8) |
| `translate` | `--from`, `--to` default `lando4`, `--file`, `--detect`, `--list`, `--write`, `--yes` |
| `explain` | Read-only recipe provenance; `--format json` |
| `migrate` | Ordered migration proposals; `--yes`, `--dry-run`, `--format json` |

Ordinary writes target the canonical Landofile unless `edit --target` selects another editable layer. They validate before atomic §12.3 persistence; failure returns `LandofileWriteValidationError`. Translation and migration use §12.4 transactions. Successful writes invalidate the app-plan cache. Key paths are dot-separated with bracket array indexes. Expressions and `${secret:...}` references are written literally.

Translation is preview-only without `--write`, MUST be explicit or unambiguous, MUST load translators only for conversion, and MUST NOT build an `AppPlan` or contact a provider. Only encoders with registered safe target mappings MAY write. `--file` MUST remain within that layer's authorized dependency closure. Preview and write MUST produce identical ordered, redacted diagnostics: `generated`, `dropped`, `rewritten`, `unsupported`, `non-portable`, and `needs-review`. Unsupported input or unpreservable loss MUST block writing.

`app:config:explain` MUST report producer identity, options, defaults, current values, value-based acceptance/chosen heuristics, current expression sites, and taken-over sites. It MUST validate producer identity and the injective `recipe.services` map. Opaque or unmatched provenance blocks semantic comparison but retains bounded current facts. Explain MUST NOT write, execute app or recipe code, follow includes, plan, or contact a provider.

`app:config:migrate` resolves only the injected declarative-snapshot registry within the recorded producer family. Missing or mismatched evidence and invalid chains fail closed. Ordered hunks are `option-default`, `add`, `remove`, `rename`, and `replace`, classified `already-satisfied`, `selected`, `retained-option`, or `blocking`. Structural changes require managed evidence; taken-over literals MUST NOT be overwritten. Service renames MUST atomically update managed references or block the edge. Interactive mode asks per selectable hunk; `--yes` selects untouched hunks; `--dry-run` writes nothing and acquires no write lock. Real writes commit only the longest contiguous satisfied edge prefix. Partial-edge commits and durable per-hunk progress are forbidden. Repeats MUST be byte-identical no-ops. Migration MUST NOT plan or apply the app. `meta:update` MAY report pending migrations but MUST NOT run them.

#### 8.2.2 The `meta:config` command

`meta:config` mirrors ordinary app-config operations against `<userConfRoot>/config.yml`. `config.d/*.yml` and `LANDO_*` overrides are read-only. Writes MUST validate the global schema, including plugin and provider extensions, and persist atomically. `view --source raw` reads only `config.yml`; `resolved` includes overlays and environment overrides. It runs outside app context at `minimal` bootstrap.

#### 8.2.3 The `app:shell` command

`app:shell` requires a TTY and otherwise returns `ShellRequiresTtyError`. Host mode uses `ShellRunner` at the app root with resolved `LANDO_*` values and host resolution. `--service` uses provider exec with TTY and §6.9.1 agent context. Secrets resolve only when explicitly referenced and MUST NOT be preloaded. History persists at `<userCacheRoot>/shell/<app-id>/history` unless `--no-history`; resolved secrets MUST be redacted before history writes.

The command publishes `cli-app:shell-init`, `cli-app:shell-run`, and `cli-app:shell-error`; inner commands publish `pre-shell-exec`/`post-shell-exec` or `pre-provider-exec`/`post-provider-exec` with redacted shapes.

#### 8.2.4 The `meta:bun` and `meta:x` commands

`meta:bun` forwards Bun argv to `BunSelfRunner`; `meta:x` requires a package spec and invokes `BunSelfRunner.x`. Both use caller cwd, stream output, preserve child exit status, run at `minimal`, and publish `cli-meta:bun-*`, `cli-meta:x-*`, and `pre-bun-self-exec`/`post-bun-self-exec`.

`BunSelfRunner` prevents recursive `BUN_BE_BUN` entry with `BunSelfReentryError`. Child failures return `BunSelfExecError`. Offline uncached `meta:x` returns `BunSelfOfflineError`; `meta:bun` passes offline policy through. Core reserves aliases `bun` and `x`.

#### 8.2.5 The `app:open` command

`app:open` resolves only planned `http` or `https` routes/endpoints from `ServiceInfo`. Default selection is the primary route, preferring HTTPS; `--service`, `--route`, and `--all` refine it. No target returns `OpenTargetUnresolvedError`; scheme violations use `HostProxyOpenUrlSchemeError` semantics. `--print` skips browser launch, and `--format json` returns targets. A headless host prints the URL and exits successfully. Events are `cli-app:open-*` plus `pre-open-url`/`post-open-url`.

#### 8.2.6 The `meta:mcp` command

`meta:mcp` serves stdio MCP in v4.0; streamable HTTP is deferred post-v4.0 (§10.14). Tools derive solely from `LandoCommandSpec` and return §8.11 envelopes. Effective allowance is default `mcpAllowed` plus global `mcp.allow` and `--allow`, minus config or CLI denies. Destructive commands are never default-allowed. `--tooling` or `mcp.tooling: true` adds resolved tooling. `--list` returns the effective catalog and exits.

The command retains one runtime, publishes `cli-meta:mcp-*`, and delegates per-call events to `pre-mcp-call`/`post-mcp-call`. It MUST NOT be host-proxy or recipe-post-init allowed.

### 8.3 Command contract

Every built-in and plugin command conforms to `LandoCommandSpec`; invocation conforms to `CommandInput`.

Named command types are `CommandNamespace`, `LandoCommandSpec<A, E extends LandoCommandError>`, `CommandInput`, `FlagSpec`, `ArgSpec`, `CommandDocsMetadata`, `AcceptanceCheckId`, `StreamFrameSchema`, and `LandoCommandRequirements`.

| `LandoCommandSpec` field | Contract |
|---|---|
| `id`, `namespace` | Canonical colon id and matching prefix; mismatch returns `CommandRegistrationError` |
| `summary`, `description`, `examples`, `hidden` | Help metadata |
| `aliases`, `topLevelAlias` | Namespaced and top-level aliases, optionally with `DeprecationNotice` |
| `helpGroup` | Only `"common"` and only for §8.4.2 locked ids |
| `bootstrap` | Required `BootstrapLevel` |
| `flags`, `args` | `FlagSpec` and `ArgSpec`, including optional deprecation |
| `deprecated` | Command `DeprecationNotice`; contradictions return `DeprecationContradictionError` |
| `recipePostInitAllowed` | Generated recipe command allowlist membership |
| `hostProxyAllowed` | Generated `host-proxy-allowlist` membership |
| `mcpAllowed` | Generated `mcp-allowlist` membership |
| `docs`, `acceptance` | Required public documentation and acceptance metadata |
| `resultSchema` | Required schema for every result; empty result uses an empty struct |
| `streaming` | Optional `StreamFrame` schema for streaming commands |
| `run` | Effect program over `CommandInput` and `LandoCommandRequirements` |

`CommandInput` is the imperative-shell boundary:

| Field | Contract |
|---|---|
| `args` | Schema-decoded positional values |
| `flags` | Schema-decoded named values |
| `raw` | Unprocessed argv after `--` |
| `stdin` | Effect stream of bytes |
| `stdout`, `stderr` | Effect sinks of bytes |

The adapter supplies universal format flags and IO bindings.

Read-only and non-destructive commands MAY set `mcpAllowed`; destructive built-ins MUST NOT. A destructive self-allow returns `McpAllowlistConflictError`. Host-proxy lifecycle commands MUST NOT self-allow; denied requests return `HostProxyCommandNotAllowedError`. Missing required registry metadata or `resultSchema` returns `CommandRegistrationError`.

Command registration and invocation preserve these schema-backed `_tag` values:

| `_tag` | Boundary |
|---|---|
| `CommandAliasConflictError` | Alias collision |
| `CommandAliasTargetError` | Unknown custom-alias target |
| `CommandRegistrationError` | Invalid or incomplete `LandoCommandSpec` |
| `CommandInputValidationError` | Input rejected by target schema |
| `DeprecationContradictionError` | Alias deprecation contradicts canonical command |
| `McpAllowlistConflictError` | Destructive built-in attempts default MCP allowance |
| `HostProxyCommandNotAllowedError` | Host-proxy canonical id not allowlisted |
| `NotImplementedError` | Registered deferred command plan |

### 8.4 Historical OCLIF integration (removed from shipping dispatch)

The retired OCLIF design used manifest-first routing, Effect lifecycle hooks, namespace topics, and flexible taxonomy. It is historical only; §8.4.1 and §14 Appendix D.1 own the current decision. Retained `src/cli/oclif/` names are native metadata or adapters.

#### 8.4.1 Single native dispatch (source + compiled)

Source mode and the compiled `$bunfs` binary share one registry and `runCli` dispatcher in `core/src/cli/run.ts`. Shipping code MUST NOT call OCLIF `execute()` or maintain a parity engine.

- Each `LandoCommandSpec` is registered once. Deferred ids live in `DEFERRED_COMMAND_PLANS` or its successor and return phase-tagged `NotImplementedError`.
- Cross-cutting CLI helpers live under `core/src/cli/` and MUST NOT be duplicated by entry mode.
- Source and relocated binary MUST have identical exit codes, tagged-error fields, and §8.11 output.
- Help, version, unknown-command, topics, and aliases derive from the registry.
- Canonical ids and aliases are colon-form tokens. Compatibility normalization is limited to `apps scratch run`; `scratch <start|stop|destroy|list|info|logs|gc|run>`; `meta recipes` and `recipes` with `list|describe|validate`; `share <list|stop>`; `meta global` and `global` with `config|destroy|info|install|list|logs|rebuild|restart|start|status|stop|uninstall`; global config `set|unset|edit|validate`; `app includes <update|verify>`; and `app config` with `translate|lint|set|unset|edit|validate`. Unsupported `apps list` and `app start` remain unknown.
- Level-`none` files MUST NOT import OCLIF, heavy Effect graphs, `@lando/sdk`, renderers, or plugins (§1.2).
- `@lando/core/oclif` is not exported; embedding uses `@lando/core/cli` (§16.2).
- `SIGINT` interrupts the active Effect fiber and finalizes scoped resources.

The historical OCLIF manifest is replaced by the registry-derived embedded manifest plus `plugin-command` and `app-command` indexes (§12.1). Router bootstrap MUST NOT parse Landofiles, resolve includes, contact plugin sources, import command modules, or initialize providers.

#### 8.4.2 Help projection

Help is a registry projection, not a `LandoCommandSpec`; it has no registry entry, `run()`, or `resultSchema`.

Outside an app, exact `--help` or `-h` MAY use manifest-only level-`none` output. All other help routes through `runCli`; compiled help lives on that path, not in another dispatcher.

The locked **COMMON** ids are `app:start`, `app:stop`, `app:restart`, `app:rebuild`, `app:destroy`, `app:info`, `app:logs`, `app:exec`, `app:ssh`, `apps:init`, `apps:list`, `meta:setup`, and `meta:doctor`. **THIS APP** appears only with a fresh app command cache. **MORE** points to full and JSON catalogs. Each command gets one row whose primary token prefers a custom alias, then an enabled implicit alias, then canonical id.

Color requires TTY stdout, renderer `lando`, non-JSON format, and no `NO_COLOR`; cold help MUST NOT import a renderer. Machine help uses `encodeCommandResult` with command `cli:help`. Topic pages cover registered namespaces and command tokens and show aliases, deferred status, flags, and args.

### 8.5 Tooling schema

`tooling:` is a Taskfile-inspired surface, not Taskfile compatibility. Its durable concepts are `cmds`, `deps`, `vars`, `sources`, `generates`, `status`, `preconditions`, and `run`.

Named tooling schemas and types include `ToolingTask`, `Command`, `TaskDependency`, `Precondition`, `Glob`, `Expression`, `FlagSpec`, and `ArgSpec`.

Metadata MUST normalize once after layers/includes and drive CLI, help, machine indexes, cache, and MCP identically. Stale caches MUST NOT bypass `disabled`. Unknown services, dynamic flags, invalid args, disabled tasks, and unsupported fields fail before execution with tagged source-aware remediation. Tasks default to namespace `app`; names MAY contain colon subnamespaces.

#### 8.5.1 Task definition

`ToolingTask` includes:

- Command graph: `cmd`, ordered `cmds`, `deps`, `aliases`, `namespace`, `topLevelAlias`, `internal`, `disabled`.
- Execution: `service`, `engine`, `bootstrap`, `user`, `dir`, `appMount`, `stdio`, `interactive`, `passThrough`, `hostProxyAllowed`.
- Data: `vars`, `env`, `dotenv`, `flags: FlagSpec`, `args: ArgSpec`.
- Freshness and policy: `sources`, `generates`, `method`, `status`, `preconditions`, `if`, `run`, `platforms`, `output`, `failFast`, `silent`.
- Documentation and evolution: `desc`, `summary`, `description`, `usage`, `examples`, `deprecated: DeprecationNotice`.
- Presentation: `prompt`, `silent`, `output: interleaved|group|prefixed`, and `failFast`.

A string task means one `cmd`. `cmd` normalizes to one ordered `cmds` step. `disabled` and `false` disable inherited tasks. `description` aliases `summary`. `namespace` defaults to `app`; `topLevelAlias` follows §8.1.2. Built-in ids are reserved. `hostProxyAllowed` defaults false and adds the canonical id to `host-proxy-allowlist` (§10.10, §12.1).

#### 8.5.2 Commands and dependencies

Steps are string commands or objects containing `cmd`, `task`, `command`, `defer`, or `for`. Per-step overrides include `service`, `dir`, `env`, `user`, `platforms`, `if`, `silent`, `ignoreError`, and `interactive`. `defer` finalizes in LIFO order when supported. Dependencies precede the body and independent dependencies run concurrently; `failFast: true` interrupts siblings. Serial composition uses ordered task steps.

##### 8.5.2.1 The `command:` step

`command:` invokes a canonical registered command with explicit `flags`, `args`, and `raw`; aliases are forbidden. Unknown ids return `ToolingCommandLookupError`. Inputs validate against the target spec and failures return `CommandInputValidationError`. Outer input is never implicitly forwarded.

Direct and indirect cycles return `ToolingCommandCycleError`. Effective bootstrap is the transitive maximum of declared and nested command requirements. Nested invocations publish the target's `cli-<id>-init|run|error` events with fresh `invocationId` and parent correlation, but MUST NOT independently trigger foreground completion presentation. Output shares the parent `Renderer`; `silent` suppresses renderer events, not logs. Interruption propagates. The step calls the canonical Effect program directly and does not reparse argv.

**Beta 1:** this is a frozen producer contract, not a US-459 deliverable. US-459 proves nested correlation and notification suppression through MCP but does not implement tooling `command:` execution.

#### 8.5.3 Variables and environment

Precedence is task-call vars; CLI flag/arg values; task vars/env; included-file vars; include-namespace vars; `toolingDefaults`; §6.9.1 provider-exec agent context; process environment. Static values use §7.3.1 expressions. Dynamic `vars.<name>.sh` run at invocation through the selected engine, are safely interpolated, MUST reject raw interpolation, and MUST NOT enter caches.

#### 8.5.4 Expressions in tooling

Tooling adds invocation-time scopes `task.name`, `task.subnamespace`, `task.commandNamespace`, `task.canonicalId`, `flags`, `args`, `raw`, `service`, `sources`, `generates`, `checksum`, `timestamp`, `item`, and `key`. They remain cached AST thunks until the step runs. Bootstrap-sensitive references require the effective level (§7.3.1).

#### 8.5.5 Dynamic service resolution

`service` accepts a fixed name, validated `:<flag-name>`, or `:host`. Missing or invalid dynamic values fail before execution and MUST NOT fall back to raw argv. Step values override task `service`, `user`, and `dir`. `:host` MUST avoid provider initialization and use the `host` `ToolingEngine` backed by `ShellRunner`; argv-precise work SHOULD use a `ProcessRunner`-backed engine. Host execution remains subject to redaction, lifecycle, cancellation, and `PrivilegeService`.

#### 8.5.6 Up-to-date checks and run policy

`method: checksum|timestamp|none`, `sources`, `generates`, and zero-exit `status` determine freshness. `preconditions` MUST succeed before dependencies or commands. `run: always` always attempts execution after checks; `once` runs once per top-level graph; `when_changed` keys by task, input, vars, and source fingerprint. `--force` bypasses skips. `--status` reports freshness without execution.

#### 8.5.7 Events as tasks

Landofile `events:` accepts the same step types as `cmds` and adds decoded `.event` payload context. Event-triggered tasks execute directly and MUST NOT register router commands. The valid event set MUST be extended from fully resolved tooling before validation, including `pre-restart`, `post-restart`, and `pre-<tool>`/`post-<tool>`.

Nested event/command invocation MUST reject cycles with a visited stack and bounded depth. A failed pre-step prevents the body; a failed body prevents success post-steps; post-steps preserve order and failure is fatal with redacted output. CLI, MCP, and library paths MUST preserve identical ordering and failure semantics.

#### 8.5.8 Tooling includes

Tooling imports use `includes:` with `kind: tooling`; `toolingIncludes:` is equivalent sugar. Fragments allow only `tooling:` and nested `toolingIncludes:`. Other Landofile keys and bare nested `includes:` fail with `LandofileIncludeError`. Paths resolve from the declaring file. Included tasks default to `<include-namespace>:<task>`; `flatten` removes that prefix; namespace `aliases` require a non-flattened include. `optional`, `internal`, `excludes`, and `vars` apply at include scope. Local task ids win. Cycles return `ToolingIncludeCycleError`.

Beta 1 tooling fragments are local-file only; include-level `checksum`, `dir`, and bulk `topLevelAlias` are unsupported and fail closed. Per-task aliases remain valid.

`toolingIncludes.<namespace>` supports `file`, `optional`, `flatten`, `internal`, `aliases`, `excludes`, and `vars`. A fragment's own `tooling:` entry wins over nested include contributions with the same id.

#### 8.5.9 `.bun.sh` script-backed tasks

CLI mode auto-discovers `.lando/scripts/**/*.bun.sh`; path segments form `app:` subnamespaces. A Landofile task of the same id wins. Library mode requires `autoDiscoverBunShellScripts: true` (§16.5).

Top comment front matter validates as `BunShellScriptFrontMatter` and MAY carry `desc`, `summary`, `aliases`, `topLevelAlias`, `service`, `bootstrap`, `flags`, `args`, `passThrough`, `sources`, `generates`, `status`, `preconditions`, `run`, `platforms`, `internal`, and `disabled`. Missing or malformed metadata returns `BunShellScriptFrontMatterError`; empty files return `BunShellScriptEmptyError`.

Default service is `:host`. Scripts run through `ShellRunner.runScript`; realpaths MUST remain under the app or permitted recipe cache, else `ShellScriptOutsideRootError`. They MUST NOT require host Node.js. Inputs are available through `LANDO_FLAG_<NAME>`, `LANDO_ARG_<NAME>`, and serialized `LANDO_INPUT: CommandInput`. Script checksum participates in freshness.

### 8.6 The `ToolingEngine` abstraction

The Effect service tag `ToolingEngine` has `id`, `canHandle(ToolingSpec)`, `compile(ToolingSpec) -> ToolingProgram | ToolingCompileError`, and `execute(ToolingProgram, CommandInput) -> ExecResult | ToolingExecError` with provider/process/shell requirements.

Core ships `providerExec` and `host`. `providerExec` targets services through the active `RuntimeProvider`, preferring exec against a running service and using ephemeral run only when explicitly configured. `host` targets `:host` through `ShellRunner` and also backs host dynamic vars, `.bun.sh`, and `app:shell`. Plugin engines include `processExec` for argv-precise host work, `remote`, and `dryRun`; none is bundled except the two core engines.

Selection precedence is step `engine` → task `engine` → `toolingDefaults.engine` → Landofile `toolingEngine` → global `toolingEngine` → `providerExec`.

### 8.7 Tooling compilation pipeline

Compilation validates raw and resolved `ToolingTask`/`BunShellScriptFrontMatter`, resolves compile-time expressions and includes, merges discovered scripts, constructs and checks the task and command graphs, derives bootstrap/service/input metadata, selects an engine, compiles `ToolingProgram`, and writes registry metadata plus caches.

Routing metadata lives in the app command index; executable graphs live in the app-plan cache. The index contains canonical ids, namespace, aliases, help/input metadata, effective bootstrap, and cache key. `ToolingProgram` contains normalized tasks, dependencies, command targets, schemas, expression ASTs, static data, freshness plans, and engine ids. It MUST exclude dynamic shell results, decrypted secrets, runtime service info, and provider connections.

Invocation MUST:

1. Resolve the canonical id from the app command index.
2. Read the cached `ToolingProgram` by app-plan cache key.
3. Parse argv through cached `FlagSpec` and `ArgSpec` metadata.
4. Resolve invocation expressions, service target, call vars, freshness checks, and dynamic vars.
5. Build the task's effective bootstrap layer.
6. Execute the selected engine and propagate its exit status.

Missing or stale indexes omit tooling commands rather than reparse the Landofile; command-not-found remediation points to `app:cache:refresh`, `app:start`, or `app:rebuild`. The hot path MUST remain offline after dependencies and task graph materialize.

Tooling caches and paths are persisted contracts:

| Name | Contract |
|---|---|
| `app-command` / app command index | Routing metadata at `<userCacheRoot>/apps/<app-id>/commands.bin` |
| app-plan cache | Compiled `ToolingProgram` and app plan (§12.1) |
| `host-proxy-allowlist` | Canonical host-proxy command/task ids |
| `.lando/scripts/**/*.bun.sh` | Auto-discovered CLI task source |
| `LANDO_INPUT` | Serialized `CommandInput` for script tasks |

Tooling failures preserve these `_tag` values:

| `_tag` | Boundary |
|---|---|
| `ToolingCommandLookupError` | Unknown nested canonical command |
| `ToolingCommandCycleError` | Direct or indirect recursion |
| `ToolingIncludeCycleError` | Include recursion |
| `LandofileIncludeError` | Invalid fragment or include shape |
| `BunShellScriptFrontMatterError` | Invalid `.bun.sh` metadata |
| `BunShellScriptEmptyError` | Empty script task |
| `ShellScriptOutsideRootError` | Script realpath escapes authorized root |

### 8.8 `lando apps:init` and the v4 recipe model

`apps:init` scaffolds a visible, user-owned Landofile from a versioned `RecipeDecomposer` producing `LandofileAuthoringFragment`.

- Every selected service, route, task, event, and default MUST be written.
- Runtime recipe expansion remains forbidden.
- `RecipeDefinition` and the `recipes:` plugin contribution remain removed.

Persistable nonsecret options MUST appear in inert `recipe.options` with producer identity and `RecipeManifest.version`. Generated option-derived values MUST use valid `{{ recipe.<option> }}` expressions. Expressions MAY produce values but MUST NOT determine structure. `init` uses the bundled `recipe` translator and `lando4` encoder, MUST NOT build an `AppPlan`, and MUST NOT contact a provider itself.

`files:` and `postInit:` are init-only and run only after translation, encoding, validation, and §12.4 commit.

- Later failure reports committed files and failed action without claiming rollback.
- Diagnostics are ordered translation then encoding diagnostics.
- The CLI MUST NOT generate `.lando.ts`.

#### 8.8.1 Command surface

`apps:init [destination]` accepts `--recipe`, `--source`, `--name`, repeated `--answer`, `--answers`, `--no-interactive`, `--yes`, `--full`, and `--from-source`.

- Destination defaults to `--name` or cwd and MAY contain files. Existing Landofile destinations fail with `InitTargetExistsError`; any other scaffold conflict skips the scaffold set while free Landofile destinations remain writable.
- Omitted interactive `--recipe` prompts from bundled recipes. `--source` layers an `InitSource` beneath recipe files.
- `--answer` and `--answers` accept nonsecret values; later values win. Raw secret keys are rejected. Secret-store answers accept only existing `${secret:...}` references.
- `--no-interactive` fails unanswered prompts without defaults with `RecipeMissingAnswerError`. `--yes` accepts defaults; `--full` accepts the full default set. The command runs at `plugins` bootstrap without provider contact.

#### 8.8.2 Recipe directory layout

A recipe directory contains exactly one `recipe.yml` or `recipe.ts`, optional `templates/`, `assets/`, and `fragments/`, plus `README.mdx`. The Landofile comes from decomposition and encoding, not a template. `TemplateRenderer` renders templates; assets and fragments copy verbatim. Recipe READMEs follow §19.13.

#### 8.8.3 The `recipe.yml` schema

`RecipeManifest` is published from `@lando/sdk` and as JSON Schema. Load-bearing keys are:

| Key | Contract |
|---|---|
| `id`, `title`, `description`, `version` | Identity and required semver provenance; `id` matches directory |
| `snapshot` | Versioned producer identity, serializable option types/defaults, expression template, asset digests |
| `migrations` | Ordered declarative `{ from, to, fromSnapshot, toSnapshot, hunks }` edges |
| `authors`, `tags`, `deprecated`, `requires` | Catalog, evolution, and soft prerequisites |
| `runs`, `fetchAllowlist` | Canonical-command and HTTP-GET allowlists for programmatic init |
| `prompts` | Ordered `RecipePrompt` values using §8.10 vocabulary plus disposition, `when`, `choicesFrom`, deprecation |
| `files` | Ordered auxiliary source/destination, condition, mode, and template policy |
| `postInit` | Ordered `gitInit`, `message`, `command`, and `bun` actions |
| `extends` | Single recipe parent (§8.8.15) |

`snapshot` fields are `identity`, `optionTypes`, `defaults`, `template`, and `assets`. Each migration edge carries exact `from`, `to`, `fromSnapshot`, `toSnapshot`, and ordered `hunks`; every hunk carries stable `id`, `kind`, owning `layer`, canonical `path`, and old/new presence and value.

`RecipePrompt` adds `disposition`, `when`, `deprecated`, validation, static `choices`, or dynamic `choicesFrom` with `run`, expression-resolved `args`, and optional `map`. `files` carries `src`, destination-relative `dest`, `when`, optional POSIX `mode`, and `template` policy.

Every bundled recipe MUST publish safely renderable declarative current snapshot data. Snapshot and migration data are inert and MUST NOT contain callable application logic. Edges remain within one producer family, form a unique monotonic chain, and carry stable hunk identities. Declared hunks MUST agree with snapshot diffs.

Snapshot evaluation uses only `options` and the closed pure §7.3.1 helper subset. Filesystem, process, remote access, arbitrary JavaScript, loaders/importers, and nonportable decoders are forbidden. Evaluation is bounded and quoted output expressions are data, not recursively evaluated. Unsupported schema refinements make a recipe nonmigratable rather than executable.

Recipe and prompt `deprecated` values emit `message.warn`, register §18 notices, and appear in doctor deprecation output. Prompt names MUST be unique. Every secret prompt declares exactly one disposition. `postInit.command` accepts only generated allowlisted canonical ids.

Migration snapshot helper names remain the closed pure §7.3.1 set, including scalar logic, collection transforms, JSON/base64, shell quoting, path, URL, and semver helpers. `load`, `import`, filesystem helpers, host lookup, remote access, commands, and arbitrary JavaScript MUST be rejected.

#### 8.8.4 Recipe sources

| Reference | Resolution |
|---|---|
| bare id | Built-in `recipes/<id>/` |
| relative or absolute path | Local directory |
| `github:` or `git+https:` | Content-addressed `<userCacheRoot>/recipes/git/<sha>/` |
| `npm:` | `<userCacheRoot>/recipes/npm/` |
| `registry:` | Reserved for post-v4.0 `recipes.lando.dev` |

Resolution is content-addressed and cached for offline reuse.

#### 8.8.5 Prompt types

| Type | Contract |
|---|---|
| `text` | Single-line validated string |
| `select` | One static or `choicesFrom` value |
| `multiselect` | Validated value array |
| `confirm` | Boolean |
| `number` | Validated number |
| `secret` | Masked, centrally redacted, exactly one `secret-store` reference or named init-only sink |
| `path` | Destination-relative path with optional existence validation |
| `editor` | Multi-line editor input; falls back to text when unavailable/non-interactive |

Recipes resolve prompts through `InteractionService`. Raw secrets MUST NOT enter templates, argv, files, provenance, diagnostics, journals, transcripts, renderer events, telemetry, or decomposition. The resolver MAY deliver raw bytes only to the declared post-commit sink. Falsy `when` skips the prompt and yields `undefined` to later expressions.

#### 8.8.6 Recipe expressions

Recipe values use §7.3.1 expressions. Auxiliary files MAY use `TemplateRenderer`, per-file engines, and whole-file conditional/iteration blocks; `recipe.yml` strings allow interpolation only. `TemplateRenderContext` extends with safe answers, recipe metadata, destination, cwd, host facts, environment, and init flags. Recipes MUST NOT call shell or filesystem functions. Snapshot evaluation remains `options`-only.

#### 8.8.7 File manifest semantics

Auxiliary files write in manifest order after Landofile transaction commit. Landofile basenames are reserved for encoder output. Existing Landofiles fail with `InitTargetExistsError`; scaffold conflicts skip the scaffold set; duplicate destinations fail. Assets default to verbatim and templates to rendered. POSIX `mode` is ignored on Windows. False `when` entries are skipped and reported.

Files use `ManagedFileService` whole-file ownership and §12.3 atomicity. Authoring fragments, Landofile, manifests, and templates MUST validate before commit; failures return `RecipeOutputValidationError` with no partial files. Post-commit failures report committed state.

#### 8.8.8 Post-init actions

Actions run in order only after successful commit and auxiliary writes. Named `postInit.stdin` and `postInit.secretEnv.<name>` bindings identify prompt and action without serializing raw answers.

| Action | Contract |
|---|---|
| `gitInit` | Initialize and commit when git exists and destination is not already a repo |
| `message` | Emit renderer-aware expression text |
| `command` | Invoke a `recipePostInitAllowed` canonical command at its bootstrap level |
| `bun` | Invoke `BunSelfRunner` with `verb: script\|install\|add\|create\|run\|x` |

`command` actions MAY bind named `stdin` and `secretEnv`. Bun verbs use their declared shapes: `script` plus argv, `install`, `add` dependency groups, `create` template/destination, package-script `run`, and package-spec `x`.

The initial generated `postInit.command` allowlist is `app:config:translate` and `app:start`. Start requires explicit opt-in and MUST NOT be the default. Plugin installation, updates, setup, global config, shell integration, and arbitrary tooling are forbidden.

All Bun actions are destination-bounded, redacted, recursion-guarded, lifecycle-evented, and shape-validated. Violations use `BunSelfArgvShapeError`, `BunActionOutsideDestinationError`, `BunCreateOutsideDestinationError`, `BunScriptOutsideRecipeError`, or `BunScriptChecksumError`. Interruptions return `RecipeInterruptedError`; committed or externally created files are not rolled back. Network-capable Bun verbs are the explicit recipe network exception and SHOULD be user-controllable. Arbitrary shell hooks are forbidden outside bounded `verb: script`.

#### 8.8.9 Init lifecycle

`apps:init` resolves and validates sources, collects answers through `InteractionService`, decomposes and encodes, prevalidates all outputs, commits through §12.4, then writes auxiliaries and runs post-init actions. It publishes canonical `apps:init` lifecycle events. Optional `app:start` is a separate nested command after scaffolding.

#### 8.8.10 Canonical recipes shipped in core

| Recipe | Stack |
|---|---|
| `wordpress` | WordPress, PHP, MariaDB, optional Redis |
| `drupal` | Drupal, PHP, MariaDB or PostgreSQL, Drush |
| `drupal-cms` | Drupal CMS starter on `drupal` |
| `laravel` | Laravel, PHP, SQL, Redis, optional worker |
| `symfony` | Symfony, PHP, PostgreSQL or MariaDB, Redis |
| `backdrop` | Backdrop on `lamp` |
| `joomla` | Joomla on `lamp` |
| `mean` | Node, MongoDB, optional Redis |
| `lamp` | Apache, PHP, MariaDB |
| `lemp` | nginx, PHP-FPM, MariaDB |
| `toolbox` | Disposable version-pinned CLI service with non-interactive defaults |
| `rails` | Rails, PostgreSQL, Redis |

Bundled recipes live under `recipes/<id>/`, ship manifest/program, templates, `README.mdx`, and declarative snapshot, and are embedded by the bundled recipe registry. The set MAY grow in v4.x; removal requires a major version and `DeprecationNotice` (§18). Generated Landofiles MUST be YAML.

Planned 4.x additions are `node-api`, `astro`, `sveltekit`, `nextjs`, `django`, `fastapi`, `jekyll`, `hugo`, `eleventy`, and `empty`. Hoster recipes are deferred to 4.1 `RemoteSource` work (§10.12); v3 compatibility shims remain out of scope. Alpha 1 `rails` source is `recipes/rails/`, includes `rails` and `bundle` tooling, gives every prompt a non-interactive default, and requires an executable README.

#### 8.8.11 Recipe authoring surface

Recipes are independently versioned plain directories. `meta:recipes:validate` validates a path; `meta:recipes:describe` resolves and reports metadata and prompts without init. Authors MAY publish through local, git, npm, or future registry sources.

#### 8.8.12 Constraints

Declarative recipes MUST NOT execute arbitrary code, install plugins, mutate global config or `<userConfRoot>`, or contact the network outside source resolution and explicit bounded post-init actions. They write only within destination. Provenance remains inert during ordinary loading; explain and migrate MAY consult matched declarative snapshots only.

#### 8.8.13 Init sources beyond recipes

`InitSource` (§4.2) contributes `cwd`, `git`, `tarball`, and future source material. Source files precede recipe files; recipe files win according to conflict policy. Source and recipe validation MUST succeed before Landofile commit. Init sources MUST NOT plan or contact a provider.

#### 8.8.14 Programmatic recipes (`recipe.ts`)

`recipe.ts` is mutually exclusive with `recipe.yml`. It default-exports a static `RecipeManifest` or async `RecipeContext -> RecipeManifest`, optionally wrapped by `defineRecipe` from `@lando/core/schema`/`@lando/sdk`; runtime output still decodes through the canonical schema.

`ctx.prompt` is the only prompt path and delegates to `InteractionService`; raw init-only secrets remain outside factory data. `ctx.run` may invoke only ids in `runs`, else `RecipeForbiddenCommandError`. `ctx.fetch` permits HTTP GET only to `fetchAllowlist`, else `RecipeForbiddenFetchError`. Top-level side effects, arbitrary shell, plugin/global mutation, and other network access are forbidden. Evaluation is bounded.

The global `recipe.tsTimeoutMs:` setting bounds factory evaluation. Factories MUST NOT broaden post-init destination permissions or bypass `RecipeManifest` validation.

Describe/validate use a sandboxed synthetic prompt walk. Compiled modules cache at `<userCacheRoot>/recipes/ts/<contentHash>.bin`, but each init invokes the factory. Bundled codegen embeds prebuilt output. Programmatic recipes otherwise share all source, destination, post-init, snapshot, and constraint rules. Explain and migration MUST NOT execute local programmatic recipe code without matching declarative snapshots.

#### 8.8.15 Recipe composition (`extends:`)

`extends:` accepts any recipe reference and provides bounded, acyclic single inheritance. Prompts merge by id with child override/drop; files merge by destination with child win; post-init concatenates parent then child; child scalars win. The flattened result MUST validate as `RecipeManifest`; downstream consumers never see inheritance. Programmatic recipes MAY return `extends:`.

#### 8.8.16 Recipe option parity

`drupal` MUST offer supported Drupal, PHP, webserver, database/version, webroot, and Composer choices, with project-local Drush. `drupal-cms` inherits that surface and serves the real scaffold docroot. `lamp` MUST offer database/version, PHP, Composer, and webroot choices. Every prompt has a non-interactive default, and each `README.mdx` exercises a non-default variant (§19.13).

Recipe and init failures preserve these schema-backed `_tag` values:

| `_tag` | Boundary |
|---|---|
| `InitTargetExistsError` | Landofile destination already exists |
| `RecipeMissingAnswerError` | Required answer absent; aliases `InteractionRequiredError` |
| `RecipeOutputValidationError` | Manifest, authoring, Landofile, or auxiliary output invalid |
| `RecipeForbiddenCommandError` | Programmatic command outside `runs` |
| `RecipeForbiddenFetchError` | URL outside `fetchAllowlist` |
| `BunSelfArgvShapeError` | Invalid bounded Bun action payload |
| `BunActionOutsideDestinationError` | Bun cwd escapes destination |
| `BunCreateOutsideDestinationError` | Create destination escapes recipe root |
| `BunScriptOutsideRecipeError` | Script path escapes recipe tree |
| `BunScriptChecksumError` | Embedded script checksum mismatch |
| `RecipeInterruptedError` | Init interrupted after scoped cancellation |

Recipe persisted locations are `recipes/<id>/`, `<userCacheRoot>/recipes/git/<sha>/`, `<userCacheRoot>/recipes/npm/`, and `<userCacheRoot>/recipes/ts/<contentHash>.bin`. Manifests, generated Landofiles, and snapshots MUST remain independent of provider state.

### 8.9 Renderers and messages

The Effect service tag `Renderer` has `id`, current `RendererCapabilities`, `render(Stream<RenderEvent>)`, and immediate first-paint emission. `RendererCapabilities` is the schema-backed boolean set `color`, `interactive`, `animation`, and `notifications`.

Named renderer contracts include `Renderer`, `RendererCapabilities`, `RenderEvent`, `ImmediateLine`, and `RenderError`.

Capabilities default false. The default TTY renderer starts with `interactive` and `animation` true and MAY monotonically promote `color` and `notifications` once after a nonblocking substrate probe. Callers MUST reread capabilities at use time; pre-promotion events are not replayed. Degraded, non-TTY, `plain`, and `json` runs expose no interactive capabilities; TTY `verbose` exposes color only. Third-party renderers MUST use immutable capability snapshots and monotonic promotion.

Built-in `RenderEvent` names are:

| Family | Events |
|---|---|
| Tasks | `task.start`, `task.progress`, `task.complete`, `task.fail`, `task.tree.start`, `task.tree.complete`, `task.detail`, `task.detail.expand`, `task.detail.collapse` |
| Logs/messages | `log.line`, `message.info`, `message.warn`, `message.error` |
| Tables/prompts | `table.row`, `table.end`, `prompt.start`, `prompt.complete` |
| Presentation | `paint.banner`, `code.snippet`, `diff.render`, `markdown.block`, `notify.desktop` |

`task.tree.start` identifies parent, label, children, and optional layout mode. `task.detail` identifies task, stdout/stderr stream, and line. Detail expand/collapse are renderer input events, not caller output events.

The default renderer is plugin `@lando/renderer-lando`, id `lando`. Core fallbacks are `json`, `plain`, and `verbose`. Selection precedence is `--renderer` → `LANDO_RENDERER` → global `renderer:` → TTY/CI detection, choosing `json` for non-TTY/CI and `lando` otherwise. Typed messages and schemas are published from `@lando/sdk`.

#### 8.9.1 First-paint contract

Renderers MUST meet §2.1 policy:

| Event | Requirement |
|---|---|
| Pre-bootstrap banner | One line within 50 ms cold, before plugin import for bootstrap ≥ `plugins` |
| TTY events | Flush as they arrive; only structured single-document output MAY buffer |
| Table first paint | Headers by first row within 80 ms cold |
| Spinner | Show after 100 ms without progress; avoid shorter flashes |
| Completion | Final line within 50 ms of terminal event |
| Level `none` | Direct native output; `Renderer` is not involved |

The tiny pre-renderer MUST NOT import Effect, OCLIF, renderer services, or plugins and is the only pre-Layer direct-output path. Renderer construction consumes synthetic `paint.banner` state to avoid duplication. Non-TTY output has no spinners; tables MAY buffer, but first-byte budgets remain. JSON emits exactly one stdout result and structured stderr events, with a first stderr event inside the meaningful-line budget.

#### 8.9.2 Concurrent task tree contract

`task.tree.start`/`complete` bracket concurrent children. TTY renderers show parent/child state, recent per-task `task.detail`, success/failure summaries, focus navigation, and Enter/Escape expand/collapse. Expanded full-tail view uses persisted §6.13.6/§12.4 transcripts and MUST preserve cancellation and restore the tree. It remains available after completion. Renderers publish `task.detail.expand` and `task.detail.collapse` through `EventService`.

Non-TTY mode emits stable-prefixed detail lines and tree summaries with no input or alt screen. `json` emits structured task events on stderr. `plain` emits only completion/failure summaries. Publishers redact `task.detail`; local transcript full-tail is not exported to telemetry, guide transcripts, or JSON. Ctrl+C MUST interrupt every in-flight child and MUST NOT be swallowed in expanded view.

#### 8.9.3 Default renderer implementation contract

`@lando/renderer-lando` uses `@opentui/core` version 0.4.3 or later for TTY rendering.

- Production code MUST use the literal dynamic import `import("@opentui/core")` inside the renderer plugin.
- Core, level-`none`, pre-renderer, non-TTY, `plain`, and `json` paths MUST NOT load it.
- Renderer tests MAY statically import `@opentui/core/testing`.

Initialization failure MUST degrade to non-TTY line mode with a debug notice and MUST NOT fail the command or contaminate machine output. Task trees use the substrate's pinned split-footer live region, atomic frames, native scrollback, resize replay, and alt-screen transition. Animation runs only while needed and is capped at 30 fps. Prompt chrome uses the same substrate without changing `InteractionService` contracts. Headless frame snapshots cover task transitions, all prompt types, narrow terminals, and resize.

#### 8.9.4 Rich render events

`CodeSnippetEvent` (`code.snippet`) carries code plus optional language, path, start line, and highlighted lines. `DiffRenderEvent` (`diff.render`) carries unified diff plus optional path/language. `MarkdownBlockEvent` (`markdown.block`) carries Markdown. These schemas are frozen at 4.0 as contract-only; rich TTY presentation and core emitters are deferred to 4.1.

4.0/degraded/plain modes emit safe verbatim forms; JSON passes structured events. Publishers MUST redact content. Plain unified diffs MUST remain patch-applicable. Unknown languages fall back to plain text.

#### 8.9.5 Renderer panel slots

Renderer panels are frozen 4.0 contract-only surface; default-renderer runtime support and the first bundled consumer are deferred to 4.1. Published schema contracts are:

- `RendererPanelSlot`: closed ids `status-bar`, `task-tree:footer`, `doctor:summary`.
- `RendererPanelId`: validated plugin-scoped id.
- `RendererPanelWatch`: bounded unique closed-event list.
- `RendererPanelManifestEntry`: `id`, `slot`, `watch`, contained relative `module`.
- `StyledSpanTone`: `default`, `muted`, `accent`, `success`, `warning`, `danger`.
- `StyledSpan`, bounded `PanelView`, positive `RendererPanelSize`, and `RendererPanelContext` using optional `AppRef`, size, and `LandoEvent`.
- `RendererPanel`: matching `id` and pure synchronous `render(RendererPanelContext) -> PanelView`.

`RendererPanelManifestEntry.watch` is manifest metadata so the loader can decide whether to import. `StyledSpan` exposes text, tone, bold, dim, italic, and underline. `PanelView` is bounded schema data; validation failure drops the panel rather than truncating it.

Plugins contribute `rendererPanels:` (§9.5). Manifest shape, ids, slots, watch events, and module containment validate before import; failures are `PluginManifestError`. Panels import only in isolated workers when their slot becomes visible. Export failures, identity mismatch, or load failure are `PluginLoadError`. Runtime/decode/bound failures isolate and permanently drop only that panel with a debug notice; malformed output MUST NOT be clipped into validity. Panels are output-only, have no terminal/input control, and consume already-redacted events. Untrusted panels use standard plugin trust.

The 4.1 runtime MUST enforce bounded worker startup, binary messages, render deadlines, one in-flight render, coalescing, and last-good view retention without blocking the render loop. The 4.0 `@lando/sdk/test` Renderer panel contract suite proves timeout, throw, invalid output, purity, determinism, and bounds in a terminable worker. It is a §13.1 shared suite, not one of the §4.2 six plugin-abstraction kit suites.

#### 8.9.6 Keymap: renderer actions and bindings

The closed action vocabulary and defaults are frozen at 4.0; global `keymap:` overrides and help overlay land in 4.1.

| Action | Surface | Default |
|---|---|---|
| `tree.focus-prev` | task tree | `up` |
| `tree.focus-next` | task tree | `down` |
| `tree.cycle` | task tree | `tab` |
| `tree.expand` | task tree | `enter` |
| `tree.collapse` | task tree | `escape` |
| `prompt.cancel` | prompt | `escape` |
| `viewer.scroll-up` | viewer | `page-up` |
| `viewer.scroll-down` | viewer | `page-down` |
| `viewer.follow` | viewer | `f` |
| `viewer.source-next` | viewer | `s` |
| `viewer.quit` | viewer | `q` |
| `keymap.help` | keymap overlay | `question-mark` |

Published schemas are `RendererActionId`, `RendererKeyName`, `RendererKeyChordPattern`, `RendererKeyChord`, `RendererKeyBinding`, and `KeymapConfig`. Chords use canonical lowercase modifier order `ctrl+`, `alt+`, `shift+` and a closed key vocabulary. Each action has a bounded unique chord list. Malformed bindings fail ordinary `ConfigError`. `ctrl+c` is permanently reserved for `Effect.interrupt` and cannot be bound, disabled, or shadowed.

Same-surface chord collisions fail after schema decode with `KeymapConflictError`, carrying `_tag: "KeymapConflictError"`, `surface`, `chord`, sorted `actions`, `message`, and `remediation`. Cross-surface reuse is valid. Plugins cannot add actions in 4.0. Non-TTY binds nothing.

#### 8.9.7 Desktop notifications

`NotifyDesktopEvent` (`notify.desktop`) carries nonempty `title`, optional `body`, and optional urgency `info|success|failure`. Publishers MUST redact content. The renderer sanitizes line/control and bidi characters, normalizes Unicode NFC, drops empty results, and realizes notifications only when current `RendererCapabilities.notifications` is true. JSON passes the structured event; plain/non-TTY drops it. Lando MUST NOT hand-frame terminal notification protocols.

Bundled plugin `@lando/notify-lando` owns policy through `NotifyConfig` at global `notify:` with `enabled` default true, `thresholdMs` default 15000, and bounded additional canonical `commands`. The default eligible family is ordered: `app:start`, `app:stop`, `app:restart`, `app:rebuild`, `app:destroy`, `meta:setup`, `meta:update`. Config ids validate against the cwd-independent global registry, then deduplicate in first-occurrence order. Unknown ids return `ConfigError`.

Only the outer invocation qualifies, at `durationMs >= thresholdMs`, once per run, on success or failure. Nested canonical calls never notify independently. Lower-tier eligible commands promote to bootstrap `commands` except contract-sensitive `meta:doctor`, which remains `none` and cannot notify. The subscriber priority is **900**. `notify.enabled: false`, plugin disablement, non-TTY, or missing capability silences presentation. Container-initiated notification or clipboard relay is a v4.0 non-goal (§10.10).

#### 8.9.8 Interactive log viewer

The `app:logs --follow` TTY viewer is spec-frozen for 4.1. It consumes the same redacted labeled `LogChunk` stream and selectors as line mode, adds bounded scrollback and source filtering, starts following, unsticks on scroll, and uses `viewer.*` actions. Exit leaves visible logs in normal scrollback. `--no-viewer`, non-TTY, `plain`, and `json` force byte-identical line mode. At 4.0 `--no-viewer` is accepted as a no-op; no new schema is introduced.

Renderer lifecycle and presentation names are stable:

| Surface | Names |
|---|---|
| Command | `cli-<canonical-id>-init`, `cli-<canonical-id>-run`, `cli-<canonical-id>-error` |
| Restart | `pre-restart`, `post-restart` |
| Shell/provider | `pre-shell-exec`, `post-shell-exec`, `pre-provider-exec`, `post-provider-exec` |
| Bun | `pre-bun-self-exec`, `post-bun-self-exec` |
| Open URL | `pre-open-url`, `post-open-url` |
| MCP | `pre-mcp-call`, `post-mcp-call` |
| Tooling | `pre-<tool>`, `post-<tool>`, `tooling-step-start`, `tooling-step-skip`, `tooling-step-complete`, `tooling-step-fail` |

Renderer failures use existing `RenderError`, `PluginManifestError`, `PluginLoadError`, `ConfigError`, and `KeymapConflictError`; panel isolation MUST NOT introduce panel-specific public error tags.

### 8.10 Interaction and prompts

The Effect service tag `InteractionService` owns typed input for recipes, plugin authoring/trust, setup, and doctor fixes. It is the input peer of `Renderer`, not a raw-keystroke or shell-stdin owner, and is pluggable under §4.2.

#### 8.10.1 Prompt vocabulary

Published schema contracts are `PromptType`, `PromptChoice`, `PromptValidate`, `PromptSpec`, `PromptAnswer`, and `ChoicesFrom`.

| `PromptSpec` field | Contract |
|---|---|
| `name` | Stable answer key |
| `type` | One of the eight §8.8.5 prompt types |
| `message` | User-facing question |
| `default` | Optional scalar default |
| `validate` | Optional `PromptValidate` |
| `choices` | Optional static `PromptChoice[]` |
| `choicesFrom` | Optional canonical-command choice source |

`RecipePrompt` extends `PromptSpec` with recipe `when`, disposition, and deprecation. The eight `PromptType` values are frozen on ship.

#### 8.10.2 The service interface

`InteractionService` exposes:

| Member | Contract |
|---|---|
| `id` | Implementation id |
| `isInteractive` | Effect-resolved mode and TTY decision |
| `prompt` | Resolve one `PromptSpec` |
| `promptAll` | Resolve an ordered batch with prior-answer context |
| `confirm` | `ConfirmSpec` helper |
| `select` | Generic `SelectSpec<A>` helper |
| `secret` | `SecretSpec` helper returning `Redacted.Redacted<string>` |

`PromptBatchOptions` carries explicit answers, `answersFile: AbsolutePath`, `yes`, mode `auto|interactive|non-interactive`, and cwd. Batch output is `PromptAnswers`. Every method returns a scoped Effect with `InteractionError`; the interface is frozen on ship.

#### 8.10.3 Answer-source precedence and interactivity mode

Per prompt precedence is explicit answers → defaults when `--yes` or non-interactive → interactive prompt → `InteractionRequiredError`. `auto` is interactive only with TTY stdin. CLI defaults to `auto`; library mode defaults non-interactive (§16.3).

One shared parser owns repeated `--answer`, `--answers`, `--yes`, `--no-interactive`, and `--interactive` for both entries. Scratch `--option` merges into the same answer source (§21.10.1).

#### 8.10.4 Required behaviors

`InteractionServiceLive` requirements:

- Construct lazily through `Layer.suspend`.
- Touch no input for commands that never prompt.
- Require no network, provider, or plugin at bootstrap `minimal`.
- Never echo secrets or place them in transcripts, logs, or errors.
- Fail fast for missing non-interactive answers.
- Route prompt chrome through `Renderer` when present and use only the declared no-renderer fallback carve-out.

Interruption returns `InteractionCancelledError` after restoring terminal state. Dynamic choices use the allowed canonical runner; failures return `ChoicesUnavailableError` with interactive fallback. Mid-build prompting and an `Interaction` lifecycle scope are v4.0 non-goals.

Tagged errors are `InteractionRequiredError` (`RecipeMissingAnswerError` alias), `PromptValidationError` (`RecipePromptValidationError` alias), `InteractionCancelledError`, `ChoicesUnavailableError` (`RecipeChoicesError` alias), and `InteractionUnavailableError`.

| Interaction `_tag` | Contract |
|---|---|
| `InteractionRequiredError` | No explicit/default answer; includes prompt and remediation |
| `PromptValidationError` | Value violates `PromptValidate`; includes name, type, issue, remediation |
| `InteractionCancelledError` | Ctrl+C or EOF after terminal restoration |
| `ChoicesUnavailableError` | `choicesFrom` failed or returned no choices |
| `InteractionUnavailableError` | Active implementation cannot satisfy request |

#### 8.10.5 Replaceability

Plugin `interactionServices:` MAY provide headless/CI, recording/test, or GUI/host transports. `TestInteractionService` ships from `@lando/core/testing` (§16.8). Every implementation MUST pass the §13.1 interaction suite and MUST preserve secret redaction, answer precedence, and non-interactive fail-fast behavior.

### 8.11 Machine-readable output contract

Every command is agent-consumable without prose parsing. `--renderer` selects process presentation; per-command `--format` selects result encoding. Universal `--format json` emits the canonical machine contract. `-j` is boolean `--format=json`. Optional-valued `--json` and `--jq` follow §8.11.5. `--renderer json` defaults format to JSON, but explicit `--format` wins.

#### 8.11.1 The result envelope

Published schemas are `CommandResultFormat` (`text|json|table|yaml|ndjson`), `CommandWarning`, and `CommandResultEnvelope`.

| Envelope field | Contract |
|---|---|
| `apiVersion` | Literal `v4`; changes only for a breaking envelope revision |
| `command` | Canonical command id |
| `ok` | Success discriminator |
| `result` | Optional command `resultSchema` value |
| `error` | Optional `TaggedErrorJson` |
| `warnings` | `CommandWarning[]` |
| `deprecations` | `DeprecationUse[]` |

Payloadless commands return an empty result object.

`CommandWarning` carries `code`, `message`, and optional `remediation`. Only a breaking envelope change may change `apiVersion`.

#### 8.11.2 The single serialization seam

`encodeCommandResult` is the only JSON result serializer. It schema-encodes success or tagged failure, preserves exit status, wraps the envelope, and passes it through `RedactionService` before output. Per-command render helpers produce only human formats. §13.4 MUST reject any other command-result `JSON.stringify` path.

#### 8.11.3 Streaming commands

Streaming specs emit newline-delimited `StreamFrame` values tagged `stdout`, `stderr`, `event`, or terminal `result`. Data frames carry chunks and optional service/source; event frames carry redacted bounded-history events; result frames carry `CommandResultEnvelope`. This is not a second event tap.

`CommandResultEnvelope`, `CommandWarning`, `CommandResultFormat`, and `StreamFrame` are published from `@lando/sdk`, re-exported by `@lando/core/schema`, and snapshot-governed by §13.2.

#### 8.11.4 Required behaviors

Every non-interactive canonical command MUST accept `--format json` and `-j`; interactive commands are exempt only while interactive. Every envelope and per-command result schema belongs in the §13.2 snapshot. Source and compiled entries MUST emit identical schema-valid output. The §13.1 conformance gate exercises every canonical id for success and failure against `TestRuntime`.

#### 8.11.5 `--json` field lists and `--jq`

`--json` rules:

- Bare `--json` after command resolution lists selectable top-level result keys as a JSON array and does not run the command.
- Valued `--json` projects comma-separated keys and dot paths into `envelope.result`.
- Failure envelopes are never projected.
- Space form consumes a value only when it contains comma or dot.
- Equals form always supplies a field list.
- `-j` never consumes the next token.

`--jq <expr>` implies JSON, evaluates an embedded jq 1.8-compatible subset against the redacted envelope, replaces stdout, preserves exit status, and renders scalars raw. It is bounded, has no environment or module loading, and never spawns system jq. For streaming commands it transforms only the terminal result frame. MCP and library APIs always return the full redacted envelope and do not accept projection or jq.

The ordered path is schema encode → optional projection → envelope → redaction → optional jq → stdout.

- Help/no-command JSON remains catalog output.
- Domain `--path` flags are unrelated.
- Bare list mode with `--jq` is an error.
- Non-JSON format with projection or jq is an error.
- On command failure, jq still evaluates the failure envelope.
- `encodeCommandResult` remains the only serializer.

---
