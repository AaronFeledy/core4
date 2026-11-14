# Lando v4: CLI, Tasks, and Tooling

> **Part 8 of 20** · [Index](./README.md)
> **Read next:** [09 Embedding and Library Use](./09-embedding.md)

This part defines the CLI, tooling, recipe, renderer, interaction, and machine-output contracts. One native command registry and dispatcher own source and compiled operation; command execution crosses into Effect at `run()` and does not return to an imperative command body.

---

## 8. CLI, Tasks, and Tooling

### 8.1 Command kinds

Every command has exactly one kind and one namespace.

| Kind | Source | Registry representation |
|---|---|---|
| Built-in | Core | Static `LandoCommandSpec` entry adapting Effect command logic |
| Plugin | Plugin manifest command descriptors (§9.4) | Descriptor-owned identity and aliases plus a lazily loaded `ExecutableCommandSpec`, validated at load (§8.3, §9.7) |
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

Aliases MUST NOT collide with another top-level alias, a top-level topic, or `help`, `--help`, or `--version`. The built-in aliases `recipes` and `scratch` are the only exceptions: they are also core help topics, so `lando help <t>` and `lando <t> --help` render the topic while bare `lando <t>` runs the alias. Built-in conflicts produce `CommandAliasConflictError` at registration; tooling conflicts fail unless global config explicitly disables the existing alias. Reserved tooling names follow the next paragraph instead.

Plugin command descriptors (§9.4) MAY declare colon-form `aliases` and a `topLevelAlias` with the grammar above. Every canonical id is reserved before any alias is assigned. A plugin alias that claims a built-in id or alias, a core help topic, a reserved token, or a task in the current app's tooling is dropped in that context, its command stays available by canonical id, and the conflict is reported as a `CommandAliasConflictError` diagnostic naming the winner and the losing plugin. Between plugins, the first owner in discovery precedence keeps the token and the later claim becomes a diagnostic. Installing a plugin MUST NOT make an otherwise valid app's `app:cache:refresh` fail, and an app command index that is still not fresh after any §8.7 rebuild still refuses tooling-shaped tokens rather than dispatching a plugin alias in their place. A deprecated plugin alias emits its `DeprecationNotice` when used.

`global:` is reserved for `meta:global:*` (§20.7.1). Tooling task names `run`, `scratch`, and `scratch:*` are reserved outright for built-in scratch commands (§21.10.2); lint and planning reject them as `landofile.tooling`. App-context `commandAliases.custom:` remaps apply to plugin claims only, not reserved tooling names.

Global and Landofile `commandAliases:` expose `enabled`, `disabled`, and `custom`; Landofile values win in app context. `enabled: false` removes all aliases in scope. `disabled` removes named aliases. `custom` binds an alias to an existing canonical id after ordinary alias registration. Unknown targets fail with `CommandAliasTargetError`. Overrides never replace the canonical id itself and MAY target built-ins, plugin commands, or same-Landofile tooling tasks.

### 8.2 Built-in commands

The registry is authoritative for ids, aliases, bootstrap levels, flags, and result schemas.

| Canonical id | Default alias | Bootstrap | Contract |
|---|---|---|---|
| `app:cache:refresh` | none | `app` | Rebuild app plan, tooling graph, and `<userCacheRoot>/apps/<app-id>/commands.bin` without starting services; JSON `result.services` reports each planned artifact identity; dispatch and help rebuild the caches automatically (§8.7) |
| `app:check` | `check` | `app` | Run the app's checks without restarting (§8.2.7); repeatable `--only <id>`, `--format json` |
| `app:config` | none | `plugins` | Read or write the current Landofile (§8.2.1) |
| `app:config:explain` | none | `plugins` | Report recipe provenance; `--format json` |
| `app:config:migrate` | none | `plugins` | Commit recipe migrations; `--yes`, `--dry-run`, `--format json` |
| `app:config:translate` | none | `plugins` | Convert with `--from`, `--to`, `--file`, `--write`; or materialize declared entries with `--refresh [<id>]`, optionally `--check` for local read-only drift (§7.4.2). Never plans or contacts a runtime provider. |
| `app:destroy` | `destroy` | `app` | Destroy resources; confirmation unless `--yes`; `--provider=<id>` targets only that provider's applied state and owned resources; `--volumes` adds data volumes, `--purge` adds data volumes and this root's snapshots (§10.11.2), `--purge-caches` adds cache volumes |
| `app:exec` | `exec` | `app` | Execute in a service; `--service` / `-s` overrides positional service selection |
| `app:includes:update` | none | `minimal` | Refresh selected or all `.lando.lock.yml` entries; `--no-network`, `--check` |
| `app:includes:verify` | none | `minimal` | Verify cached includes; `--format json\|table` |
| `app:info` | `info` | `app` | Runtime info; repeatable `--service/-s`; `--format json\|table\|yaml`; result `app` is the current Landofile name when loading succeeds, otherwise the recorded applied name; optional `dataName` is present when the observed plan's recorded data name differs from `app`. Service observations retain applied runtime identity (§6.10, §7.4). |
| `app:logs` | `logs` | `app` | Stream logs; `--service`, `--follow`, `--tail`, `--since`, `--no-viewer`; `--build` prints the saved output of the most recent build instead (§6.13.6) |
| `app:open` | `open` | `app` | Open or print URLs; `--service`, `--route`, `--all`, `--print` |
| `app:pull` | `pull` | `app` | Pull remote datasets and optionally code (§10.12); `[<remote>@<env>]`, `--remote`, `--branch`, `--only`, `--fresh`, `--code`, `--no-snapshot`, `--allow-exposure`, `--force`, `--yes`, `--no-interactive`, `--format json` |
| `app:push` | `push` | `app` | Push local datasets (§10.12); explicit `<remote>@<env>` and target bindings; `--remote`, `--branch`, `--only`, `--allow-exposure`, `--force`, `--yes`, `--no-interactive`, `--format json`. No code, fresh, or snapshot flags. |
| `app:rebuild` | `rebuild` | `app` | Rebuild selected prerequisite closure; repeatable `--service/-s` |
| `app:remote:add` | none | `app` | Add a `remotes.<name>` entry; `[<name>] [<source>]`, repeated `--set key=value` |
| `app:remote:env:list` | none | `app` | List environments of a remote; `--remote`, `--format json` |
| `app:remote:list` | none | `app` | List configured remotes with redacted config; `--remote`, `--format json` |
| `app:remote:remove` | none | `app` | Remove a `remotes.<name>` entry; declares `--yes` (§8.3.1) |
| `app:remote:setup` | none | `app` | Credential/SSH setup (§10.12.3); `--remote`, `--force`, `--no-interactive` (existing references only), `--format json` |
| `app:remote:switch` | `switch` | `app` | Check out exact code ref of `<remote>@<env>`, reload/replan, then pull (§10.12.1); `--branch`, `--no-pull`, `--only`, `--fresh`, `--no-snapshot`, `--allow-exposure`, `--force`, `--yes`, `--no-interactive`, `--format json` |
| `app:remote:tether` | none | `app` | Foreground session against explicit `<remote>@<env>` and repeatable `--unit` (§10.12.5); interactive CLI only, initially stopped app, revocable forwarding. Declares CLI-owned `--yes`/`-y` (§8.3.1) but MUST reject a true value; no protection bypass or programmatic dispatch. |
| `app:remote:test` | none | `app` | Verify remote reachability and credentials; `[<remote>@<env>]`, `--remote`, `--format json` |
| `app:restart` | `restart` | `app` | Stop then start inside restart events |
| `app:shell` | `shell` | `app` | Interactive host or service shell; `--service`, `--no-history` |
| `app:share` | `share` | `app` | Start tunnel; `--target`, `--provider`, `--detach`, `--format json` |
| `app:share:list` | none | `app` | List tunnel sessions |
| `app:share:stop` | none | `app` | Stop a detached tunnel session |
| `app:ssh` | `ssh` | `app` | Login shell (`bash -l` when present, otherwise `sh -l`) or supplied command in a service; `--service`, `--user`, `--no-history`; stdin and PTY follow the command-wide host-stdin rule |
| `app:start` | `start` | `app` | Start current app; finishes an unfinished accelerated attempt first (§10.6.3) |
| `app:stop` | `stop` | `app` | Stop current app |
| `apps:init` | `init` | `plugins` | Scaffold an app (§8.8) |
| `apps:gc` | — | `provider` | Reports user apps whose recorded root no longer exists (applied plans, containers, volumes, unfinished accelerated-start journals) and exits 0; reporting never launches a runtime, so a provider that is not running lists recorded state only. Text names an unobserved provider when it holds recorded plans, ownership, or journals, or when reading its recorded state failed; JSON retains every scan. `--prune` asks one confirmation listing every candidate root and what it deletes, then tears each down through the missing-root destroy path (§5.3.1), sequentially, revalidating each root and acting only on confirmed roots. `--volumes`, `--purge`, `--purge-caches`, and `--provider` mean what they mean for `destroy`. A journal's provider declaring `fileSyncTargets: "prepared-volume"` cannot yet remove its missing-root file-sync copies: confirmation and report mark them kept with that reason, and requested volume deletion fails preflight with `FileSyncStopError`, no deletion for that root, and remediation to rerun without `--volumes`. Pruning prepares owning providers the way `destroy` does, and does so before it builds the confirmation: every owner of a candidate whose runtime was not observed is launched first, so the confirmation lists the holdings teardown removes. Each root's owners are prepared again before its revalidation, so holdings that appear only after confirmation retain that root instead of being removed. A root that fails, or a journal document that cannot be read, does not stop the others; the result lists per-root outcomes, keeping data that the selected flags retain as success, and the command exits non-zero only when requested cleanup failed or was withheld. |
| `apps:list` | `list` | `minimal` | List apps; `--all`, filters, `--path`, JSON, table. Status is `active`, `stopped` (its provider answered or proved it runs nothing, as an `idle` managed runtime does), or `unknown`. `--prune` removes recorded state only after a successful resource listing proves the app's resources absent, never from `idle` evidence. |
| `apps:poweroff` | `poweroff` | `provider` | Stop managed services; `--keep-global`, `--keep-scratch` |
| `apps:scratch:destroy` | `scratch:destroy` | `scratch` | Destroy by `<id>`; `--keep-volumes` |
| `apps:scratch:gc` | `scratch:gc` | `scratch` | Report or reap orphans; `--prune` |
| `apps:scratch:info` | `scratch:info` | `scratch` | Scratch info; `<id>`, `--service`, `--format` |
| `apps:scratch:list` | `scratch:list` | `scratch` | List registry and provider-label orphans; `--format table\|json` |
| `apps:scratch:logs` | `scratch:logs` | `scratch` | Scratch logs; `<id>`, `--service`, `--follow`, `--tail`, `--since` |
| `apps:scratch:run` | `scratch:run`, `run` | `scratch` | Scope-bound toolbox execution; `--keep` detaches |
| `apps:scratch:start` | `scratch:start`, `scratch` | `scratch` | `--fork` or `--from`; isolation, cwd mount, global-storage, detach controls |
| `apps:scratch:stop` | `scratch:stop` | `scratch` | Stop selected or foreground scratch and destroy it |
| `meta:bun` | `bun` | `minimal` | Transparent embedded Bun argv proxy (§8.2.4) |
| `meta:config` | `config` | `none` | Read, validate, or repair `<userConfRoot>/config.yml` |
| `meta:doctor` | `doctor` | `none` | Self-resilient diagnostics (§10.9.1) |
| `meta:snapshots:gc` | `snapshots:gc` | `provider` | Reports orphaned native snapshot images; `--prune` rechecks catalog references and eligibility before no-start removal. Stopped providers are reported unavailable during discovery; a runtime stopping after recheck causes failed removal, never startup or repair (§10.11.2). |
| `meta:sources:gc` | `sources:gc` | `minimal` | Reports source-store entries unused longer than `--older-than=<days>` (default 30); `--prune` removes them. Entries pinned by any registered `.lando.lock.yml` or leased by a live process are never removed, and an unreadable lockfile withholds git and npm-indexed pruning for the run. Never automatic (§12.8.5). |
| `meta:events:follow` | `events` | `minimal` | Trace events; `--follow`, `--format`, `--event`, `--scope`, `--since` |
| `meta:global:config` | `global:config` | `plugins` | Read or write the global app Landofile without an eager provider runtime |
| `meta:global:destroy` | `global:destroy` | `global` | Destroy global resources; `--provider=<id>` restricts applied evidence and cleanup to that provider; `--purge` includes service/app data volumes |
| `meta:global:disable` | `global:disable` | `global` | Save disabled policy for selectors or `--all`; protect running/unknown consumers unless invocation-scoped `--allow-disruption`; ownership-verified selected cleanup and generation; named volumes retained; `--dry-run` previews without writes |
| `meta:global:enable` | `global:enable` | `global` | Enable contribution/package selectors or `--all`; regenerate without starting; `--dry-run` previews without writes |
| `meta:global:info` | `global:info` | `global` | Global info; `--service`, `--format` |
| `meta:global:list` | `global:list` | `plugins` | List current contribution eligibility, policy source, capability evidence, and retained policies without provider runtime construction |
| `meta:global:logs` | `global:logs` | `global` | Stream global logs |
| `meta:global:rebuild` | `global:rebuild` | `global` | Regenerate, destroy, build, apply, then revalidate the router (§20.6.5) |
| `meta:global:reconcile` | `global:reconcile` | `global` | Preserve policy, repeat consumer protection, retry pending cleanup, and generate eligible config without starting; invocation-scoped `--allow-disruption`; `--dry-run` previews without writes |
| `meta:global:restart` | `global:restart` | `global` | Global stop, then start, then router startup revalidation (§20.6.5) |
| `meta:global:start` | `global:start` | `global` | Start all or repeated `--service` subset |
| `meta:global:status` | `global:status` | `global` | Report desired policy, observed state, and pending work without requiring a valid desired Landofile |
| `meta:global:stop` | `global:stop` | `global` | Stop global services |
| `meta:mcp` | `mcp` | `plugins` | MCP over stdio; `--allow`, `--deny`, `--tooling`, `--list` |
| `meta:plugin:add` | `plugin:add` | `plugins` | Install plugin |
| `meta:plugin:build` | none | `minimal` | Build (including declarations) through the private Bun self-execution wrapper |
| `meta:plugin:link` | none | `plugins` | Link current plugin |
| `meta:plugin:new` | none | `minimal` | Scaffold a plugin from a built-in template |
| `meta:plugin:publish` | none | `minimal` | Publish; reads registry credentials from the user's npm config |
| `meta:plugin:remove` | `plugin:remove` | `plugins` | Remove plugin |
| `meta:plugin:test` | none | `minimal` | Run plugin tests |
| `meta:plugin:unlink` | none | `plugins` | Remove link and optionally restore registry copy |
| `meta:recipes:describe` | none | `minimal` | Print recipe prompts and metadata |
| `meta:recipes:list` | `recipes` | `none` | List compile-time bundled recipes |
| `meta:recipes:validate` | none | `minimal` | Validate `recipe.yml` |
| `meta:setup` | `setup` | `provider` | Configure provider, CA, router, shell integration |
| `meta:shellenv` | `shellenv` | `none` | Print embedded shell snippets |
| `meta:uninstall` | `uninstall` | `none` | Remove recorded Lando-owned files through a command-owned maintenance runtime that does not require valid global configuration; `--yes`, `--dry-run` |
| `meta:update` | `update` | `plugins` | Update core and plugins |
| `meta:version` | `version` | `none` | Print embedded version |
| `meta:x` | `x` | `minimal` | One-shot package execution (`bun x`) through the private Bun self-execution wrapper (§8.2.4) |

Command-wide rules:

- Tooling narration and scratch acquisition progress MUST use stderr, including the live tree when stderr is a terminal and stdout is redirected to a file (a pipe keeps line mode, §8.9.2). stdout MUST remain the payload channel. Narration terminal selection MUST NOT change the stdin/stdout PTY and keyboard-attachment rules below.

- `app:cache:refresh` performs full app bootstrap and refreshes the plan, tooling graph, and app command index. It MUST NOT contact the provider unless materialization requires a missing managed dependency. Ordinary use never needs it, because dispatch and help rebuild the same caches automatically (§8.7); it exists to warm caches ahead of time, for example in CI, and to report refresh warnings. Its JSON result lists every planned service under `result.services` with `service`, `type`, and the artifact identity `app:info` reports (`kind: ref` with `ref` and optional `digest`, or `kind: build` with optional `contentHash`). Build context, arguments, inline source, and provenance are omitted. The text summary stays the refresh line.
- `app:info` and `app:rebuild` deduplicate services on first occurrence and validate all names before provider action. `app:info` selects no dependencies. `app:rebuild` first adds the generated companions of each named parent (§6.11.5), then selects transitive prerequisites in stable plan order, and MUST leave unrelated services and dependents untouched.
- `app:includes:verify` MUST work offline from warm source-store entries (`<userCacheRoot>/sources/`, §12.8) and MUST NOT resolve floating refs or update the lockfile. Missing pins, selector mismatches, content mismatches, and stale entries report `LandofileLockMismatchError` entries with update remediation. Its `ok: false` report retains load failures in `failures` alongside `mismatches`, preserving each tag, attribution, and remediation. Incomplete traversal MUST NOT classify unreachable descendants as stale. `app:includes:update` collects independent load failures and MUST NOT publish on failure (§7.7.2).
- `app:restart` MUST preserve inner events and publish `pre-restart` and `post-restart` (§3.5, §11.4).
- `app:exec` and `app:ssh` forward §6.9.1 agent context. `app:ssh --no-history` applies the same session no-history overlay as `app:shell --service --no-history` (§8.2.3). `app:open` is `hostProxyAllowed: true`. `meta:mcp`, `meta:bun`, and `meta:x` are not host-proxy or recipe-post-init allowed.
- For CLI `app:exec`, `app:ssh`, `apps:scratch:run`, `providerExec` tooling, and `.bun.sh` script tasks, piped or redirected stdin MUST be forwarded unchanged and without a PTY, and EOF MUST close the command's stdin in every format. A PTY requires terminal stdin; `app:exec`, `apps:scratch:run`, and tooling also require terminal stdout, while `app:ssh` keeps its PTY when only stdout is redirected. JSON and YAML disable PTYs and keyboard attachment; `apps:scratch:run` and tooling also disable them under the `json` renderer. Otherwise keyboard input attaches for `app:exec --interactive`, `app:ssh` with terminal stdin, and `apps:scratch:run` and tooling with terminal stdin and stdout. Host `.bun.sh` scripts inherit Lando's stdin descriptor for piped and keyboard input, but stdout and stderr MUST still pass through the sink; keyboard mode MUST NOT bypass redaction by inheriting output descriptors. The CLI retires event rendering before keyboard-attached tooling or scripts, and retires scratch acquisition progress before exec (§8.9.2). Human host and container payloads MUST stream incrementally through one sink with byte-exact, value-only redaction (§3.7), including final partial lines, identically for terminal and redirected destinations. Tool body bytes MUST NOT become per-line `task.detail` events. Tool stdout alone goes to stdout; task trees and acquisition narration go to stderr (§8.9.1). Machine formats follow §8.11. Interruption MUST stop the tool or script; signal-owned CLI cancellation follows §8.4.1 (SIGINT 130, SIGTERM 143). Event, MCP, and library invocations MUST NOT consume process stdin.
- `meta:events:follow` reads the `EventService` trace sink used by diagnostics and e2e tests; it does not subscribe to plugin events itself.
- `meta:uninstall` MUST remove only recorded entries it owns. Unrecorded root contents, Lando 3 state, foreign installs, and provider resources MUST remain untouched. Stopping the managed runtime service before its recorded runtime directory is removed follows §5.8.1.
- Host-global artifacts follow their owner stamp, not their marker alone, and the plugin that installs them plans and executes their removal through its host-maintenance contribution (§4). The router socket helper (§10.2.3) is `owned` when its unit files are stamped with the current data root; `--keep-data` preserves it because it serves the apps keep-data leaves running. Its privileged removal rechecks every unit and the polkit rule, stops only owned units, and fails the step if ownership changed since the plan; without a privilege capability the step is `manual`. A helper owned by another existing data root, or unmarked files, are `user-owned` and left in place; the detail names the owner root. A helper with a missing owner root, no stamp, mixed stamps, or unreadable units is `manual`, with the exact stop, remove, and reload commands. Contributed steps run before the data root is deleted; when an owned contributed step fails or loses ownership, the data root is kept for the resumable report.
- `--purge` strips only shell-profile `LANDO4 shellenv` blocks whose `LANDO_USER_DATA_ROOT` names the current data root. A block for another data root is `user-owned` and kept; a block without a recognizable data root is `manual`.
- `--clear` is universal and purges relevant caches.
- `app:start` and `app:rebuild` materialize declared dependencies. Repeating a successful start with default acquisition policy MUST NOT require network unless a source is absent, the lock changed, or app commands require it. Explicit pull and build policies retain their connectivity requirements (§6.13.3). Rebuild refresh and local fallback follow that same policy; `always` has no local fallback and `never` permits no service-image pull. Under default policy, `app:rebuild` falls back with a warning and acquisition needs network only for referenced artifacts with no local copy.
- `apps:poweroff` includes user, global, and scratch apps by default. `--keep-global` and `--keep-scratch` compose and MUST be reported.
- `meta:global:start` refuses an empty global app. `meta:global:list --format json` is canonical for automation.
- Scratch behavior is owned by §21. `ScratchSourceUnresolvedError` rejects both or neither of `--fork` and `--from`. Scratch JSON list output is canonical for automation.
- Commands tolerate apps with no services when semantics allow it.

Root TTY help contains **COMMON**, optional **THIS APP**, and **MORE**. Full catalog surfaces are `lando help --all` and `lando help --format json`; topic pages are `lando help <topic>` and `lando <topic> --help` (§8.4.2).

#### 8.2.1 The `app config` command

`app:config` owns `get`, `set`, `unset`, `edit`, `validate`, `view`, and `describe`; conversion and provenance use `app:config:translate`, `app:config:explain`, and `app:config:migrate`.

The `app:config` and `meta:global:config` CLI umbrellas and their verb commands declare bootstrap `plugins`; the read-only `app:config:get` and `app:config:view` MCP projections declare `app`. The exception is `describe`: `app:config:describe` (also an MCP tool) and `meta:global:config:describe` declare bootstrap `none`, are exempt from `notify.commands` promotion, and read only the `LandofileShape` schema, never an app, a Landofile, or the global app; `app config describe`, `app:config describe`, and the `global config`/`global:config`/`meta global config`/`meta:global:config` spellings normalize to those ids before bootstrap. Candidate safety is a property of the loader, not of the bootstrap level: runtime construction, command-registry construction, and subscriber registration (§11.3.1) never load the current Landofile, publish include pins, or recover a transaction, so these commands promote under `notify.commands` like any other lower-tier command (§8.9.7). Read and validate operations still perform their explicit ordinary Landofile loads with ordinary pinning and recovery; `set`, `unset`, and `edit` reach the Landofile only through candidate validation below.

Installation config (§8.2.2), the app Landofile, and the global Landofile (§20.7) share one private mutation workflow for `set`, `unset`, and `edit`: read the persisted text, prepare the candidate, decode it, compare against the baseline, decide admission, and persist. Each document keeps its own schema, layered repair rules, template and TypeScript restrictions, and exact editor buffer; the shared workflow owns admission and no-op reporting, not document semantics. A mutation that leaves the authored tree equal (a `set` to the present value, an `unset` of an absent key, or an editor buffer byte-identical to the persisted original) still validates the touched key and the applicable effective configuration, but MUST NOT invoke persistence, MUST preserve the original bytes, and reports `changed: false`. Edited text is compared with the persisted original, never with a seeded editor buffer: a nonempty buffer saved over an absent file is a real create. Dry-run reports the same `changed` verdict it would persist. `view`, `get`, and `validate` remain distinct read projections and are not routed through this workflow.

| Surface | Contract |
|---|---|
| default / `view` | Read `raw`, `merged`, or default `resolved`; supports `--path` and structured formats |
| `get` | Read one key path |
| `set` | Infer the value type by full-tree schema decoding, trying raw text first, then a non-string number, boolean, null, or JSON interpretation; `--type string\|number\|boolean\|json\|yaml` overrides inference |
| `unset` | Remove a key |
| `edit` | Open `$VISUAL`/`$EDITOR` for the canonical YAML source; `--dry-run` validates the returned buffer without writing |
| `validate` | Validate merged Landofile (§7.8) |
| `describe` | Describe one key, or the root when omitted, from the document's published JSON Schema: `{ subcommand: "describe", key, summary, description?, default?, keys?, schema }`, where `schema` is the self-contained projected JSON Schema for the key and `keys` lists a fixed mapping's children; the description comes solely from the schema, with no document load, app resolution, eligibility check, or provider operation, so it works outside an app and on an invalid file (normal CLI presentation may still read global config sources); an unknown key fails with `ConfigKeyNotFoundError` carrying `validKeys` and the closest-key `suggestion` |
| `translate` | `--from`, `--to` default `lando4`, `--file`, `--detect`, `--list`, `--write` |
| `explain` | Read-only recipe provenance; `--format json` |
| `migrate` | Ordered migration proposals; `--yes`, `--dry-run`, `--format json` |

Inspection exposes three stages without a second loader. Raw returns `{ source: "raw", layers: [{ layer, file, form, document }] }` in low-to-high order immediately after acquisition/render/parse or sandboxed TypeScript evaluation. It MUST NOT expand includes, evaluate load helpers, materialize expressions, or validate the effective schema. Merged returns `{ source: "merged", landofile }` after authored composition, including fragments, before recipe/env materialization, defaults, tooling assembly, or the final runtime decode. Resolved remains the default strict canonical `LandofileShape` with existing metadata. Final-schema-invalid documents remain inspectable through raw and merged; acquisition/composition failures still fail their respective stage. Source data uses recursive finite JSON values and the shared directive transport, including literal-envelope collision escaping.

`--path` selects inside the exposed document, never inside the result envelope. Raw selects independently inside each encoded layer document and retains every identity and position; projected raw adds `path` and omits a missing `document`. Raw get returns `{ source: "raw", subcommand: "get", key, value? }`, where `value` is the layer projection array when any layer matches, with missing documents omitted; otherwise `value` is absent. Merged/resolved projections return `{ source, path, value? }`; get returns `{ source, subcommand: "get", key, value? }`. Get uses `key ?? path` and retains the tagged missing-selector failure. Dot/bracket syntax is shared with writes; missing members, malformed selectors, scalar traversal, and out-of-range indexes are missing, not null. Scalars, null, and arrays retain their types. Missing human text is empty; objects/arrays render compact JSON, other values use `String(value)`. Only a full resolved view emits bare canonical YAML. All other YAML output uses the normal success envelope. Result schemas MUST distinguish full views, projections, get, and actual write subcommands without a permissive fallback.

Read-only MCP view/get projections expose and forward `source` and `path`, with optional get `key`, while forcing their read-only subcommand. `lando://app/config` remains resolved. Every view collects literal redaction tokens across all retained sources, including shadowed layers, directive payloads, and authored `KEY=value` arrays, before projection. Inspection MUST NOT resolve secret references or env files just to redact.

Ordinary writes target the canonical YAML Landofile. A private source-replacement operation substitutes candidate bytes before parsing the old target, inserting an absent canonical source between upstream and local. It validates the original candidate as an expression-aware recursively partial native authoring fragment, discards the validation product, then runs the normal effective pipeline with one finalization. Set/unset compare candidate issues with the baseline decode by path plus message. Writes are rejected with `LandofileWriteValidationError` only when they introduce a problem or leave the written key or a descendant invalid; problems already present elsewhere don't block and are reported once as text and envelope warnings with code `LANDO_CONFIG_PREEXISTING_ISSUES`, naming each issue and its fix. Inferred sets choose the first acceptable interpretation. When every interpretation is rejected, an interpretation with a `kind: "type"` blocking issue at exactly the written key is dropped if another interpretation passed that kind check; the remaining interpretations' issues are reported once, and only when their issue sets still differ are issues labelled `as <interpretation>:` and the remediation pointed at `--type`. When the document schema describes the written key, the remediation leads with what the key takes (`` `router.httpPort` takes an integer from 1 to 65535. ``); a key the schema does not describe keeps the decoder's issues and the default remediation. Lint owns masked invalid untouched fragments. Set/unset persist the authored next tree, not decoded ASTs or defaults. Edit still requires the whole edited configuration to validate and persists the exact validated buffer, including template directives; set/unset reject templates and canonical TypeScript writes remain unsupported. Dry-run applies the same validation rule without writing. Unchanged unset validates but creates no absent target. Candidate parse/schema failures and blocking effective schema issues return `LandofileWriteValidationError` retaining source attribution; other loader tags remain intact. Persistence is atomic under §12.3. Translation and migration use §12.4 transactions. Key paths are dot-separated with bracket array indexes. Expressions and `${secret:...}` references are written literally.

The no-write rule covers Lando-owned candidate validation for real writes as well as dry-run, including every inferred interpretation and baseline comparison: validation MUST NOT persist authored Landofiles, publish include lock entries (§7.7.4), recover or clean managed-file transactions, mutate their journals, stages, backups, or ownership records, or acquire transaction or include-lock write locks for recovery or publication. Before opening an editor, and again before acquiring candidate sources, it MUST ask the transaction guard whether the app root is readable, using the read-only readiness entry point rather than the recovering one (§12.4.1); which journal states permit a read is managed-file policy, not Landofile policy. A `prepared`, `committing`, or `blocked` journal MUST cause a typed fatal `ManagedFileTransactionError` with human-readable text and recovery or manual-resolution remediation, not a candidate schema finding; validation MUST NOT proceed over that incomplete or blocked file set, and a malformed original MUST NOT be parsed before that check. A `committed` journal MAY remain unchanged while validation reads the complete file set, but validation MUST NOT clean it or its stages. Fatal acquisition and readiness failures are never downgraded into repairable findings. Baseline comparison retains each issue's source identity where present, and failed inferred interpretations or baseline decodes MUST NOT emit warnings about an outcome that was not selected. Ordinary loading and start retain §12.4.1 recovery behavior. Validation MAY use the network and acquire required include content under the configured user cache (§7.7.5), using ordinary cache-acquisition locks, and MAY evaluate source and template code under their existing authorization and evaluation rules. These restrictions govern Lando-owned configuration persistence and transaction handling, not universal filesystem purity or a new sandbox guarantee for author code. Rejected candidates, dry-run, and unchanged unset perform no such persistence or transaction mutation; an accepted real edit atomically writes the canonical source alone, without publishing include pins or recovering transactions.

Lint validates retained root/include fragments in their authoring role and attempts normal effective finalization. Findings carry optional `scopes: ("fragment" | "effective")[]`, ordered fragment then effective without duplicates, and `{ file, layer, path }` source attribution, preserving effective versus authored paths. Coordinates MUST come from retained content. Machine output has one record per defect: findings identical in every field except `scopes` merge by unioning their scopes. Findings differing in source file, layer, authored path, coordinates, effective path, message, suggestion, rule, reason, or severity MUST remain separate; path/message alone MUST NOT determine identity. Text output prints each record's source file, coordinates, layer, scopes, and differing authored path. Lint and planning share one diagnostic set for resolved fields, event names, and reserved tooling names; planning fails once with `LandofileValidationError` listing all issues with their `rule` (§7.8). Three checks are lint-only. `landofile.host-shell` (§3.4): planning fails only for host steps of app lifecycle and remote-hook events and for host readiness, while lint also reports host tooling commands, host dynamic-var commands, and tooling-bracket events. The `landofile.tooling` dynamic-var reference rule (§8.5.3): lint reports it, planning does not fail on it, and invocation refuses the affected task. `landofile.tooling` normalization findings (§8.5): lint runs the shared task normalizer over every enabled task of the finalized Landofile, internal tasks included and disabled tasks excluded, and reports every failure in one pass at its authored key with source attribution and coordinates (§7.8); planning does not fail on them, the affected task becomes an unavailable command (§8.7), and its invocation fails with `ToolingCompileError`. Lint and invocation MUST derive these findings from the same normalizer, never a parallel rule list. The private lint snapshot retains the exact successfully load-finalized Landofile and its canonical path, even alongside independent fragment findings; the planner's resolve pass and event validation reuse retained root and include content without reacquiring or rerendering those sources (§7.8), while service resolution may read env files and authorized project inputs.
`set` and `unset` MUST preserve comments and formatting outside the changed value or removed entry through source-offset splices. Every proposed serialization, including dry-run and canonical fallback, MUST parse with the document's own parser and equal the intended authored tree, including merge-directive symbols; decoded defaults MUST NOT be serialized. Unsupported edits MUST fail closed with `LandofileWriteValidationError`, the reason, and a pointer to `lando app:config edit` (or `lando global:config edit` for the global app) or hand editing. Full re-emission is permitted only for a blank file or an original already byte-identical to canonical emission. A failed full-tree decode MUST label issues also present in the original snapshot as already present before the change and direct the user to fix those first; candidate acceptance still requires a successful full decode.

Conversion is preview-only without `--write`, MUST be explicit or unambiguous, and MUST NOT build an `AppPlan` or contact a runtime provider. Declared refresh is the separate §7.4.2 mode: `--refresh [<id>]` materializes and MAY fetch nonsecret remote metadata; `--refresh [<id>] --check` MUST use local state only and MUST NOT write. Conversion selectors and `--write` MUST NOT combine with refresh mode. Translators MAY also load in the bounded lifecycle refresh phase, never discovery or ordinary loading.

Only encoders with registered safe target mappings MAY write. `--file` MUST remain within that layer's authorized dependency closure. Preview and write MUST produce identical ordered, redacted diagnostics: `generated`, `dropped`, `rewritten`, `unsupported`, `non-portable`, and `needs-review`. `unsupported` diagnostics MUST block writing; §7.4.1 defines when a loss is `dropped` rather than `unsupported`. A blocked write's tagged `ConfigTranslateError` carries the same ordered, redacted diagnostic array the preview reports. Human translation output MUST summarize diagnostic counts before grouping and present kinds in the order `unsupported`, `non-portable`, `needs-review`, `dropped`, `rewritten`, `generated`, with remediation for blocking, review, and dropped items; siblings MAY share one line only when kind, source, parent path, message, and remediation match, and grouping MUST NOT alter structured diagnostics. A successful human write reports written, removed, and backup counts, backup paths, review and drop counts, and the `lando app:config:lint` follow-up; diagnostic comments never enter saved files.

All remote commands MUST enforce central effective protection (§10.12.8), independent of dispatcher. Push/destructive actions MUST name every target; protected typed confirmation MUST NOT be satisfied by `--yes`, MCP elicitation, recipe/tooling flags, or library input. Tether MUST reject those entry points outright (§10.12.5).

`app:config:explain` MUST report producer identity, options, defaults, current values, value-based acceptance/chosen heuristics, current expression sites, and taken-over sites. It MUST validate producer identity and the injective `recipe.services` map. Opaque or unmatched provenance blocks semantic comparison but retains bounded current facts. Explain MUST NOT write, execute app or recipe code, follow includes, plan, or contact a provider.

`app:config:migrate` resolves only the injected declarative-snapshot registry within the recorded producer family. Missing or mismatched evidence and invalid chains fail closed. Ordered hunks are `option-default`, `add`, `remove`, `rename`, and `replace`, classified `already-satisfied`, `selected`, `retained-option`, or `blocking`. Structural changes require managed evidence; taken-over literals MUST NOT be overwritten. Service renames MUST atomically update managed references or block the edge. Interactive mode asks per selectable hunk; `--yes` selects untouched hunks; `--dry-run` writes nothing and acquires no write lock. Real writes commit only the longest contiguous satisfied edge prefix. Partial-edge commits and durable per-hunk progress are forbidden. Repeats MUST be byte-identical no-ops. Migration MUST NOT plan or apply the app. `meta:update` MAY report pending migrations but MUST NOT run them.

`app:config:lint` MUST report every independent load-stage failure, expanding validation members by issue, while retaining findings from successfully loaded fragments. Schema validation issues discovered while normalizing effective values keep `landofile.validation` and their canonical diagnostics, so they merge with the matching fragment finding. Other load-stage findings use `landofile.load` and carry `reason`: the validation issue's own rule when it has one, otherwise the failure's tag, so consumers discriminate causes without parsing messages. Effective decode, warnings, and planner resolution run only after a clean load stage (§7.7.2). Failed prerequisites suppress dependent findings rather than fabricating facts from missing fragments.

#### 8.2.2 The `meta:config` command

`meta:config` is the repair surface for `<userConfRoot>/config.yml`. `config.d/*.yml` and `LANDO_*` overrides are read-only. It runs outside app context at bootstrap `none`, builds no `ConfigService`, and is exempt from `notify.commands` promotion, so it MUST work when the §7.5 stack does not decode. `--source raw` (`view`, `get`) returns the parsed `config.yml` alone, redacted, even when that file fails validation; unparseable YAML still fails with `ConfigError`. Resolved reads (`view`, `get`, default) decode the full stack and fail with the structured §7.5 `ConfigError`. `validate` decodes the full stack (file, drop-ins, env, host) and fails with that same `ConfigError`; it MUST NOT report config problems as `LandofileWriteValidationError`. `set`, `unset`, and `telemetry off` compare candidate `config.yml` issues, including plugin and provider extensions, with the baseline file decode by path plus message. Writes are rejected with `LandofileWriteValidationError` only when they introduce a problem or leave the written key or a descendant invalid; problems already present elsewhere don't block and are reported once as warnings with code `LANDO_CONFIG_PREEXISTING_ISSUES`, naming each issue and its fix. Inferred sets choose the first acceptable interpretation, and rejected inferred sets follow the §8.2.1 reporting rule. `describe` computes its answer from the `GlobalConfig` schema alone, so it works when `config.yml` is absent or invalid. Rejected writes leave the file unchanged; accepted writes persist atomically; writes that change nothing follow the shared no-op rule of §8.2.1. `edit` still validates the whole edited file and honors `--dry-run`. Problems in other layers MUST NOT block the write; once the candidate file is valid they surface as envelope warnings with code `LANDO_CONFIG_OTHER_SOURCE_INVALID` carrying the §7.5 message and remediation, rendered once as a warning line in text mode.

Its `set` and `unset` writes follow the comment/format-preserving and fail-closed contract above, verified with the config.yml parser. Refusals MUST point to `lando config edit` or hand editing. A `set` whose first key segment is a Landofile top-level key and not a `GlobalConfig` key is refused before validation with remediation naming `lando app:config set <key> <value>`; keys both documents define keep the ordinary rule. Keyed reads (`get <key>` and a `--path` view) return `{ subcommand, key, value? }` and never the full `config` or `raw` tree; a missing selection omits `value` and renders empty text, as in §8.2.1. The `meta:config`, `app:config`, and `meta:global:config` umbrellas declare their verbs as positional `subcommand.options`. An unknown subcommand fails before the command lifecycle with `CommandInputValidationError` (`target` is the canonical id, `field: "subcommand"`, `kind: "arg"`, `reason: "option"`, exit `2`), without log locations. Remediation names the closest declared value within edit distance 2 when one exists, then lists the choices: `Did you mean "set"? subcommand takes one of: view, get, set, unset, edit, validate, describe, telemetry, translate.` The accepted `meta:config translate` option retains its app-scoped `NotImplementedError` remediation. `lando config` never targets the app; the app-config verbs have no `config:*` aliases.

#### 8.2.3 The `app:shell` command

`app:shell` requires a TTY and otherwise returns `ShellRequiresTtyError`. Host mode uses `ShellRunner` at the app root with resolved `LANDO_*` values and host resolution. Its line evaluator runs on the embedded Bun and removes `BUN_BE_BUN` and `BUN_FEATURE_FLAG_NO_ORPHANS` before a line runs, so `lando` in a line runs as Lando and keeps its detached workers. `--service` uses provider exec with TTY and §6.9.1 agent context. Execution resolves secret references only when explicitly referenced and MUST NOT preload them into shell execution state; redaction MAY snapshot store values under §3.7. Host-mode history persists at `<userDataRoot>/shell/<app-id>/history` unless `--no-history`; resolved secrets MUST be redacted before host history writes. Service mode MUST NOT create a Lando-managed history file or store: shells and interactive clients use their own history locations, normally under the effective user's home. History in the planned user's home follows the home contract (§6.5): a `persisted` home keeps it across rebuilds, an `authored` home follows its mount's lifetime, and a `disabled` or `unknown` home adds no persistence. In service mode, `--no-history` MUST apply a session-local history overlay to `CommandSpec.env` after normal environment merging, overriding service, forwarded agent, and explicit exec environment for those keys only; it does not erase existing history. The overlay sets `HISTFILE` and `NODE_REPL_HISTORY` to the empty string, and `MYSQL_HISTFILE`, `MARIADB_HISTFILE`, `PSQL_HISTORY`, `REDISCLI_HISTFILE`, and `PYTHON_HISTORY` to `/dev/null`. That disables history for the login shell, mysql and mariadb clients, psql, redis-cli, the Node REPL, and Python 3.13+ for the session; other tools MAY keep writing their own history files. `app:ssh --no-history` applies the same overlay. Files that shells and clients write are not Lando-owned history and are not redacted; Lando-owned output and events remain subject to §3.7.

A host line that violates the host shell dialect (§3.4) is not evaluated, published, or saved to the history file; the REPL prints every finding with its remediation and sets the last status to 2. When every finding has a mechanical, meaning-preserving fix (`${NAME}` to `$NAME` at a name boundary, `>&2` to `1>&2`), the next prompt is pre-filled with the corrected line, unresolved secret references intact, and runs only when the user presses Enter. `ShellReplIO.prompt(initial?)` carries the pre-fill; an IO that already holds typed-ahead input, or gets multiline text, shows an empty prompt.

The command publishes `cli-app:shell-init`, `cli-app:shell-run`, and `cli-app:shell-error`; inner commands publish `pre-shell-exec`/`post-shell-exec` or `pre-provider-exec`/`post-provider-exec` with redacted shapes.

In compiled mode, the host line evaluator MUST append a scoped private `bun` launcher to its effective `PATH`. The launcher sets `BUN_BE_BUN=1` and executes `process.execPath`, so a host Bun on `PATH` wins and a host without Bun uses the embedded Bun. Source mode needs no launcher. The launcher directory MUST be removed after the evaluator exits; `lando` in a line still runs with neither Bun bootstrap variable set.

#### 8.2.4 The `meta:bun` and `meta:x` commands

`meta:bun` is a transparent Bun argv proxy with no blanket verb allowlist; `meta:x` requires a package spec and proxies `x <spec> …`. Both use caller cwd, run at `minimal`, and publish `cli-meta:bun-*` / `cli-meta:x-*` plus redacted `pre-bun-self-exec`/`post-bun-self-exec`. They go through the private Bun self-execution wrapper (§2.1, §3.4), which self-spawns the current executable (`process.execPath` with `BUN_BE_BUN=1`) through the injected `ProcessRunner` and MUST NOT search `PATH` for Bun. Lando's own global flags precede the command id; every token after `bun` or `x` is Bun argv and MUST be forwarded unchanged. Core reserves aliases `bun` and `x`.

**Output and stdin.** In human (`text`) mode, `meta:bun` and `meta:x` inherit the CLI's stdin, stdout, and stderr; that passthrough is raw and is the one place human tool output bypasses redaction. A data artifact streamed through a granted stdout (§8.3) is the separate data-payload exception in §3.7. Under `--format=json` or `--format=yaml` the child still inherits CLI stdin, but its stdout and stderr are collected and the command emits one `CommandResultEnvelope` after exit, not `StreamFrame`s; no raw child bytes and no `meta:x` banner reach machine stdout. Collected output lives in `envelope.output` as channel-tagged chunks, not in every operation's `result`; completion status lives in `result.exitCode`. Collection is capped at 1 MiB of raw bytes per channel for the whole invocation across every child it starts; exceeding the cap fails with `ProcessExecError`, never a truncated success, and no later stage runs. Order within one channel is preserved; the contract makes no claim about interleaving between channels. The frame policy of other commands is unchanged. Direct library and event-driven execution collect by default and never implicitly attach host stdin or output.

The invocation-wide collector above belongs to the CLI adapter. Direct and event-driven calls retain the per-child capture limit; they MUST NOT be described as implicitly sharing the CLI collector across independent calls.

**Completion.** Child exit codes are data, not Effect failures of the wrapper: a successful Effect returns `{ exitCode }` (and `meta:x` also returns `spec`). Command specs install `commandCompletionFromExitCode` so nonzero completion yields `{ ok: false, exitCode }`, a `LandoCommandError` carrying the command id and that exit code, and the completed typed value (§8.3). Direct `invokeOperation` does not apply that command policy and reports successful Effect execution separately. Preparation failures are `FileIoError`; startup, I/O, and collection-overflow failures are `ProcessExecError`; timeouts are `ProcessTimeoutError`; recursive `BUN_BE_BUN` entry fails with `BunSelfReentryError`. There is no offline tag and no inferred offline classifier: offline or network policy is Bun's own behavior on the child.

**Launcher.** For every invocation, the wrapper MUST prepend a scoped private `lando` launcher to the child's effective `PATH` whenever a target resolves: the `lando` on that effective `PATH`, else the running compiled CLI. Source mode with no `lando` on `PATH` creates no launcher. When a launcher is present, a bare `lando` in package scripts, lifecycle scripts, or `x` binaries MUST run as Lando with neither `BUN_BE_BUN` nor `BUN_FEATURE_FLAG_NO_ORPHANS` set. Other commands keep their Bun environment, so a bare `bun` inside those scripts still reaches the current executable without a host Bun install. Caller environment overrides MUST NOT disable `BUN_BE_BUN` or `LANDO_DISALLOW_BUN_BE_BUN_REENTRY` in the child. The launcher MUST preserve `LANDO_DISALLOW_BUN_BE_BUN_REENTRY=1`, so nested `lando bun` remains refused, and its directory MUST be removed only after the child exits, including on interruption. This only changes the child's command resolution: the self-spawn remains `process.execPath` with `BUN_BE_BUN=1`, never a Bun selected from `PATH`. A path-qualified call to a Lando binary is outside this guarantee.

**Managed children.** `meta:plugin:build` (including declaration build), `meta:plugin:test`, `meta:plugin:publish`, trusted postinstall during `meta:plugin:add` and `meta:update`, and recipe `postInit` Bun actions stream live progress through `Renderer` in human mode and preserve their completion summaries; in machine mode they collect under the same per-channel cap into `envelope.output`. `meta:plugin:remove` collects quietly in both modes. Managed children MUST NOT inherit CLI stdin. Recipe `postInit` Bun and command actions MAY receive explicitly bound input, which takes precedence over default closed stdin. Canonical redaction runs before any collected output reaches events, envelopes, logs, or errors, and an explicit `BUN_AUTH_TOKEN` is always protected. When a collected managed operation fails, its error carries at most 8 KiB total of redacted UTF-8 diagnostic output, stderr first and then stdout, with an explicit clipping indicator. A human-streamed failure points to the already-displayed output instead; retained live tails for that case are deferred.

**Plugin operation failures.** Plugin acquisition and lifecycle paths that treat a nonzero package-manager child as a command failure MUST raise `PluginPackageOperationError` with `operation` in `resolve`, `download`, `verify`, `extract`, `postinstall`, or `remove` and package context; `exitCode` is present only when a child was observed to exit nonzero, because acquisition downloads and extracts are not a `bun install`. The CLI exits `1`. A failure stops every later Lando activation, deletion, registry, cache, or trust-mutation step; it does not roll back effects the child already produced, and explicit persistent trust grants are retained (§9.6). Direct `meta:plugin:build` and `meta:plugin:test` and the final `meta:plugin:publish` child follow the exit-as-data completion above. A failed prerequisite rebuild or retest inside publication stops with `PluginPublishValidationError` before any publish result exists.

In a batch update, failed-operation mutation safety applies to the affected plugin; earlier successful activations remain committed. Ordinary package failures may be reported per row while the batch continues. `ProcessExecError` and `ProcessTimeoutError` MUST abort the update invocation, including capture overflow. Once the shared collector exceeds its budget, catching that failure MUST NOT authorize another Bun child in the same invocation.

#### 8.2.5 The `app:open` command

`app:open` resolves only `http` or `https` targets, using the same listener selection as default routes (§6.6): a marked HTTP(S) primary, else the single HTTP(S) listener, never list order, with a named or numeric selector refining it. Hyperlink and open targets are `assigned`, `active`, non-wildcard host connections (§6.10). Default selection prefers the primary route, preferring HTTPS; `--service`, `--route`, and `--all` refine it. No target returns `OpenTargetUnresolvedError`; scheme violations use `HostProxyOpenUrlSchemeError` semantics. `--print` skips browser launch, and `--format json` returns targets. A headless host prints the URL and exits successfully. Events are `cli-app:open-*` plus `pre-open-url`/`post-open-url`.

#### 8.2.6 The `meta:mcp` command

`meta:mcp` serves stdio MCP; streamable HTTP transport is not yet specified; adding it starts with a §10.14 transport contract. Tools derive from built-in `LandoCommandSpec`s and from plugin commands (manifest descriptor plus loaded `ExecutableCommandSpec`) and return §8.11 envelopes. Effective allowance is the default set (built-ins with `mcpAllowed` and bundled plugin descriptors with `mcpAllowed`) plus global `mcp.allow` and `--allow`, minus config or CLI denies. A plugin descriptor's `mcpAllowed` from any other discovery source marks eligibility only: the command needs explicit allowance, and a plugin that replaces a bundled command id does not inherit the bundled default. `--allow` accepts built-in, plugin, and (with tooling) tooling ids. A well-formed plugin command id that no command in the session app provides remains a pending allowance: `--list` reports it as an `McpPendingAllowance` diagnostic, and it becomes a tool when a call's target app supplies an eligible owner. Malformed, never-allowed, and app-config write ids fail validation before serving. Destructive commands are never default-allowed. `--list` reports each plugin tool's plugin and discovery source and lists diagnostics for eligible commands that were excluded. `--tooling` or `mcp.tooling: true` adds resolved tooling. `--list` returns the effective catalog and exits.

The command retains one host runtime and leases the target app's contribution generation for each call (§10.14), publishes `cli-meta:mcp-*`, and delegates per-call events to `pre-mcp-call`/`post-mcp-call`. It MUST NOT be host-proxy or recipe-post-init allowed.

Every tool input MUST describe `appPath` as an app directory resolved relative to the session directory and explain that targeting an app publishes its allowed plugin commands as tools. `lando://apps` exposes known app paths as `apps[].appRoot`; it is an applied-app inventory, not filesystem project discovery. A call that publishes tools MUST append one model-visible text block after its envelope JSON, naming the app by canonical path and listing newly advertised ids separately from ids whose advertised contracts changed. The notice MUST explain automatic refresh for clients supporting tool list updates and explicit `tools/list` for other clients. Publication notices survive command failure and dispatch rejection, do not modify `structuredContent`, and are omitted when nothing was published.

Dispatch rejections (`McpToolInputError`, `McpToolNotAllowedError`, `McpTransportError`) MUST return `isError: true` with a `CommandResultEnvelope` as `structuredContent` and identical envelope JSON in the first text block: `{ apiVersion: "v4", command: <called tool id>, ok: false, error: <redacted tagged JSON>, warnings: [], deprecations: [] }`. These rejections omit `result` and `output` and MUST validate against the tool's advertised output schema. Protocol unknown-tool errors and terminal transport failures retain §10.14's wire behavior.

#### 8.2.7 The `app:check` command

`app:check` runs the app's `CheckPlan` (§10.5.2) against a running app and exits `0` whatever the verdicts; a stopped app is `AppNotRunningError`. `--only <id>` selects checks by id. The result is `checks[]` with `{ id, kind, service?, url?, verdict, statusCode?, exitCode?, message?, detail?, next?, excerpt?, matchedBy? }`: `http` checks carry `service`, `url`, and the observed `statusCode`; `command` checks carry `exitCode` and omit `service` when they target the host; `matchedBy` is the provenance of the rule that matched; `app:start`, `app:restart`, and `app:rebuild` carry the same array when they ran checks. Only `lando-error` verdicts enter `warnings`. Events are `cli-app:check-*` plus the §10.5.2 task tree.

#### 8.2.8 The `schedule:list` and `schedule:run` commands

The bundled `@lando/schedule` plugin (§1.4) contributes both commands at `app` bootstrap. They operate on the scheduled jobs of §6.2.2.

`schedule:list [--service <name>]` reads the user Landofile and MUST NOT require a runtime provider, a started app, or a schedule sidecar. Its result is `{ jobs }`, one entry per job in service then list order: `{ service, name, every, run, timezone, sidecar, user?, nextRun? }`. `timezone` is the zone §6.2.2 resolves for the service, `sidecar` is the name of the schedule sidecar that runs the job (§6.2.2), the service name `lando logs --service` and `lando exec` take, `user` is present only when the job declares one, and `nextRun` is the job's next occurrence. A job whose calendar never occurs, such as `0 0 31 2 *`, MUST still be listed, without `nextRun`. `nextRun` MUST describe the schedule the sidecar executes: the same expression semantics, clock alignment, and timezone. `--service` limits the result to one service.

`schedule:run <name> [--service <name>]` runs one job once, immediately. It resolves the job from the user Landofile, requires the app's applied plan, and executes the job's `run` in the schedule sidecar that carries the job (§6.2.2), not in the parent service. It passes no user or working-directory override, so a manual run and a timed run are the same execution: the sidecar's container user, working directory, and environment. `--service` names the service the job is declared on, never a sidecar. Execution does not use the tooling execution path (§8.6); output is reported when the job completes and is not streamed. The command is process-backed (§8.3): the completed result `{ service, name, exitCode, stdout, stderr }` is retained for every exit code, a completion policy classifies it, a nonzero exit produces `ok: false` with that result retained, and the command's exit code is the job's exit code. It MUST NOT wait for or alter the sidecar's own schedule. Before executing, it MUST also refuse, with the `PlanReplanRequiredError` and `lando restart` remediation described below, when the running app's service of the sidecar's name is not that job's sidecar.

Lookup failures are tagged and precede any provider action. A name that matches no job, or no job on the named service, fails with `ScheduleJobNotFoundError` carrying `name`, optional `service`, and `available` (`<service>.<name>` labels). A name that matches jobs on more than one service without `--service` fails with `ScheduleJobAmbiguousError` carrying `name` and `services`, with remediation naming `--service`. An app with no applied plan fails with the standard replan-required error and `lando start` remediation. An applied plan that does not contain the job's sidecar, because the job was added or the `user` groups changed since the last apply, MUST fail with `PlanReplanRequiredError` whose message names the job and the missing sidecar and whose remediation is `lando restart`; the command MUST NOT fall back to the parent service. A sidecar that is planned but not running, because the app is stopped or the scheduler has exited, fails with the provider's `ServiceExecError` for a service that is not running, whose remediation is `lando start` (§5.3).

`schedule:list` is MCP default-allowed; `schedule:run` is not (§10.14).

### 8.3 Command contract

Every built-in command conforms to `LandoCommandSpec`; invocation conforms to `CommandInput`. Plugin commands split their contract in two. The manifest command descriptor (§9.4) owns identity and everything listed or routed without running plugin code: `id`, `summary`, `hidden`, `aliases`, `topLevelAlias`, `mcpAllowed`, and `deprecated`. The command module implements `ExecutableCommandSpec` from `@lando/sdk/plugins`, the executable subset `LandoCommandSpec` extends: `id`, `namespace`, `bootstrap`, optional `summary`, optional `flags`, `args`, and `strict`, `run`, `resultSchema`, and optional `completion`, `render`, and `redactionTokens`; positional arg declarations may carry `stdio`. `LandoCommandSpec` keeps `summary` required. Loading validates the id against the descriptor and canonical form, the namespace against the id prefix, the bootstrap level, a module `summary` (when present) against the descriptor summary, `run`, `resultSchema`, flag and arg declaration shapes, and §8.3.1 `yes`; a mismatch fails only that command with `PluginDescriptorMismatchError` or `PluginLoadError` (§9.7). Built-in registry fields without a plugin counterpart (`helpGroup`, docs and acceptance metadata, host-proxy and recipe allowlists, `streaming`) do not apply to plugin commands.

A positional `ExecutableCommandArgSpec` may declare `stdio: "stdin" | "stdout"`: its bare value `-` selects that process stream for the command's data payload (for example `db:export -`). Load validation permits the marker only on non-multiple string/option positional args with string values and no `-` default, at most one arg per stream per command, because the dash must be the caller's explicit choice; invalid markers, flag markers, and command-level stdio declarations fail only that command with `PluginLoadError` and remediation. Only the CLI grants streams as `input.stdio`; MCP rejects `-` on marked args up front with a tool-input error and path remediation, and its arg descriptions state that a path is required and `-` is CLI-only. Event and library invocations never grant streams, so the command MUST fail with `CommandStdioError` (reason `unavailable`) when a requested stream is absent and MUST NOT read or write process stdio itself. Help and reference derive `Use - to write to stdout.` or `Use - to read from stdin.` from the marker. The CLI computes refusals from parsed argv and declarative metadata alone, without invoking plugin parsers or other plugin code, before the app runtime boots: it MUST refuse with `CommandStdioError` and exit `2` when a requested stream is a terminal (reason `terminal`), in every result format. Machine formats are permitted with a stdout payload: the envelope, frames, and optional `--jq` output move to stderr (§8.11.3), including pre-command failures inferred from that stdout request. Command-input validation happens only inside the command lifecycle with its lifecycle events; grants derive from that validated input. A granted stdout uses the renderer's guarded writer over the real stdout, independently of the machine-output destination, so the renderer still owns backpressure, live-region suspension in human formats, and broken-pipe exit `141`. The payload bypasses payload redaction (§3.7): it is a data artifact, byte-exact like a file destination, and the command MUST write nothing else to stdout. A granted stdin is a lazy, single-consumer, cancellable byte stream; read failures surface as `CommandStdioError` reason `read` (exit `1`), and consuming it twice is a command defect.

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
| `onlineAcquisition` | The command acquires artifacts on purpose; the command lifecycle sets `OnlineAcquisition` for its fiber so downloads retry transient failures (§10.3.3). Plugin commands are routine |
| `docs`, `acceptance` | Required public documentation and acceptance metadata |
| `resultSchema` | Required `Schema.Codec<A, unknown>` for the `run` success value `A`; result-consuming hooks accept that same type. Empty results use an empty struct |
| `completion` | Optional format-independent policy over the returned value and normalized command input, yielding `CommandCompletion` |
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

Built-in positional arg declarations MAY carry `options?: readonly string[]`, matching plugin arg choices. After mapping CLI positionals to declared arg names, the dispatcher MUST reject each supplied value outside those choices before the command lifecycle with SDK `CommandInputValidationError` (`target` is the canonical id, `field` is the arg name, `kind: "arg"`, `reason: "option"`), exit `2`, and no log locations. The shared option check and remediation apply to CLI and event inputs, including MCP command execution: suggest the closest declared value within edit distance 2 when available, then state `<arg> takes one of: <choices>.` Text help, machine help, MCP enum schemas, and the generated command reference project the same declared choices.

A non-strict command declaring a `command` arg owns its verbatim tail: everything after the first `--` the user typed, or, without one, everything from its first positional (excluding declared flag values); flag parsing, value validation, and unknown-flag rejection (`UnknownCliFlagError`, exit `2`) MUST apply only to the preceding tokens. That includes the dispatcher's own flags (`--help`, `--version`, `--format`, `--json`, `-j`, `--jq`, `--renderer`, `--log-level`, `--debug`, `--verbose`, `--trace`): the boundary is found once, before any of them is read, so `lando exec ls --help` passes `--help` to `ls` while `lando exec --help` shows Lando's help.

CLI `app:exec` treats its first command word as a service only when no `--` precedes it (`lando exec -- web ls` runs the program `web`), and MUST fail with `ToolingExecError` before provider execution when it peels a positional service that is followed by a flag-shaped token instead of `--`; library, MCP, and event command arrays keep literal handling.

`CommandCompletion` separates successful Effect execution from successful command completion. Its schema accepts `{ ok: true, exitCode }` with a nonnegative integer exit code, or `{ ok: false, exitCode }` with a positive integer exit code; exit codes are not restricted to a POSIX-only 255 ceiling. An absent policy means success with exit 0. An installed policy MUST return a complete decision and MUST be resolved exactly once after producer scopes and owned output finish, before terminal lifecycle events and result rendering. CLI, MCP, plugin rendering, and event invocation consume that resolved decision rather than evaluating it again or inferring status from arbitrary result properties.

Process-backed commands explicitly classify their typed process exit code: nonzero completion produces `ok: false`, a `LandoCommandError` with command id, exit code, and remediation, and the completed typed value. Successfully produced diagnostic reports MAY remain `ok: true` while returning a nonzero shell code for findings, independently of result format. Actual Effect failures retain their original Cause and do not invoke a completion policy; pure interruption remains cancellation. Completion-policy defects MUST NOT silently default to success.

Read-only and non-destructive commands MAY set `mcpAllowed`; destructive commands MUST NOT. A command is destructive for MCP when it is on the core forbidden list, its id ends in a §8.3.1 destructive verb, or it declares `yes`. `mcpAllowed` nominates a command for the default set; omitting it does not prevent explicit allowance of a validated command. MCP's destructive classification and confirmation apply even when a command's `yes` declaration is a no-op on the direct CLI. A destructive built-in self-allow returns `McpAllowlistConflictError` at registration; a destructive plugin descriptor with `mcpAllowed` is excluded from defaults and reported as an `McpAllowlistConflictError` diagnostic, and stays explicitly allowable with confirmation through `yes` or elicitation. Host-proxy lifecycle commands MUST NOT self-allow; denied requests return `HostProxyCommandNotAllowedError`. Missing required registry metadata or `resultSchema` returns `CommandRegistrationError`.

The core forbidden list includes `meta:global:disable` and `meta:global:reconcile` because they can remove containers and routes. Their explicitly allowed MCP tools MUST report `destructive: true`. These policy commands retain their separate acknowledgement contract (§20.3.1): no `yes` flag or generic elicitation is added; `allow-disruption` acknowledges consumer impact for that invocation only and never bypasses ownership, dependency, or active-admission safeguards.

Command registration and invocation preserve these schema-backed `_tag` values:

| `_tag` | Boundary |
|---|---|
| `CommandAliasConflictError` | Alias collision |
| `CommandAliasTargetError` | Unknown custom-alias target |
| `CommandRegistrationError` | Invalid or incomplete `LandoCommandSpec` |
| `CommandInputValidationError` | Input rejected by target schema |
| `CommandStdioError` | Requested stdio payload refused (`terminal` or `unavailable`) or unreadable (`read`) |
| `UnknownCommandError` | No built-in, plugin, or app command owns the invocation; carries `commandToken` and ranked `suggestions` (§8.4.2) |
| `UnknownCliFlagError` | A flag the command does not declare, before its verbatim tail |
| `MalformedCliFlagValueError` | A declared flag's value is missing, empty, repeated, or outside its declared values |
| `DeprecationContradictionError` | Alias deprecation contradicts canonical command |
| `McpAllowlistConflictError` | Destructive built-in attempts default MCP allowance, or destructive plugin descriptor nominated with `mcpAllowed` (reported as a diagnostic) |
| `HostProxyCommandNotAllowedError` | Host-proxy canonical id not allowlisted |
| `NotImplementedError` | Registered deferred command plan |

#### 8.3.1 Confirmation flags

`--yes`/`-y` is CLI-owned and command-declared. A declaration MUST be an optional scalar boolean defaulting to `false`, and no other CLI flag may claim `-y`. Built-in and plugin commands MUST declare it when they request confirmation or when their canonical id ends in `destroy`, `remove`, `uninstall`, `prune`, `gc`, `reset`, `restore`, `rebuild`, or `poweroff`; `apps:scratch:stop` also declares it because it destroys the scratch app. A command that never prompts treats `yes` as a no-op so scripts and agents confirm every destructive command the same way; other commands MAY declare the same no-op. The CLI MUST NOT inject `yes` into a command that does not declare it; ordinary strictness and passthrough rules apply. A no-op declaration MUST NOT add a prompt, and `--yes` MUST NOT widen destructive scope such as `--volumes`, `--purge`, or `--prune`.

A plugin `ExecutableCommandSpec` that declares `yes` MAY set only `type: "boolean"`, `description`, and `default: false`; any other declaration fails to load with `PluginDescriptorMismatchError`. The CLI supplies `-y`, and argv parsing, help, and structured invocation use the same validated declaration.

### 8.4 Historical OCLIF integration (removed from shipping dispatch)

The retired OCLIF design used manifest-first routing, Effect lifecycle hooks, namespace topics, and flexible taxonomy. It is historical only; §8.4.1 and §14 Appendix D.1 own the current decision. Retained `src/cli/oclif/` names are native metadata or adapters.

#### 8.4.1 Single native dispatch (source + compiled)

Source mode and the compiled `$bunfs` binary share one registry and `runCli` dispatcher in `core/src/cli/run.ts`. Shipping code MUST NOT call OCLIF `execute()` or maintain a parity engine.

- Each `LandoCommandSpec` is registered once. Deferred ids live in the deferred-command plan table (`core/src/cli/deferred-commands.ts`) and return phase-tagged `NotImplementedError`.
- Cross-cutting CLI helpers live under `core/src/cli/` and MUST NOT be duplicated by entry mode.
- Source and relocated binary MUST have identical exit codes, tagged-error fields, and §8.11 output.
- Help, version, unknown-command, topics, and aliases derive from the registry; help listings, plugin topics, and unknown-command suggestions also project plugin commands from the plugin contribution graph (§8.4.2, §9.7).
- Canonical ids and aliases are colon-form tokens. Space-form compatibility normalization is limited to the heads `scratch`, `recipes`, `share`, `global`, `meta recipes`, `meta global`, `apps scratch`, `app config`, `app includes`, `app agent skills`, and `agent skills`, followed by any registered command beneath them. It joins the longest registered id or alias before the first flag or `--`, preserving the remaining arguments without restarting matching inside them. The colon umbrellas retain only `app:config describe`, `global:config describe`, `meta:global:config describe`, and `app:agent:skills <install|update|remove>` / `agent:skills <install|update|remove>`. Unsupported `apps list` and `app start` remain unknown.
- Files reachable from the pre-dispatch static fast paths MUST NOT import OCLIF, Effect, `@lando/sdk`, renderer implementations, or plugins (§1.2). Dispatcher-routed commands declaring bootstrap `none` MAY import schemas and Effect, but receive no prebuilt runtime services.
- `@lando/core/oclif` is not exported; embedding uses `@lando/core/cli` (§16.2).
- `SIGINT` interrupts the active Effect fiber and finalizes scoped resources. Foreground tooling/scripts MAY use an abort signal; while a keyboard-attached container PTY owns the terminal, Ctrl+C reaches that PTY rather than Lando. The shared core interruption projection owns `CommandInterruptedError` with optional `signal: SIGINT|SIGTERM|SIGHUP`, message `Command interrupted.`, and retry remediation. An interruption-only CLI failure MUST use exit 130 for SIGINT, 143 for SIGTERM, and 129 for SIGHUP, based on the signal observed at failure time, never generic internal Effect interruption text. On POSIX the normal CLI path (not the detached host-proxy worker) owns SIGINT/SIGTERM/SIGHUP before the level-`none` fast paths and re-raises the observed signal after cleanup so the parent sees a signal death; it restores inherited stdio file-status flags first (§8.11.2). When the inherited disposition can be read (procfs on Linux, libc on macOS), an inherited ignored SIGINT (non-interactive background jobs) or SIGHUP (`nohup`) stays ignored. Otherwise SIGHUP cancels like SIGTERM: captured helper processes run in their own session (§3) and no longer receive the terminal's hangup, so Lando must clean them up itself. An absent or unrecognized signal reason uses status 1 and MUST NOT expose the reason value. This is one core-local contract, not a parallel SDK error tag. Mixed typed failures, defects, interruption, and cleanup failures MUST retain the existing cause projection and roles; cancellation MUST NOT erase them. Scope finalizers, broken-pipe silence, and MCP request-cancellation/session-close suppression remain unchanged. Ordinary non-TTY provider commands, including exec, tooling, ssh, and scratch run, follow §5.3's owned-tree supervision and bounded cancellation/join contract, subject to the known Windows limitation in §5.8.1. This does not promise graceful signal forwarding to arbitrary script grandchildren.


Non-TTY service cancellation MUST use §5.3's single mounted-helper exec and in-band signal frame; disconnect triggers the same owned-tree cleanup, while normal exit preserves background descendants. The six-second cleanup budget and fail-closed missing-mount error with `lando start` remediation apply through CLI adapters. Managed Windows retains the limitation tracked by #2149.

The historical OCLIF manifest is replaced by the registry-derived embedded manifest plus the `app-command` index (§12.1). Router bootstrap MUST NOT parse Landofiles, resolve includes, contact plugin sources, import command modules, or initialize providers. Plugin commands resolve only after routing finds no built-in or tooling owner, in the separate plugin-resolution phase (§3.2, §9.7).

#### 8.4.2 Help projection

An invalid script or an enabled Landofile task that fails normalization (§8.5) remains visible in app command listings with a short `[unavailable]` marker and remediation naming `lando app:config:lint`. Machine catalog rows and the tooling arm of `HelpCommandDescriptor` carry `loadError: { _tag, message, remediation? }`. The message and remediation MUST each be redacted with the `secrets` profile before being bounded to 1 KiB of UTF-8. Targeted help (`lando <broken> --help` and `lando help <broken>`) for a script MUST re-read the script and re-check its collision set, then fail with its actual tagged content error, without executing the body. Machine targeted failures MAY include the cached diagnostic as `error.loadError`; that diagnostic never substitutes for the current error. Targeted help for an unavailable Landofile task is answered from tooling metadata, not a second Landofile load: index freshness covers every Landofile source (§8.7), so a fresh entry's diagnostic is current, and both help forms and a lone `--version` MUST fail with `ToolingCompileError` carrying that task's message and remediation. An unavailable task is never a wrapper for routing, so its help and version tokens are never forwarded. A disabled task is refused before this check and has no unavailable row.

Help is a registry projection, not a `LandoCommandSpec`; it has no registry entry, `run()`, or `resultSchema`.

Outside an app, exact `--help` or `-h` MAY use manifest-only level-`none` output. All other help routes through `runCli`; compiled help lives on that path, not in another dispatcher.

The locked **COMMON** ids are `app:start`, `app:stop`, `app:restart`, `app:rebuild`, `app:destroy`, `app:info`, `app:logs`, `app:exec`, `app:ssh`, `apps:init`, `apps:list`, `meta:setup`, and `meta:doctor`. **THIS APP** appears only with a fresh app command cache. **MORE** points to topic pages, including plugin topics, and to the full and JSON catalogs. Each command gets one row whose primary token prefers a custom alias, then an enabled implicit alias, then canonical id.

Color requires TTY stdout, renderer `lando`, non-JSON format, and no host color opt-out (§8.9); cold help MUST NOT import a renderer. Machine help uses `encodeCommandResult` with command `cli:help`. Topic pages cover registered namespaces and command tokens and show aliases, deferred status, flags, and args.

Root, all-command, and topic machine help return the catalog with structural `toolingMetadata` availability. An explicit command target returns a `target` descriptor with canonical identity, typeable token, summary, source, and the shared input declaration/revision for tooling. Built-in and plugin command targets carry ordered declared `input.flags` and `input.args` with the same names, descriptions, and choices as text help, plus flag value types, required/multiple markers, declared defaults and flag spellings, and positional `stdio` when declared. Universal global flags remain outside these per-command inputs, and tooling revisions do not apply to built-in or plugin inputs. On the CLI host, missing, stale, or invalid tooling metadata with a resolved app source is rebuilt once per §8.7 before help continues; a failed rebuild and an unknown target MUST produce their precise tagged failures rather than silently returning a root catalog. Disabled-target help MUST refuse without entering command execution. Enabled internal tasks remain absent from listings but support explicit direct help through both `lando help <task>` and `lando <task> --help`; an unavailable internal task fails that help with its `ToolingCompileError`. Task-owned help-token policy remains unchanged. JSON/YAML help flags MUST NOT emit human help text.

Plugin commands appear in help from their manifest descriptors (§9.4, §9.7), never from the embedded built-in manifest, and listing them MUST NOT import plugin code. Level-`none` root help MAY list bundled plugin topics from the build-time bundled command descriptor table (§12.1) and MUST NOT perform plugin discovery; built-in target help and core topic text pages MUST NOT acquire plugin metadata. A plugin command row uses its preferred alias or canonical id as the typeable token and its descriptor summary; machine rows and targets carry `source: "plugin"`, the contributing `plugin` name, its discovery `provenance`, and `implementation`: `discovered` from the descriptor alone or `validated` once its module loaded. A command whose module fails to load stays listed and its own help and invocation report a bounded, redacted `loadError` (`_tag`, `message`, optional `remediation`). Machine catalogs carry `pluginMetadata` with discovery status and bounded, redacted manifest-resolution `diagnostics` (dropped aliases, shadowed command ids, unreadable plugins), each naming the winning owner (`source` plus `commandId` or `pluginName`) and the losing plugin command where applicable; `lando help --all` lists up to three conflicts and points to the machine catalog for the rest. Listings do not evaluate plugin modules, so missing loaders and executable validation failures surface when the command is used or described. Built-in and tooling rows render whatever plugin discovery reports.

A namespace head owned by plugin command ids and not a core namespace or topic is a plugin topic for `lando help <ns>` and `lando <ns> --help`; its description is the contributing plugin's manifest description when exactly one contributing plugin supplies one, otherwise a generic namespace description. Plugin commands shadowed by a built-in id or alias, or by a positively resolved tooling task, are omitted from listings, topics, and suggestions, matching dispatch. `lando help <token>` resolution prefers a core topic, then a built-in, then a positively resolved tooling task, alias, or script, then a plugin command, then a plugin topic. A tooling cache miss or unknown tooling task on a help route defers its failure until plugin lookup also misses; an explicit `app:<task>` token defers only when a fresh tooling index positively lacks the task. A missing, stale, or invalid index on the CLI host with a resolved app source is rebuilt once per §8.7 before that decision; a failed rebuild is the tooling failure that defers. Invocation follows the same rule: a colon token, including `app:<task>`, reaches plugin dispatch after a fresh-index tooling miss. Bare invocation of a token that tooling cannot resolve because the index is not fresh still fails closed with the tooling error, with remediation naming the matching plugin topic or command. A token that a fresh index positively lacks, and that no built-in or plugin owns, is an ordinary unknown command: `UnknownCommandError` under command `cli:unknown-command`, carrying `commandToken` and `suggestions` (up to three routable spellings, best first, one per command), never a tooling error. Unknown-command remediation names, in order: the canonical id of a plugin alias that routing refused; the colon id formed by joining two to four leading words (`meta version` names `meta:version`); the closest visible, non-deferred typeable token across built-ins, the fresh index's tasks and scripts, and plugin commands, honoring alias policy, within one Damerau-Levenshtein edit for a last colon segment of two to four characters and two edits for longer ones (none for one character or tokens with control characters), naming the best in the remediation and adding the entry's short top-level spelling when the suggestion is a colon id; `lando help <topic>` for a core topic head, a plugin topic head, or a colon token under a plugin topic; the one built-in or plugin command whose id minus its namespace equals the token; otherwise `lando help --all`. When plugin discovery is unavailable, the remediation appends the discovery failure, and a failed discovery MUST NOT claim a token that a non-plugin command is spelled close to.

### 8.5 Tooling schema

`tooling:` is a Taskfile-inspired surface, not Taskfile compatibility. Its durable concepts are `cmds`, `deps`, `vars`, `sources`, `generates`, `status`, `preconditions`, and `run`.

Landofile tasks default to `wrapper: false`. Lando MUST answer `-h`/`--help` for a non-wrapper task without executing it, except that a declared flag named `help` or aliased `h` owns both spellings. A task marked `wrapper: true` forwards help and version input to its command. Wrappers MUST have exactly one command step (`cmd`, including argv form, or one entry in `cmds`), no declared flags or args, and `arguments` not false. Violations MUST fail that task's normalization with source-aware `ToolingCompileError`, naming the failed rule and its correction. Explicit `wrapper: false` is allowed anywhere. Command text MUST NOT determine wrapper ownership. Help tokens in any position before the first `--` use this ownership; tokens after it never request Lando help. A `--` that is the first token after the task name belongs to Lando and is not forwarded; every later token, including a further `--`, reaches the command unchanged. `lando help <task>` always requests Lando help; a disabled route gets typed refusal, while an enabled internal task is hidden from listings only and answers explicit help (§8.4.2).

After global flags are stripped, a non-wrapper task whose entire tail is `["--version"]` MUST fail before execution or provider work with `ToolingInputError` (`tool` is the canonical id, `field` is `version`), unless it declares a flag named `version`. The failure renders the standard human or machine envelope and exit mapping. The message identifies the typeable task as a project task with no version of its own; remediation names `lando version` and `lando <task> -- --version`. Wrappers forward lone `--version`; `--version` with other tokens, or after `--`, is ordinary input, as are `-v` and `-V`.

Tooling help states what the task runs, from a bounded `ToolingRunSummary` recorded in the app command index: for a Landofile task, the step count, the distinct targets in authored order (a service, the host, the service a flag names, the primary service, or a target still holding an invocation expression), and, for a single step whose command is one simple program, that program's name (argv[0], or, for shell text that is one simple command with no unquoted operator, command substitution, or line break, its first word after leading `NAME=value` assignments; a plain path-like token of at most 64 characters); for a script, its path under the app root. Full command text never enters the index. Human help renders it as one sentence such as ``Runs `composer` in appserver.``, `Runs 3 commands in appserver and database.`, or `Runs .lando/scripts/deploy.bun.sh on the host.`; machine targeted help carries it as `runs`. Both pass through the `secrets` redactor. An MCP tooling tool's `description` is its summary followed by the same sentence, so agents can tell what a tool runs before calling it. `runs` is optional: the summary is omitted for more than 1000 steps or 32 distinct targets, or a script path longer than 512 characters, and the task stays routable.

Human tooling help ends with one short ownership hint, using the typeable task name. Wrappers say that `-h`, `--help`, and `--version` go to the command and name `lando help <task>` for Lando's page. Scripts name `lando <task> -- --help` to pass help to the script. Other Landofile tasks name the same escape for the command and `wrapper: true` for thin CLI wrappers. Tasks with declared flags or args, or with `arguments: false`, get no hint.

Named tooling schemas and types include `ToolingTask`, `Command`, `TaskDependency`, `Precondition`, `Glob`, `Expression`, `FlagSpec`, and `ArgSpec`. The SDK owns the Schema-derived `NormalizedToolingFlag`, `NormalizedToolingArg`, `ToolingInputRevision`, `ToolingInputDeclaration`, `ToolingInvocationInput`, and `ToolingInputValues` contracts.

Metadata MUST normalize once after layers/includes and drive CLI, help, machine indexes, cache, and MCP identically. Stale caches MUST NOT bypass `disabled`. Unknown services, dynamic flags, invalid args, disabled tasks, and unsupported fields fail before execution with tagged source-aware remediation.

**Load failures versus per-task normalization errors.** Two failure classes are distinct and MUST NOT be merged. A strict load failure rejects the whole Landofile: parse and schema errors, unsupported task keys (§8.5.1), and deferred invocation scopes (§8.5.4) fail loading, so no app command resolves until the file is corrected. A per-task normalization error belongs to one task whose declaration decodes but contradicts itself: a colliding flag alias, a sensitive, required, boolean, default, or choices conflict, mixed, duplicated, or misordered argument `order`, positional declarations with `arguments: false`, a wrapper rule violation, an authored `LANDO` or `LANDO_*` env key, a `:<flag>` service or var-target reference without a declared non-boolean flag, `cmd` with `cmds`, or an empty step. Its presence MUST NOT fail loading, planning, startup, or unrelated tasks; an event that invokes it retains the normal event failure policy (§8.7). The affected task becomes an unavailable command (§8.7); lint reports each defect (§8.2.1). Disabled refusal precedes normalization on every surface: a disabled task is never normalized, has no unavailable row and no `loadError`, stays hidden, and fails direct calls with `ToolingDisabledError`. Tasks default to namespace `app`; names MAY contain colon subnamespaces.

#### 8.5.1 Task definition

`ToolingTask` includes:

- Command graph: `cmd`, ordered `cmds`, `deps`, `aliases`, `namespace`, `topLevelAlias`, `internal`, `disabled`.
- Execution: `service`, `engine`, `bootstrap`, `user`, `dir`, `appMount`, `stdio`, `interactive`, `passThrough`.
- Data: `vars`, `env`, `dotenv`, `flags: FlagSpec`, `args: ArgSpec`.
- Freshness and policy: `sources`, `generates`, `method`, `status`, `preconditions`, `if`, `run`, `platforms`, `output`, `failFast`, `silent`.
- Documentation and evolution: `desc`, `summary`, `description`, `usage`, `examples`, `deprecated: DeprecationNotice`.
- Presentation: `prompt`, `silent`, `output: interleaved|group|prefixed`, and `failFast`.

Declared task keys that are not yet executable are listed once, in `@lando/landofile`'s unsupported tooling-task key list, and fail closed with `NotImplementedError` and remediation before execution; the list shrinks as keys become supported and MUST NOT be re-spelled per surface.

The unsupported-tooling scan MUST retain every refused key's authored path, including numeric step indexes. Runtime loading fails with the first finding as `NotImplementedError`, naming that path. Lint MUST report all findings once per authored occurrence as `landofile.load` with `reason: "NotImplementedError"`, the scan's message and remediation, declaring file and layer, and coordinates from retained YAML. Schema findings for paths owned by that scan and the corresponding pathless runtime refusal MUST NOT duplicate those diagnostics. Deferred invocation scopes (§8.5.4) join the same report: lint emits one finding per refusing read at the authored command or field path, alongside refused keys such as `deps`, and no pathless copy of the first failure.

**Canonical declaration.** `ToolingInputDeclaration` contains ordered normalized `flags` and `args`, `acceptsArguments`, and a derived `revision: ToolingInputRevision`. It MUST NOT carry task steps, target service, source, or invocation values. Normalized flags carry `name`, optional `alias`, `boolean`, optional string `choices`, optional string-or-boolean `default`, `required`, optional `description`, and effective `sensitive: boolean`. Normalized args carry `name`, `order`, optional string `choices` and `default`, `required`, optional `description`, and effective `sensitive`. Generic registered commands MAY omit `.input`; every actual tooling/script compiler MUST publish it, including an empty declaration, for every command it can admit. Two rows are exempt because nothing can bind against them: an unavailable row (§8.7) MUST NOT carry a declaration, and a disabled Landofile task carries none, since disabled refusal precedes normalization. Cached indexes contain this same declaration, not parallel flag/arg snapshots. A cache ABI change invalidates old derived indexes without migration or a dual reader.

**Named-first binding.** `ToolingInvocationInput` is `{ _tag: "RawArgv", argv: string[] }` or `{ _tag: "NamedMaps", flags: Record<string, unknown>, args: Record<string, unknown>, passthroughArgv?: string[] }`. Engine/library options accept `input?` and `expectedInputRevision?`, replacing argument vectors and retained declaration arrays; omitted input means empty RawArgv. CLI supplies original tokens and parses them once. MCP, structured events, and library callers MUST preserve maps and MUST NOT serialize them into argv or pre-apply defaults. The engine resolves the authoritative task using existing authored/service contribution precedence, expression resolution, and late connection-client resolution, then admits and binds once. `@lando/landofile` owns pure normalization, binding, revision validation, and argv lowering; the engine owns admission and effects.

Binding produces exactly `ToolingInputValues { flags: Record<string, string | boolean>, args: Record<string, string> }`. Supplied own properties, omission, false, and empty strings MUST remain distinct, including prototype-shaped names. Unknown names and invalid types fail with value-free `ToolingInputError`. Raw tails are opaque undeclared passthrough only; a declared named invocation MUST NOT mix a raw tail or use it to fill positional gaps. Requiredness and defaults apply once. Map-capable scripts accept sparse named args; an argv-only adapter MUST reject an interior positional hole, including one created by a later default, rather than compacting it. Trailing omitted args remain valid. Equivalent CLI/MCP/event/library inputs MUST resolve equal logical values on their common domain; that does not require map-capable scripts to reject shapes only argv cannot represent.

**Boolean and argv projection.** CLI booleans accept `--flag`, `--flag=true`, and `--flag=false`, preserving last-occurrence-wins semantics. Lando MUST NOT generate `--no-flag` or interpret `--flag false` as false. Named false MUST override a true default. Only an argv-only adapter lowers bound values: value flags become `--name=value`, true becomes `--name`, false omits the positive switch, and positionals follow declaration order. Lowered argv MUST NOT be parsed back into values. This omission defines Lando forwarding, not an off-switch for arbitrary downstream defaults; no downstream-negation DSL is introduced.

Landofile task lowering first computes consumption (§8.5.4), then projects only unconsumed declarations and values. Positionals retain declaration order among that residual set; a positional hole consumed by interpolation MUST NOT make residual lowering fail. Invocation expressions receive the complete bound maps. Scripts retain their map-capable contract unchanged.

**Retained revisions.** The branded `ToolingInputRevision` is derived by SHA-256 over canonical ordered semantic declaration data: names, aliases, types, order, defaults, choices, requiredness, effective sensitivity, and raw-argument policy. Descriptions, source coordinates, and executable bytes are excluded. Retained MCP/event/library callers MUST carry the revision from discovery, including empty declarations. After authoritative target resolution and disabled refusal, execution MUST reject a revision mismatch with source-aware, value-free `ToolingInputError` before environment resolution, progress, or body effects. Direct calls without an advertised revision MAY use current semantics. No separate target lookup or planning may be added to the provider-free script path. Body-only and description-only changes remain compatible. An MCP session that projects tooling rebuilds a missing, stale, or invalid index through the §8.7 path when it starts, without narration, and keeps its fallback catalog if that rebuild fails. A retained MCP session checks command-index freshness, a §12.5 warm read, when it lists tools and before it admits a tooling call. When the index is no longer fresh, the session rebuilds it through the §8.7 path, atomically replaces its tool descriptors and dispatch entries as one generation, and sends `notifications/tools/list_changed` to clients that declared support. Admitted and in-flight calls stay pinned to the generation that admitted them; a call carrying a superseded revision fails with `ToolingInputError`, and the client re-lists before retrying. When a rebuild fails, the session keeps advertising its current generation and fails tooling calls with the rebuild's tagged error. Event and library callers that retain a revision re-resolve after a mismatch. Automatic replay is not part of this contract.

**Sensitivity and machine projection.** Authored flags/args accept `sensitive: true`; effective sensitivity is explicit true OR the existing name heuristic, never an opt-out. Normalization MUST reject defaults and choices for effectively sensitive inputs so cached metadata cannot contain credential literals. Values remain literal; this adds no expression scope or secret-provider lookup. The existing redactor MUST protect every supplied sensitive occurrence, including escaped forms, before validation errors, disabled/stale refusals, snapshots, output, events, or traces become observable. Retained and authoritative declarations may both contribute lexical classification. When authoritative metadata is unavailable, pre-admission snapshots MUST be value-free; errors MUST NOT echo unknown input names or values. This boundary does not protect arbitrary files or external logs written by a user command.

MCP tooling call events MUST NOT project request-derived `appRef` before authoritative admission. Retained declarations provide lexical classification hints, not clearance to disclose request context; a current declaration may newly mark an input sensitive. Other command correlation fields remain available.

MCP tooling input schemas MUST project the canonical declaration into real `enum`, typed `default`, boolean type (including false), member `required` plus required parent groups, and `additionalProperties: false`. Sensitive members use `writeOnly: true`; `x-lando-input-revision` and `x-lando-accepts-arguments` expose the revision and raw policy. Defaults MUST NOT exist only in descriptions. Generic MCP/event admission MUST NOT bind against retained metadata; authoritative execution remains the single binder.

`ToolingTaskInput` accepts a `ToolingTaskShape` object, literal `false`, or a non-empty string other than the exact string `disabled`. Literal `false` decodes to `{ disabled: true }`; a command string decodes to `{ cmd: <string> }`. The bare string `disabled` is rejected with remediation to use `false`; object-form `cmd: disabled` remains valid. Shorthands are interpreted after layer composition and replace an inherited task of the same name wholesale. An empty shorthand string is invalid; an object may still contain `cmd: ""`. `cmd` normalizes to one ordered `cmds` step. `description` aliases `summary`. `namespace` defaults to `app`; `topLevelAlias` follows §8.1.2. Built-in ids are reserved. Tooling tasks are never host-proxy eligible (§10.10, §12.1).

#### 8.5.2 Commands and dependencies

Steps are string commands or objects containing `cmd`, `task`, `command`, `defer`, or `for`. Per-step overrides include `service`, `dir`, `env`, `user`, `platforms`, `if`, `silent`, `ignoreError`, and `interactive`. `defer` finalizes in LIFO order when supported. Dependencies precede the body and independent dependencies run concurrently; `failFast: true` interrupts siblings. Serial composition uses ordered task steps.

##### 8.5.2.1 The `command:` step

`command:` invokes a canonical registered command with explicit `flags`, `args`, and `raw`; aliases are forbidden. Unknown ids return `ToolingCommandLookupError`. Inputs validate against the target spec and failures return `CommandInputValidationError`. Outer input is never implicitly forwarded.

Direct and indirect cycles return `ToolingCommandCycleError`. Effective bootstrap is the transitive maximum of declared and nested command requirements. Nested invocations publish the target's `cli-<id>-init|run|error` events with fresh `invocationId` and parent correlation, but MUST NOT independently trigger foreground completion presentation. Output shares the parent `Renderer`; `silent` suppresses renderer events, not logs. Interruption propagates. The step calls the canonical Effect program directly and does not reparse argv.

This producer contract is stable; the nested-correlation and notification-suppression rules are proven through MCP dispatch.

#### 8.5.3 Variables and environment

Precedence is task-call vars; CLI flag/arg values; task vars/env; included-file vars; include-namespace vars; `toolingDefaults`; §6.9.1 provider-exec agent context; process environment. Static values use §7.3.1 expressions. Dynamic `vars.<name>.sh` run at invocation through the selected engine, are safely interpolated, MUST reject raw interpolation, and MUST NOT enter caches.

A task var is a literal (string, number, or boolean, which MAY be a load-time expression) or `{ sh: <command>, service?: <target>, env?: <environment map>, sensitive?: true }`. A var's own `env` is authored for its command only: that command receives neither task env nor forwarded arguments, the var env obeys the same `LANDO`/`LANDO_*` ban as every authored tooling env, a `${secret:...}` in it is an ordinary binding site resolved when the var command runs, and a var env value MUST NOT read a dynamic var. Include-level and `toolingDefaults` vars are literal only. The known unsupported keys `raw`, `default`, and `prompt` fail loading with `NotImplementedError` naming the task and var, with form-specific remediation; other var objects fail schema validation: `raw` is unsafe interpolation, `default` names writing the value directly (a caller value already outranks a task var), and `prompt` names a declared flag or arg, because tooling input is explicit so CLI, MCP, event, and library callers can all supply it.

A dynamic var runs once per invocation, in declaration order, after admission (disabled refusal, input revision check, and flag/arg binding) and plan redaction registration, and before `pre-<task>`, progress, or any step. Direct tooling, canonical event commands, and inline event tasks share one preparation path; inline tasks retain their expression context and do not fire task brackets. Help never runs vars. A task-call var with the same name wins and the command does not run, whatever its value. Without its own `service`, the command inherits task service, user, and dir. An explicit var `service` accepts the task target grammar (`:host`, a service name, or `:<declared non-boolean flag>`) and resets task user and dir even when the target is unchanged; host vars use invocation cwd and container vars use `resolveContainerCwd`'s normal selected-service policy. Invocation cwd and user overrides still apply. Invalid targets fail normalization with `ToolingCompileError` at the authored var path before any var runs. The command receives neither task env nor forwarded arguments, runs without TTY or stdin, and is interrupted with the invocation. Output is captured without frames or lifecycle events; stdout loses trailing line endings. Crossing 64 KiB cancels and joins the child promptly and fails with `ToolingExecError`, without `exitCode`; no truncated value succeeds. An observed non-zero exit carries `exitCode`. Failures name `tooling.<task>.vars.<name>.sh`, target, and remediation; the CLI exits 1. Host dialect refusals retain `ToolingCompileError` at that path.

Effective sensitivity is authored `sensitive: true` or the existing `isSecretEnvName` heuristic (for example `API_TOKEN`); `false` is not accepted and the heuristic is not broadened. Register each nonempty sensitive value with `RedactionService` and the invocation token set immediately after capture, before the next var runs. Register sensitive caller overrides immediately. Later var diagnostics, host/provider output, results, and event error projections use the accumulated tokens. A failing or overflowing sensitive var withholds all stderr and says output was withheld because the var is sensitive. Other failures retain only the bounded redacted stderr tail (§3.7).

Safe interpolation follows §8.5.4 provenance in command text, var `sh` text before capture, and event command leaves. No `vars` site (including var `sh` and `service`) and no task-level `service`, `user`, or `dir` may read a dynamic var; an unattributable computed `vars[...]` read counts when the task declares dynamic vars. Invocation refuses such a task with `ToolingCompileError` before running anything, and lint reports it as `landofile.tooling` without blocking planning. Any var whose effective target is `:host` follows the host shell dialect (§3.4), checked at `tooling.<task>.vars.<name>.sh` even on a container task.

#### 8.5.4 Expressions in tooling

Executable positions admit `event`, `vars`, `item`, `key`, `flags`, `args`, `raw`, and `task` as recorded invocation AST thunks. `flags` and `args` are complete bound `ToolingInputValues` maps; omitted optional inputs are missing, while empty strings and false remain values. Missing evaluation input fails with `ToolingInputError` naming the input and authored site, with remediation to pass it, declare a default, or use `default()`. `raw` is the passthrough array, available only without declared flags or args. For `app:db:dump`, task key `db:dump` yields `{ name: "db:dump", subnamespace: "db", commandNamespace: "app", canonicalId: "app:db:dump" }`; no subnamespace yields `""`. Planned scopes `service`, `sources`, `generates`, `checksum`, and `timestamp` fail loading with `NotImplementedError` naming the scope, unavailable invocation feature, authored path, and alternatives. This is a strict load failure, not a per-task normalization error (§8.5); lint reports every refusing read at its authored path with coordinates (§8.5.1). Bootstrap-sensitive references require the effective level (§7.3.1).

**Provenance.** A segment is authored command text only when every read is authored and invocation-independent: captured load scopes (`env`, `host`, `app`, and peers) and literal task vars whose definitions read no invocation data and that no caller replaced. Everything else is data: invocation scopes, shell-computed vars, caller overrides even of literals, and literal vars transitively reading data through helpers, conditionals, computed access, or include/default composition. An unanalyzable `vars` read is data whenever the task has data vars. Substituted text MUST NOT be reparsed as a template.

Bind data in string commands, var `sh`, and event command leaves using quote-context escaping. Unquoted scalars become single-quoted words; single quotes escape as `'\''`; double-quoted sites escape backslash, double quote, dollar, and backtick. Booleans render lowercase. Empty values disappear only as whole unquoted argument words after an executable and outside redirection operands; otherwise preserve an empty word. Refuse backticks, heredocs, arithmetic/parameter expansions, escaped positions, and preceding unescaped dollars that would create dollar-prefixed quotes or combine with data into an expansion, including inside double quotes. Template comments and whitespace trimming MUST be accounted for when determining whole-word placement. Quoting cannot protect a program such as `sh -c` or `eval` that reinterprets an argument as code; documentation MUST state this limit. Argv elements and env/placement fields receive scalar values without shell escaping.

In shell text, raw MUST occupy a whole unquoted argument word, never command position, a redirection operand, adjacent text, or quotes. Quote each element separately, preserving empty elements; an empty tail contributes zero words. Only an argv element exactly equal to `{{ raw }}` splices the array, and final argv needs a nonempty executable.

**Consumption.** Any read of `flags.x` or `args.x` in a command, step env/dir/user/service, var definition, or var sh consumes that input. Service selectors consume their flag, including per-var selectors. Unattributable computed or whole-group reads consume the group; raw reads consume the tail. Lower and append only unconsumed input to the last step; tasks without bindings preserve normal forwarding. Shared preparation orders admission/binding, pure static checks, consumption, residual lowering, plan redaction, dynamic capture, command binding, and compilation. Static reference, target grammar, and raw-placement refusals precede shell evaluation. Unknown declared-member references are lint-only `landofile.tooling` findings with closest-name suggestions and invocation `ToolingCompileError`; they do not prevent planning unrelated tasks.

#### 8.5.5 Dynamic service resolution

`service` accepts a fixed name, validated `:<flag-name>`, or `:host`. Missing or invalid dynamic values fail before execution and MUST NOT fall back to raw argv. Step values override task `service`, `user`, and `dir`. `:host` MUST avoid provider initialization and use the `host` `ToolingEngine` backed by `ShellRunner`; argv-precise work SHOULD use a `ProcessRunner`-backed engine. A list `cmd` on a `:host` task is exact argv: it runs through `ProcessRunner`, never re-encoded as Bun Shell text, streams and redacts like a shell step, and publishes redacted `pre-process-exec`, then `post-process-exec` when the child exits, as `ProcessRunner` does; a startup failure is a `ToolingExecError` with remediation. A `:host` string step MUST follow the host shell dialect (§3.4): `app:config:lint` reports violations as `landofile.host-shell`, `app:cache:refresh` adds a `LANDO_HOST_SHELL_SYNTAX` warning per affected command (planning itself never fails on tooling), and invocation rejects the task with `ToolingCompileError` before any of its steps runs. A command string does not bind `$0` through `$9`, `$@`, or `$#`; forwarded arguments are appended structurally. Host execution remains subject to redaction, lifecycle, cancellation, and `PrivilegeService`.

#### 8.5.6 Up-to-date checks and run policy

`method: checksum|timestamp|none`, `sources`, `generates`, and zero-exit `status` determine freshness. `preconditions` MUST succeed before dependencies or commands. `run: always` always attempts execution after checks; `once` runs once per top-level graph; `when_changed` keys by task, input, vars, and source fingerprint. `--force` bypasses skips. `--status` reports freshness without execution.

#### 8.5.7 Events as tasks

Landofile `events:` accepts the same step types as `cmds` and adds decoded `.event` payload context. Event-triggered tasks execute directly and MUST NOT register router commands. Before load/plan validation, the valid event set MUST contain the reserved app lifecycle names (including `pre-restart` and `post-restart`) and reserved remote hooks `post-pull`, `post-push`, `post-switch`, and `post-code-sync` (§10.12.2), whether or not a remote connector is installed. It is then extended with `pre-<tool>`/`post-<tool>` from fully resolved tooling.

A tooling-derived event name MUST NOT collide with a reserved app or remote hook. A collision is a `landofile.tooling` issue at the tooling declaration, reported by lint and failing planning with `LandofileValidationError`, naming the task, reserved event, and rename remediation; it MUST NOT bind one step list to two triggers. Command alias disabling or remapping MUST NOT release an event-name reservation. The four remote hooks are triggered only by the corresponding core remote operation, never by a similarly named tooling task.

Each `events.<name>` step list replaces its inherited list wholesale across layers; a step's `service` is an execution target, not a merge identity (§7.2).

`stop` and `destroy` tear down the recorded applied plan, which carries no authored steps of its own. Their steps, including the `pre-init`/`post-init` pair that precedes them, are compiled from the current Landofile and `hostEvents` when that Landofile resolves to the recorded app (same kind, id, and canonical root), then run against the applied plan. When the Landofile is missing, cannot be loaded or planned, or resolves to a different app, teardown skips authored steps and continues; it MUST NOT fail because of the Landofile. The notice rules below apply, including to `destroy --root`.

Host-wide steps live in `<userConfRoot>/config.yml` under `hostEvents`, never in `GlobalConfig.events` (delivery policy) and never in the global-app Landofile. Env overlays MUST drop any path whose first segment is `hostEvents`. The ten supported names are pre/post `start`, `stop`, `restart`, `rebuild`, and `destroy`. Restart and rebuild nest the same stop/start (or destroy/start) trees as project events. v1 steps are a string, `{cmd, service?}` (`:host` allowed), or `{command}`; `task`, `defer`, `for`, `env`, `flags`, `args`, `dir`, `user`, and unknown fields fail at load. Container (non-`:host`) steps in `pre-start`, `post-stop`, and `post-destroy` fail at load and MUST name `config.yml hostEvents.<event>[i]`. A `command:` step that resolves to a lifecycle command id also fails at load. Lando never expands a `${NAME}` shell parameter in a `hostEvents` step, as in a Landofile (§7.3.1), so any step whose command contains one, host or container, is a finding at the step with remediation naming `$NAME` (read by the target shell when the step runs) and `{{ env.NAME }}` (the host value when the app is planned); a step whose expression cannot be parsed is a finding too. A `:host` step's `cmd` MUST also follow the host shell dialect (§3.4), checked against the text Bun Shell receives: `${secret:NAME}` becomes a placeholder, and a step with a `{{ ... }}` interpolation is checked when it runs. Strict authoring validation (`lando config validate`, `edit`, `set`) reports these findings at `hostEvents.<event>[i].cmd` (or `hostEvents.<event>[i]` for a string step); runtime configuration decoding MUST NOT, so a bad host step never stops commands that only read configuration. Planning a user app whose host events are not skipped fails with `LandofileValidationError` naming `config.yml`, before the plan cache is read; teardown follows the unplannable-Landofile rules above. `lando doctor` reports the finding without blocking its other checks. Every step, host or container, keeps the load-time unbalanced-quote check, because a YAML comment can cut an unquoted value.

`compileEffectiveEvents` runs host steps first, then project steps. A host step that canonically matches a project step for the same event is dropped (`"x"` matches `{cmd: x}`, an omitted service is the plan primary, and `:host` is part of the key). Missing plan services and exited, stopped, created, dead, or paused containers skip that host step with an info notice; `:host` is never skipped. Other errors fail like project steps. `post-start` and `post-stop` keep warn-only failure; the warning carries the step's redacted output tail, not only its label. There is no Landofile opt-out. Compiled steps carry `{source, sourceIndex}` so errors and the invocation frame point at `config.yml hostEvents.<event>[i]`. Status is `active`, `skipped`, or `deduped` at plan time. The compiled steps are a value on the plan (`AppPlan.events`, an `EventsPlan`), never a side table keyed on plan identity, so they survive every plan rewrite (cached-plan reads, mount-realization and volume-adoption spreads) between planning and the event run.

Landofile events come from the current Landofile, never from what was applied. `start`, `restart`, and `rebuild` plan the Landofile and run its steps. `stop` and `destroy` tear down from applied state (§5.3.1) and resolve their project steps from the Landofile at the applied root at command time, so a hook added after `start` runs on the next `stop` or `destroy`; host steps come from the runtime's host-configuration snapshot (§16.5) and are compiled against that Landofile's plan. When that root holds no Landofile (including `destroy --root`), the Landofile fails to load (including a form conflict, §7.1.1), or it names a different app or provider than the applied plan, the operation publishes one notice (`message.info` for a missing Landofile, `message.warn` otherwise) naming the reason, runs the lifecycle without Landofile steps, and still tears down. Loader or planner text in that notice passes through the canonical `secrets` redactor before publication (§3.7). This tolerance covers only hook sourcing: ownership validation and unfinished-accelerated-start recovery (§5.3.1, §10.6.3) stay fail-closed. A library `App` handle is a resolved snapshot (§16.6): its operations run the hooks of the Landofile it was resolved from, and a host that wants edited hooks resolves a new handle. Provider applied-plan records never carry `events`, so no path can run stale hooks. `StopAppResult` and `DestroyAppResult` carry `landofileEvents` (`{ status: "ran" }` or `{ status: "skipped", reason }`) whenever an app whose steps could have run was torn down, so machine consumers never scrape the notice. When a Landofile is present but unusable and `destroy` would remove data (`--volumes`, `--purge`, `--purge-caches`), a `pre-destroy` backup step it may declare cannot run: `--yes` accepts that, an interactive session is asked, and anything else fails with `LandofileEventsSkippedError` before any mutation. A root with no Landofile is not gated.

The in-process re-entry guard and depth-16 limit still apply. Only `:host` child processes started by host steps receive `LANDO_HOST_EVENT=1`; a nested Lando that sees it skips `hostEvents` with a notice. `lando config set` and `lando config unset` MUST reject any `hostEvents` path and tell the user to edit `config.yml` by hand. `lando config view` reports the host configuration and `app config` reports host-step status from the resolved Landofile. `app config explain` remains a non-executing canonical-file recipe report.

Nested event/command invocation MUST reject cycles with a visited stack and bounded depth. A failed pre-step prevents the body; a failed body prevents success post-steps; post-steps preserve order and failure is fatal with redacted output, except `post-start` and `post-stop`, which warn with that output. CLI, MCP, and library paths MUST preserve identical ordering and failure semantics.

#### 8.5.8 Tooling includes

Tooling imports use `includes:` with `kind: tooling`; `toolingIncludes:` is equivalent sugar. Fragments allow only `tooling:` and nested `toolingIncludes:`. Other Landofile keys and bare nested `includes:` fail with `LandofileIncludeError`. Paths resolve from the declaring file. Included tasks default to `<include-namespace>:<task>`; `flatten` removes that prefix; namespace `aliases` require a non-flattened include. `optional`, `internal`, `excludes`, and `vars` apply at include scope. Local task ids win. Cycles fail with `LandofileIncludeError` (`kind: "cycle"`). Like Landofile include failures, tooling include failures carry the declaring entry's authored `path`, `file`, and `layer`; nested failures retain the innermost entry's provenance.

Tooling fragments are local-file only; include-level `checksum`, `dir`, and bulk `topLevelAlias` are unsupported and fail closed. Per-task aliases remain valid.

`toolingIncludes.<namespace>` supports `file`, `optional`, `flatten`, `internal`, `aliases`, `excludes`, and `vars`. A fragment's own `tooling:` entry wins over nested include contributions with the same id.

#### 8.5.9 `.bun.sh` script-backed tasks

One malformed script MUST break only its own command. Discovery groups every path by canonical id before parsing; an ambiguous id produces exactly one unavailable index entry naming all conflicting paths, with no arbitrary executable winner. A Landofile task of the same id wins over healthy, broken, and ambiguous script entries. A filename with no usable canonical id produces a located lint finding and no command. Empty files, front-matter parse/schema/normalization failures, unsupported keys, `wrapper`, non-host targets, and collisions are deterministic content failures: the index retains their bounded `loadError` and MUST NOT give these entries an input declaration or route them as undeclared-input executables. Unreadable files and directory read failures MUST instead fail refresh with their tagged I/O error and path; they MUST NOT be cached as content failures. `CommandRegistry.list` and the opt-in MCP catalog omit unavailable scripts while retaining healthy siblings. Library and event script discovery MUST isolate unrelated broken scripts and fail when the requested script is broken.

CLI mode discovers `.lando/scripts/**/*.bun.sh`; path segments form `app:` subnamespaces. A Landofile task of the same id wins. Library mode requires `autoDiscoverBunShellScripts: true` (§16.5). MCP includes script-backed tasks through the existing opt-in `--tooling` discovery path, not a universal cold-discovery guarantee.

Top comment front matter validates strictly as `BunShellScriptFrontMatter`. Its supported top-level keys are exactly `service`, `desc`, `description`, `summary`, `flags`, `args`, `arguments`, and `disabled`. `arguments: false` rejects positional input and MUST NOT coexist with a nonempty `args` declaration. The block is delimited by `# ---`; each content line is prefixed with `# ` (a bare `#` represents a blank line), with an optional preceding shebang. Content uses the standard restricted Landofile YAML parser, including doubled-single-quote escaping inside single-quoted scalars. It MUST NOT use a separate scalar-only parser.

`flags` and `args` reuse shared tooling declarations and normalization. Flags support `alias`, `boolean`, `choices`, `default`, `required`, `description`, and `sensitive: true`; args support `order`, `choices`, `default`, `required`, `description`, and `sensitive: true`. Shared constraints apply, including alias uniqueness, required/default exclusion, boolean-default typing and prohibition of boolean choices, defaults within choices, sensitive-default/choices rejection, and positional ordering. Missing, malformed, unknown, or conflicting metadata, including environment-suffix collisions, returns `BunShellScriptFrontMatterError`; empty files return `BunShellScriptEmptyError`. The known unsupported keys `aliases`, `topLevelAlias`, `bootstrap`, `passThrough`, `sources`, `generates`, `status`, `preconditions`, `run`, `platforms`, `internal`, and `engine` MUST return `NotImplementedError`, not be accepted and ignored. After Landofile discovery and form preconditions succeed, `app:config:lint`, and `lando doctor --app` through it, inspect every discovered script, including when Landofile loading or effective validation fails. Each failure above, a duplicate canonical id, and a `service` other than `:host` is a `script.front-matter` finding; a body form the host shell dialect rejects (§3.4) in an enabled script that no Landofile task shadows is a `script.host-shell` finding. Script findings carry `source: { layer: "script", file, path }`, where `path` is the front-matter key path, plus the script `line` and `column` when known. This contract does not enable task graphs, alternate engines, or extra bootstrap controls for scripts. Normalized scripts carry the shared `.input` declaration but MUST NOT inherit the normalized task's execution fields.

`normalizeBunShellScript` in `@lando/landofile/bun-sh-metadata` is the shared normalization boundary for discovery, execution, and fingerprints. The default service is `:host`; any other service target, including `:<flag-name>`, MUST fail execution with `NotImplementedError` and remediation directing the author to Landofile tooling. `disabled: true` MUST hide the script from listings, help, and the MCP tooling catalog. A resolved direct invocation MUST fail with `ToolingDisabledError` before environment/secret resolution, progress, or body execution. Disabled and invalid-input preflight MUST NOT cause script side effects.

Declared script inputs bind under §8.5.1 before execution. Missing required input, invalid choices/types, unknown flags, and extra positionals return `ToolingInputError`. Scripts consume named values directly and MUST accept sparse optional named args without argv lowering. RawArgv calls retain the original physical tokens for existing numeric parameters, not canonical reordered/default-filled tokens. NamedMaps script calls MUST NOT synthesize physical argv. With no declarations, raw CLI tokens remain unparsed and the named maps are empty. Bun Shell's existing `$1` through `$9` support does not imply `$@` or `$#` expansion; a script that uses them, or another construct the host shell dialect rejects (§3.4), fails with `ToolingCompileError` naming the line and column before it runs. Declared inputs SHOULD be read through the named environment or maps, not numeric positions.

Scripts receive `LANDO_FLAG_<SUFFIX>` and `LANDO_ARG_<SUFFIX>`, where the suffix replaces every non-ASCII-alphanumeric/non-underscore character in the declared name with `_`, then uppercases it. Suffix collisions within either group MUST fail normalization; a flag and arg MAY share a suffix because their prefixes differ. Boolean values are the strings `true` and `false`. An absent value has an empty-string environment value and no entry in its JSON map. A boolean with no default remains absent until supplied. Runtime-owned input values MUST override caller/inherited values, and inherited `LANDO_FLAG_*` and `LANDO_ARG_*` namespaces MUST be cleared before current inputs are populated.

`LANDO_INPUT` MUST be JSON encoded through `ToolingInputValues`, with exactly `{ flags, args }`: `flags` maps declared names to strings or booleans and `args` maps declared names to strings. It MUST contain neither argv nor IO handles. The unreleased `BunShellScriptInput` export is replaced, not retained as an alias. Values are literal and sensitivity follows §8.5.1, including rejection of sensitive defaults/choices and protection before invalid/stale/disabled observable failures.

Routing freshness covers script paths and parsed metadata, including normalized declaration order, for valid scripts; body-only edits execute immediately without a rebuild. Invalid scripts instead use `{ relativePath, invalid: sha256(content) }` fingerprints so editing or fixing them stales the index deterministically. A metadata or ordering edit makes the index stale, so the next CLI-host invocation rebuilds it (§8.7). Known-route freshness checks visit cached paths; listings require inventory checks that find new files and collisions. A fresh app command index may resolve a newly added matching script, including its declared help, but MUST re-check the full set of colliding paths before selecting that script. A missing, stale, or invalid index on the CLI host with a resolved app source is rebuilt once per §8.7 before that fallback, and an index that is still not fresh MUST NOT use it. Scripts answer `--help`/`-h` without executing their body, unless any declared flag is named `help` or aliased to `h`; in that case both spellings go through the script's input parser. Separator handling follows §8.5: a leading `--` belongs to Lando and tokens after it never request Lando help. A direct disabled-script call with `--help`/`-h` MUST follow the same typed refusal as other invocations.

Scripts MUST NOT accept `wrapper` in front matter: an authored key fails with `BunShellScriptFrontMatterError`. Scripts use the non-wrapper lone-version refusal in §8.5, including the declared `version` flag exception and the `-- --version` escape.

Scripts run through the selected `ShellRunner`'s `runScript`; realpaths MUST remain under a permitted root, today only the app root (recipe-bundled scripts reach it by being published at init), else `ShellScriptOutsideRootError`, checked before the runner is called. They MUST NOT require host Node.js. `runScript` runs the file on the embedded Bun (`process.execPath` with `BUN_BE_BUN=1`), and Bun Shell exports that switch and `BUN_FEATURE_FLAG_NO_ORPHANS` to every command. A bare `lando` command in a script MUST run as Lando with neither variable set, so it neither falls into Bun nor reaps a nested `lando start`'s detached workers; it resolves to the `lando` on the script's `PATH`, else the running compiled CLI. Other commands keep both variables so Bun Shell's `bun` fallback still reaches the embedded Bun. A path-qualified call to a Lando binary is outside this guarantee.

### 8.6 The `ToolingEngine` abstraction

Sessions use this tooling executor under §22.6 admission. Aliases, authoring eligibility, hooks, and IO remain unchanged; §22 adds no command or workflow language.

The Effect service tag `ToolingEngine` has `id`, `canHandle(ToolingSpec)`, `compile(ToolingSpec) -> ToolingProgram | ToolingCompileError`, and `execute(ToolingProgram, CommandInput) -> ExecResult | ToolingExecError` with provider/process/shell requirements.

Core ships `providerExec` and `host`. `providerExec` targets services through the active `RuntimeProvider`, preferring exec against a running service and using ephemeral run only when explicitly configured. `host` targets `:host`: string steps run through the selected `ShellRunner` and list steps as exact argv through `ProcessRunner`. Script-backed tasks, `app:shell`, and host dynamic vars (§8.5.3) call the selected `ShellRunner` directly. Plugin engines include `processExec` for argv-precise host work, `remote`, and `dryRun`; none is bundled except the two core engines.

Selection precedence is step `engine` → task `engine` → `toolingDefaults.engine` → Landofile `toolingEngine` → global `toolingEngine` → `providerExec`.

### 8.7 Tooling compilation pipeline

App cache refresh MUST inspect scripts once and derive command entries and freshness fingerprints from that same snapshot; the writer MUST NOT perform a second discovery. A deterministic script content failure produces one `LANDO_SCRIPT_INVALID` command warning per unavailable script id (or unusable path), carrying its path, bounded redacted message, and remediation naming `lando app:config:lint`. Explicit `app:cache:refresh`, start, restart, and rebuild publish these warnings and continue. Implicit index rebuilds stay silent, as for `LANDO_HOST_SHELL_SYNTAX`. This tolerance applies only to discovery: a lifecycle hook or `task:` step that invokes the broken script still fails through the normal event failure projection with the script's current error and remediation.

Command compilation MUST isolate per-task normalization errors (§8.5). An enabled Landofile task that fails normalization produces one unavailable index entry carrying its canonical id, namespace, summary, and a bounded redacted `loadError` with `_tag: "ToolingCompileError"`, and no input declaration, run summary, or wrapper routing metadata; healthy tasks compile normally and the refresh succeeds. Explicit `app:cache:refresh` publishes one `LANDO_TOOLING_INVALID` command warning per unavailable task, carrying the task id, the bounded redacted message, and remediation naming `lando app:config:lint`. Implicit index rebuilds stay silent. Merely having an unavailable task does not prevent startup. `CommandRegistry.list` and the opt-in MCP catalog omit unavailable tasks while retaining healthy siblings. A lifecycle hook or event `task:` step that invokes an unavailable task follows the normal event failure projection: `LandofileEventStepFailedError` retains the compile diagnostic and remediation. Pre-event failures stop the operation; post-event failures follow the existing warning policy. Index freshness already covers every Landofile source, so correcting the declaration stales the index and the next CLI-host invocation rebuilds it and runs the task without an explicit refresh. A disabled task is compiled as disabled without normalizing its declaration and produces neither an unavailable entry nor a warning.

Compilation validates raw and resolved `ToolingTask`/`BunShellScriptFrontMatter`, resolves compile-time expressions and includes, merges discovered scripts, constructs and checks the task and command graphs, derives bootstrap/service/input metadata, selects an engine, compiles `ToolingProgram`, and writes registry metadata plus caches.

Routing metadata lives in the app command index; executable graphs live in the app-plan cache. The index contains canonical ids, namespace, aliases, help/input metadata (including the §8.5 run summary), effective bootstrap, and cache key. `ToolingProgram` contains normalized tasks, dependencies, command targets, schemas, expression ASTs, static data, freshness plans, and engine ids. It MUST exclude dynamic shell results, decrypted secrets, runtime service info, and provider connections.

Invocation MUST:

1. Resolve the canonical id from the app command index.
2. Read the cached `ToolingProgram` by app-plan cache key.
3. Resolve the invocation-authoritative declaration using normal contribution/expression and late connection-client resolution. Protect supplied input values before observable refusals; when the declaration cannot classify sensitivity, protect every supplied string. Refuse disabled targets before normalizing the declaration, and reject a full declaration failure with `ToolingCompileError` before checking retained input revision or binding input. Help tokens and a lone `--version` also report an unavailable task's compile error. Shared preparation applies §8.5.4 static checks and per-input consumption before residual argv lowering and any dynamic var command.
4. Bind the RawArgv or NamedMaps input once, then lower only if the adapter needs argv. Resolve the validated service target, call vars, freshness checks, and dynamic vars after admission.
5. Build the task's effective bootstrap layer.
6. Execute the selected engine and propagate its exit status.

This plan-cache path does not require scripts to acquire a full plan: the existing provider-free script path uses the same input admission contract against resolved script metadata.

Detailed command-index reads distinguish fresh, missing, stale, and invalid metadata. Unavailable routing MUST fail with `ToolingCommandUnavailableError`, carrying `commandId`, `tool`, `reason: missing-cache|stale-cache|invalid-cache`, nonblank `remediation`, and optional `sourcePath` and `staleReason`. Bounded stale reasons are `format`, `lando-version`, `source`, `referenced-file`, `script-metadata`, `script-inventory`, and `version-constraint`. Only a fresh lookup may conclude that the app has no such task, which is an unknown command (§8.4.2); I/O failures MUST NOT be silently converted to cache absence. The cache-state reasons reach a caller only where the next paragraph forbids a rebuild, such as host-proxy dispatch, or where the caller is not the CLI host; on the CLI host a failed rebuild reports its own error instead. Human help never shows stale declarations. Machine root help exposes `toolingMetadata` with `status: fresh|not-app|unavailable`; unavailable status carries reason `rebuild-failed` with the failed rebuild's redacted `_tag`, message, and remediation, or the cache-state reason, remediation, and available bounded details where no rebuild ran.

On the CLI host, app command metadata repairs itself, so users never need to know the command index exists. When the index is missing, stale, or invalid and the app source is resolved, dispatch and help MUST rebuild it once through the same operation as `app:cache:refresh`, loaded lazily off the fresh-cache path, before continuing. The rebuild is an ordinary load: it MAY acquire includes and publish their lockfile entries (§7.7.4), and it MUST NOT initialize a provider, start services, or materialize a managed dependency; a plan that needs one fails with that dependency's own error. A fresh index MUST NOT rebuild. A token that resolves to a built-in command or alias MUST NOT rebuild: the built-in wins regardless of the index, and the rebuild's include pinning would run ahead of a command that owns its own Landofile policy, such as a preview. Host-proxy dispatch MUST NOT rebuild; it already refuses app tooling routes (§10.10). A rebuild that finishes within a short delay (a tuning default) is silent; a longer one prints one renderer diagnostic line saying why the app's commands are being updated, only when stderr is a terminal and never under the `json` renderer, an envelope result format, or MCP. Machine output does not report a successful rebuild: the command index is an implementation detail, not a contract. An implicit rebuild does not narrate refresh warnings such as `LANDO_HOST_SHELL_SYNTAX`; `app:config:lint` and explicit `app:cache:refresh` report them. A failed rebuild fails dispatch and targeted help with its own tagged error, such as `LandofileValidationError` or an include acquisition error, never a cache-state `ToolingCommandUnavailableError`; root help still lists built-in and plugin commands and shows that error in place of app tooling. A failed rebuild is not recorded: the next invocation tries again, so fixing any input, including an included fragment the root Landofile's fingerprint does not cover, takes effect on the next run. Remediation MUST NOT tell users to run `app:cache:refresh`, start services, or rebuild services merely to repair discovery. Routing and help MUST NOT call a registry's live-discovery fallback as a substitute for the index. The hot path MUST remain offline after dependencies and task graph materialize; an implicit rebuild is not the hot path, and the §12.5 budgets apply to the fresh read that follows it. Retained MCP sessions rebuild and replace their catalog as stated in §8.5.1.

Tooling caches and paths are persisted contracts:

| Name | Contract |
|---|---|
| `app-command` / app command index | Routing metadata at `<userCacheRoot>/apps/<app-id>/commands.bin` |
| app-plan cache | Compiled `ToolingProgram` and app plan (§12.1) |
| `host-proxy-allowlist` | Canonical built-in command ids permitted through host-proxy |
| `.lando/scripts/**/*.bun.sh` | Auto-discovered CLI task source |
| `LANDO_INPUT` | Data-only `ToolingInputValues` JSON: exactly `{ flags, args }` for script tasks (§8.5.9) |

Tooling failures preserve these `_tag` values:

| `_tag` | Boundary |
|---|---|
| `ToolingCommandLookupError` | Unknown nested canonical command |
| `ToolingCommandUnavailableError` | Missing, stale, or invalid tooling metadata (§8.7) |
| `ToolingCommandCycleError` | Direct or indirect recursion |
| `LandofileIncludeError` | Invalid fragment or include shape, including recursion (`kind: "cycle"`), with declaring-entry `path`, `file`, and `layer` |
| `LandofileLoadError` | Two or more independent load failures; `failures` retains original tagged members and their attribution (§7.7.2) |
| `ToolingCompileError` | One task's declaration fails normalization; per task, never a load failure (§8.5) |
| `BunShellScriptFrontMatterError` | Invalid `.bun.sh` metadata |
| `BunShellScriptEmptyError` | Empty script task |
| `ShellScriptOutsideRootError` | Script realpath escapes authorized root |

### 8.8 `lando apps:init` and the recipe model

`apps:init` scaffolds a visible, user-owned Landofile from a versioned `RecipeDecomposer` producing `LandofileAuthoringFragment`.

- Every selected service, route, task, event, and default MUST be written.
- Runtime recipe expansion remains forbidden.
- `RecipeDefinition` and the `recipes:` plugin contribution remain removed.

Persistable nonsecret options MUST appear in inert `recipe.options` with producer identity and `RecipeManifest.version`. Generated option-derived values MUST use valid `{{ recipe.<option> }}` expressions. Expressions MAY produce values but MUST NOT determine structure. `init` uses the bundled `recipe` translator and `lando4` encoder, MUST NOT build an `AppPlan`, and MUST NOT contact a provider itself.

`files:` and `postInit:` are init-only and MUST follow the canonical §8.8.9 sequence, including final-root generated-file commit (§12.4.1) and required metadata publication (§8.8.13). Neither may run while any prerequisite remains incomplete.

- Later failure reports committed files and failed action without claiming rollback.
- Diagnostics are ordered translation then encoding diagnostics.
- The CLI MUST NOT generate `.lando.ts`.

#### 8.8.1 Command surface

`apps:init [destination]` accepts `--recipe`, `--source`, `--name`, repeated `--answer`/`--option`, `--answers`, `--no-interactive`, `--yes`/`-y`, and `--full`. `--from-source` belongs to the deferred source-layering capability in §8.8.13, not the current command.

- Destination defaults to `--name` or cwd and MAY contain files. Existing Landofile destinations fail with `InitTargetExistsError`; any other scaffold conflict skips the scaffold set while free Landofile destinations remain writable.
- Omitted interactive `--recipe` prompts from bundled recipes. The current `--source` selects remote recipe acquisition (`git`, `tarball`, `npm`, or `registry`), not application-code layering or a contributed `InitSource`. The future namespaced `source.<prompt>` contract belongs to §8.8.13.
- `--answer` and `--answers` accept nonsecret values; later values win. Raw secret keys are rejected. Secret-store answers accept only existing `${secret:...}` references.
- `--no-interactive` fails unanswered required prompts without defaults with `RecipeMissingAnswerError`; optional descriptors without defaults remain omitted. `--yes` accepts defaults; `--full` accepts the full default set. The command runs at `minimal` bootstrap without provider contact.

#### 8.8.2 Recipe directory layout

A recipe directory contains exactly one `recipe.yml` or `recipe.ts`, the auxiliary sources its `files` declare, and for bundled recipes `README.mdx`. The directory basename MUST equal `id`. The Landofile comes from compiling the authored `config`, never from a template; a `files` destination equal to a Landofile basename is rejected. Static auxiliary files copy byte-exact; `template: true` files decode as strict UTF-8 and substitute only `{{ app.name }}`. Per-file `when` and `engine` are reserved and MUST be rejected at preparation until an implementation is verified. Recipe READMEs follow §19.13.

#### 8.8.3 The recipe source schema

`RecipeSource` is the only accepted author format, published from `@lando/sdk/schema` and as JSON Schema. `recipe.yml` decodes to it directly; `recipe.ts` exports it (§8.8.14). Decoding is strict: unknown or retired keys (`prompts`, `snapshot`, digests, asset inventories) fail with `RecipeManifestValidationError` and are never adapted. Load-bearing keys are:

| Key | Contract |
|---|---|
| `id`, `title`, `description`, `version` | Identity and required semver; `id` matches directory |
| `options` | Keyed declarations `{ type, default?, prompt? }`, secret `{ type: { kind: "secret" }, disposition, prompt? }`, or `{ drop: true }` for an inherited option; `name` is reserved |
| `config` | Required ordinary Landofile-shaped mapping with §7.3.1 source strings and merge directive envelopes |
| `variants` | Ordered `{ when, config }` overlays applied after `config`; `when` is an options-only §7.3.1 expression |
| `files` | Ordered auxiliary `{ src, dest, mode?, template? }` or `{ dest, drop: true }`; no author digests |
| `postInit` | Ordered `gitInit`, `message`, `command`, and `bun` actions |
| `extends` | Single recipe parent (§8.8.15) |
| `authors`, `tags`, `deprecated`, `requires` | Catalog, evolution, and soft prerequisites |
| `runs`, `fetchAllowlist` | Canonical-command and HTTP-GET allowlists for programmatic init |

`options.<name>.type` is a closed `RecipeOptionType` (`string`, `number`, `boolean`, `enum`, `array`, `optional`); enum values are typed scalars and MAY include `false`. `default` MUST satisfy the descriptor; a nonoptional option without a default is required input. An optional descriptor without a default may be omitted; a blank interactive answer omits its key rather than inventing a value, while a declared default takes precedence over omission. `prompt` is presentation only (`message`, `type`, `validationMessage`, `choices`, `deprecated`) and MUST agree with the descriptor; `prompt.when` and duplicate `prompt.validate` constraints are rejected. The compiler derives runtime prompts, validation, types, defaults, and choices from the single descriptor. Secret options declare exactly one disposition and never become persistable options, snapshot types, or defaults. Config and condition references to unknown or dropped options fail compilation. Hyphenated names require bracket access, such as `options["php-version"]` or `recipe["php-version"]`, rather than dotted subtraction syntax.

Compilation is the pure SDK compiler `compileRecipeSource` over the complete ordered config layer sequence (parent base, parent variants, child base, child variants) using Landofile merge/reset/override rules and only `options` plus the closed pure §7.3.1 helper subset for `when`. Evaluated option or helper strings are data and MUST NOT be reparsed as authored expressions. The variant budget is 256 branch states; over-budget input fails with `RecipeSourceCompileError` reason `variant-budget`. The compiler has no filesystem, process, provider, or network access.

The historical record is derived, not authored. Core compilation (`compileResolvedRecipe`) observes raw auxiliary and script bytes under their declaring origin, supplies their digests and trusted producer coordinates (`sourceKind`, `packageName`), and derives the current `RecipeSnapshot` (`identity`, `optionTypes`, `defaults`, `template`, `assets`), the producer `contentDigest`, and the asset inventory. Portable identity excludes host-local paths. `RecipeSnapshot`, `RecipeProducer`, and `RecipeManifest` remain wire and runtime carriers; they are not a second accepted author format, and no author (bundled or external) writes snapshot ASTs, digests, or duplicated asset inventories. Snapshot and migration data are inert and MUST NOT contain callable application logic. Migration edges carry exact `from`, `to`, `fromSnapshot`, `toSnapshot`, and ordered `hunks`; every hunk carries stable `id`, `kind`, owning `layer`, canonical `path`, and old/new presence and value, remains within one producer family, forms a unique monotonic chain, and agrees with snapshot diffs.

`historyEligible` is true only when every resolved source is declarative and can produce inert declarative history without evaluating recipe code. It is false when the source or any ancestor evaluated TypeScript. Eligibility MUST NOT imply that external historical versions have been published or that migration edges are installed. The external history registry is separate work tracked in issue #1849; existing bundled history lookup is unchanged. Initialization is supported either way. Historical tools never evaluate arbitrary recipe code. Remote trees and remote ancestry are YAML-only.

Recipe and prompt `deprecated` values emit `message.warn`, register §18 notices, and appear in doctor deprecation output. Option names MUST be unique. `postInit.command` accepts only generated allowlisted canonical ids. Migration snapshot helper names remain the closed pure §7.3.1 set, including scalar logic, collection transforms, JSON/base64, shell quoting, path, URL, and semver helpers. `load`, `import`, filesystem helpers, host lookup, remote access, commands, and arbitrary JavaScript MUST be rejected.

#### 8.8.4 Recipe sources

| Reference | Resolution |
|---|---|
| bare id | Built-in `recipes/<id>/` |
| relative or absolute path | Local directory |
| `github:` or `git+https:` | Source-store entry `<userCacheRoot>/sources/git/<commit>/` (§12.8); an `@ref` suffix selects a tag, branch, or full commit SHA |
| `npm:` | Published tarball as source-store entry `<userCacheRoot>/sources/archive/<sha256>/`, indexed by registry and `name@version`; the registry MUST publish a usable `dist.integrity` (first SRI token, supported algorithm) or legacy sha1 `dist.shasum` (§12.8.2) |
| `tarball` (`--url`) | Archive as source-store entry `<userCacheRoot>/sources/archive/<sha256>/`; `--checksum` is the expected digest |
| `registry:` (`--source=registry --id=<id>`) | Resolves `<id>` through a JSON recipe registry: `GET <registry-url>/<id>` returns a `RecipeRegistryResponse` naming a git or tarball resolution, which is then acquired through the §12.8 source store like the corresponding scheme above. The default URL is `DEFAULT_RECIPE_REGISTRY_URL` in `core/src/recipes/registry-source.ts`; `--registry-url` overrides it. `extends: registry:<id>` parents resolve the same way. A 404 fails `RecipeSourceError` kind `recipe-not-found`, an undecodable response `registry-invalid`, and a transport failure `registry-failed`. The hosted service behind the default URL is not yet live; point `--registry-url` at a registry you operate until it is |

Resolution goes through the §12.8 source store under the user cache root, never the durable data root; recipe and parent files are copied out at init, so recipe entries are protected from `meta:sources:gc` by recent use only. A cached full commit SHA, or a `--checksum` whose archive entry is already cached, is reused without network access; a branch, tag, or default-branch request is fetched again on each resolution and falls back to the cached commit for the same source and ref only where a warning can be shown (`lando init`, for its `--source=git` recipe and for every remote git `extends:` parent it resolves) and only when the fetch fails for a reason other than authentication; otherwise the failure stands.

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

Recipes resolve prompts through `InteractionService`. Raw secrets MUST NOT enter templates, argv, files, provenance, diagnostics, journals, transcripts, renderer events, telemetry, or decomposition. The resolver MAY deliver raw bytes only to the declared post-commit sink. Conditional authored prompts are not supported; `variants.when` changes config structure, not the prompt collection contract.

#### 8.8.6 Recipe expressions

Recipe `config` values use §7.3.1 expressions; option-derived values are written as `{{ recipe.<option> }}` and resolve at app load. Structural `when` conditions use only `options`. Auxiliary templates substitute `{{ app.name }}` only; per-file engines and whole-file conditional/iteration blocks are not available and the reserved `when`/`engine` keys are rejected (§8.8.2). Recipes MUST NOT call shell or filesystem functions.

#### 8.8.7 File manifest semantics

One read-only preparation (`prepareRecipeInit`) consumes the compiled artifact exactly once and yields either `requires-input` with the missing option names or a `ready` plan carrying every static output's destination, exact candidate bytes, safe mode, and digest, plus conflicts, skips, diagnostics, and authorized actions. Preparation creates no destination directories, locks, stages, or journals and contacts no provider. Validate, describe, and init share the same compilation and preparation stages. Validate and describe expose `initializable`, `readiness` (`ready`, `requires-input`, `conflict`), `missingAnswers`, `historyEligible`, and `preview` through their canonical result schemas with no additional flags. Their preview uses default answers, an app name derived from the current directory, and the current directory as destination; init returns the preview prepared for its actual name, answers, and destination, so different inputs produce a different preview. Missing required options are readiness, not source invalidity. Duplicate destinations, unsafe modes, Landofile-basename destinations, and undecodable templates fail preparation without writing.

Init MUST collect all recipe answers before its single decomposition/encoding preparation. Name-prompt chrome MAY display deterministic machine-name normalization but MUST NOT prepare a provisional scaffold or derive URLs on each keystroke. The prepared plan retains the final validated typed authoring source as well as exact output bytes; presentation MUST consume an immutable, detached projection of that same plan rather than parse serialized output or prepare it again. Review data MUST NOT expose raw secret answers, output contents, or mutable execution inputs.

An interactive human consumer MAY present a compact summary after preparation and before publication progress. It identifies the effective destination, write/skip inventory, services, and provisional explicit-route URL candidates; candidate generation uses final app/recipe facts and the invocation's routing configuration, never provider discovery or inferred service-type endpoints. The projection distinguishes concrete candidates, no explicit route, unresolved intent, disabled routing, and unavailable context without claiming runtime ports or reachability. A clean initialization continues without an extra generic approval prompt. When existing scaffold files reduce the result to Landofile-only creation, the interactive consumer MUST explain the withheld scaffold/actions and ask once with a negative default. Decline or interruption before publication leaves the target unmodified. Existing Landofiles remain hard conflicts. `--yes`, non-interactive or machine invocations, and fully supplied questionnaires MUST NOT invoke human summary, routing projection, or summary-specific configuration access. Existing unattended conflict/skip policy remains unchanged.

An awaited presentation hook MUST run before destination creation, locks, transaction staging, journaling, or post-init work. Publication attempts the same prepared outputs and MUST NOT silently recompute a different inventory after presentation; the existing transaction preconditions still decide late conflicts. Presentation failures and cancellation propagate without being downgraded to optional URL diagnostics. No transaction lock is held across human interaction.

Contextual confirmations MUST preserve the preceding decision context. When the rich prompt driver cannot do so through supported inline rendering, it declines confirmation controls to the existing buffered line path; the same interaction service, reader, defaults, and cancellation remain authoritative. Rich controls MUST NOT recover context through private cursor-origin APIs or a second stdin reader.

Publication commits the Landofile and all authorized auxiliary outputs in one journaled create-only `ManagedFileService` transaction (§12.3): absence is intrinsic, a present path is a conflict, requested modes are applied on POSIX (default `0644`) and only the owner-write bit on Windows, and missing parents are created parent-first. An existing Landofile fails with `InitTargetExistsError`; any existing auxiliary member skips the whole auxiliary set and effectful post-init actions and is reported. The create set is sequentially recoverable, not all-files-atomic: a late conflict or interruption MAY leave a published prefix, MUST fail with a truthful receipt naming the transaction id and state, MUST NOT overwrite the occupant, and MUST NOT claim rollback. Recovery rolls the journal forward or reports it blocked.

#### 8.8.8 Post-init actions

Actions run in order only after the static create transaction (§8.8.7) and required metadata publication (§8.8.13) succeed. Their external effects are not part of transaction recovery and are never rolled back; a failing action reports the committed Landofile and auxiliary files with `rolledBack: false`. Named `postInit.stdin` and `postInit.secretEnv.<name>` bindings identify prompt and action without serializing raw answers.

| Action | Contract |
|---|---|
| `gitInit` | Reserved; preparation rejects it before any output is committed until an implementation ships (issue #1851) |
| `message` | Emit renderer-aware expression text |
| `command` | Invoke a `recipePostInitAllowed` canonical command at its bootstrap level |
| `bun` | Bounded recipe Bun action (`verb: script\|install\|add\|create\|run\|x`) through the private Bun self-execution wrapper (§8.2.4) under recipe action and path restrictions; not the transparent `meta:bun` proxy |

`command` actions MAY bind named `stdin` and `secretEnv`. Bun verbs use their declared shapes: `script` plus argv, `install`, `add` dependency groups, `create` template/destination, package-script `run`, and package-spec `x`.

The initial generated `postInit.command` allowlist is `app:config:translate` and `app:start`. Start requires explicit opt-in and MUST NOT be the default. Plugin installation, updates, setup, global config, shell integration, and arbitrary tooling are forbidden.

All Bun actions are destination-bounded, redacted, and shape-validated by the recipe post-init runtime, not by blanket proxy verb checks in the wrapper. "Bounded" here means action and path restrictions; the output byte budget of §8.2.4 applies separately on top. Bun and command actions ignore ambient CLI stdin and accept only explicitly bound action input. The wrapper returns child exit codes as data; nonzero exits and path/argv violations produce internal `RecipePostInitError` values. Public initialization maps those failures to `RecipeInitPostInitError`, retaining the failed action, committed-file context, and `rolledBack: false`, not promising the low-level `kind` or child `exitCode`. Script contents MUST match their prepared digest immediately before invocation; changed content fails through that same public boundary. Interruption is Effect interruption of the init fiber: the running action is awaited to settlement and no tagged error is produced; committed or externally created files are not rolled back. Network-capable Bun verbs are the explicit recipe network exception and SHOULD be user-controllable. Arbitrary shell hooks are forbidden outside bounded `verb: script`.

#### 8.8.9 Init lifecycle

`apps:init` resolves sources and answers, acquires source bytes, merges source and recipe declarations, acquires their required nonsecret metadata, then prepares once against the effective destination after conflict decisions and optionally presents the immutable prepared review (§8.8.7). Under §8.8.13 it then places permitted source files, rechecks final-root inputs/conflicts, commits Landofiles and generated translation fragments together through §12.4.1, publishes required final-identity metadata, writes auxiliaries, and runs post-init actions. It publishes canonical `apps:init` lifecycle events. Optional `app:start` is a separate nested command only after those prerequisites succeed.

#### 8.8.10 Canonical recipes shipped in core

| Recipe | Stack |
|---|---|
| `wordpress` | WordPress, PHP, MariaDB, optional Redis; appserver `uploadDirs: [wp-content/uploads]` |
| `drupal` | Drupal, PHP, MariaDB or PostgreSQL, Drush; Apache appserver or nginx edge defaults to `uploadDirs: [sites/*/files]` |
| `drupal-cms` | Drupal CMS starter on `drupal`; shares both webserver upload protection defaults |
| `laravel` | Laravel, PHP, SQL, Redis, optional worker; appserver `uploadDirs: [storage]` beneath webroot `public` |
| `symfony` | Symfony, PHP, PostgreSQL or MariaDB, Redis |
| `backdrop` | Backdrop on `lamp`; appserver `uploadDirs: [files]` |
| `joomla` | Joomla on `lamp`; appserver `uploadDirs: [images]` |
| `mean` | Node, MongoDB, optional Redis |
| `lamp` | Apache, PHP, MariaDB |
| `lemp` | nginx, PHP-FPM, MariaDB |
| `toolbox` | Disposable version-pinned CLI service with non-interactive defaults |
| `rails` | Rails, PostgreSQL, Redis |

Bundled recipes are authored as `RecipeSource` values, compiled at codegen through the same source compiler as external recipes into inert generated manifests and a cold catalog, and ship `README.mdx` under `recipes/<id>/`. Generated artifacts contain no callable logic and no handwritten snapshot, digest, or fragment twins. The set MAY grow in a minor release; removal requires a major version and `DeprecationNotice` (§18). Generated Landofiles MUST be YAML.

The catalog also ships `node-api`, `node-postgres`, `node-ts`, `astro`, `sveltekit`, `nextjs`, `django`, `fastapi`, `jekyll`, `hugo`, `eleventy`, and `empty`, for 24 bundled recipes in total. Hoster recipes require a `RemoteSource` implementation (§10.12); Lando 3 compatibility shims remain out of scope. The bundled `rails` recipe includes `rails` and `bundle` tooling, gives every prompt a non-interactive default, and requires an executable README under `recipes/rails/`.

#### 8.8.11 Recipe authoring surface

Recipes are independently versioned plain directories. `meta:recipes:validate` and `meta:recipes:describe` resolve, compile, and prepare a source read-only (§8.8.7), reporting readiness, missing answers, history eligibility, and the preview without init. Authors MAY publish through local, git, npm, or future registry sources.

#### 8.8.12 Constraints

Declarative recipes MUST NOT execute arbitrary code, install plugins, mutate global config or `<userConfRoot>`, or contact the network outside source resolution and explicit bounded post-init actions. They write only within destination. Provenance remains inert during ordinary loading; explain and migrate MAY consult matched declarative snapshots only.

#### 8.8.13 Init sources beyond recipes

This section is the deferred application-code/source-layering contract, distinct from current remote recipe acquisition. Its auth, metadata, namespaced prompts, and placement phases are not implemented by the recipe-source redesign; they remain tracked with pluggable init sources in issue #1526.

`InitSource` (§4.2) supplies the material a recipe is layered onto: the built-in `cwd`, `git`, and `tarball` sources, and plugin sources contributed under `provides.initSources[]` as `{ id, module, summary }`, typically one per hoster. Source files precede recipe files; recipe files win according to conflict policy. Source and recipe validation MUST succeed before Landofile commit. Init sources MUST NOT plan or contact a provider.

The contract is `id`, `summary`, `prompts`, optional `auth`, optional `choices`, and `resolve`:

- `prompts` is an ordered list of §8.8.5 prompt definitions. Core collects them through `InteractionService` under the §8.8.1 answer rules, with ids namespaced `source.<prompt>` so `--answer source.site=...` and `--answers` address them beside recipe answers. A secret-typed prompt yields a credential reference in `answers`, never a raw value.
- `auth(ctx)` is the optional source-auth phase. When required, it runs before authenticated choices or acquisition, shares the `RemoteSource.setup` logic and context (§10.12.3), and returns the credential references later phases use. It is the only init phase that may open a browser or write a credential. Non-interactive authenticated sources MUST reuse an existing authorized reference or fail with `InitSourceAuthError` before network or browser activity. Local and public unauthenticated sources MUST work without credential references or an auth phase, including with `--no-interactive`.
- `choices(promptId, answers)` resolves dynamic options (site, application, or project lists) through `HttpClient` with those references. Results are bounded and render through the §8.8.5 `select` type; a source with no dynamic prompts omits it.
- `resolve(answers)` returns `InitSourceResolution`: `code` as a `CodeLocator` (§10.12.1), an `ArchiveLocator` (`url`, `checksum`, `archiveFormat`), or `none` for an existing checkout; an optional `LandofileAuthoringFragment` carrying the recipe choice and options, `remotes:`, `sync:`, and `translate:` entries; and nothing else. It MUST NOT return raw secrets, and core normalizes the fragment into the authoring merge exactly once beneath recipe output.
- Core acquires source bytes with host Git or `Downloader`. SSH locators use §10.4 identity and host verification; HTTPS follows §10.3.1 TLS/proxy policy without requiring an SSH agent. Public/local sources need no credential reference. New source bytes stage under `<userCacheRoot>/init/<id>/`; existing-checkout sources are inspected in place, never relocated.
- After acquisition and the source/recipe declaration merge, core MUST acquire required nonsecret metadata through `RemoteSource.metadata` BEFORE translation, fingerprinting, or output preview, using the existing auth context without a second login or remote-resource creation. Missing inputs/metadata or fetch failure MUST stop before preview and placement with `ConfigRefreshError`; sources without metadata-dependent translations skip acquisition and remain credential-free where applicable.
- With that metadata available, core MUST preview the source/recipe merge and newly emitted `translate:` entries before destination placement. It MUST canonically encode, parse, materialize, and validate candidate bytes against bounded source and metadata snapshots (§7.4.2), not inject translator objects into runtime loading. The acquisition tree MUST contain no generated managed files, ownership ledger, transaction stages, backups, or journal. This preview stays at `plugins` bootstrap and contacts no runtime provider.
- Preview MUST apply the existing destination conflict policy: occupied Landofile targets fail, scaffold conflicts skip the scaffold set, and pre-existing/adopted files are not silently overwritten. A required generated output that cannot be committed MUST fail init. After preview, core MAY place only permitted source files, establish the final canonical app root, and recheck final inputs and conflicts; a change since preview MUST fail without overwriting it.
- Only then MUST core commit generated fragments and Landofiles together through the final-root §12.4.1 transaction. Transaction inputs, backups, journals, and ownership records MUST use final-root identities and paths, never acquisition-cache paths; no path-bound recovery state is relocated. Required metadata MUST be published under the final destination's app/source/config/remote/environment/branch identity before auxiliaries, any post-init action (including optional start), or success. First-start translation MUST need no vendor fetch; ordinary runtime/image/build acquisition still follows §12.6.
- A failure after source placement MUST return typed failure context containing a redacted side-effect receipt: retained source paths, actual generated-file transaction/recovery state, metadata publication, auxiliaries, and auth effects as applicable. It MUST NOT claim whole-init rollback or successful metadata-ready initialization. In particular, metadata publication failure after generated-file commit is failed init with retained committed state.
- Credentials stored and keys registered by `auth` are reported in the init receipt as side effects; a later scaffold failure MUST NOT claim to roll them back.

Events are `pre-init-source-auth`, `post-init-source-auth`, `pre-init-source-acquire`, and `post-init-source-acquire`. Tagged errors are `InitSourceError`, `InitSourceAuthError`, and `InitSourceAcquireError`. `TestInitSource` and `runInitSourceContract` support contract testing.

#### 8.8.14 Programmatic recipes (`recipe.ts`)

`recipe.ts` is mutually exclusive with `recipe.yml`. It default-exports a static `RecipeSource` or async `RecipeContext -> RecipeSource`, optionally wrapped by `defineRecipe` from `@lando/sdk/schema`; the value decodes through the same strict `RecipeSource` schema and compiler as YAML. Local `recipe.ts` is initializable and may be a local parent; because the ancestry evaluated code, `historyEligible` is false (§8.8.3). Remote sources never evaluate `recipe.ts`. Evaluation uses the host-owned modules in §7.1.1 without a local SDK or Effect install; other bare packages resolve beside the author file.

The current factory context supplies only `cwd` and `env`; `ctx.prompt`, `ctx.run`, and `ctx.fetch` are deferred capabilities tracked in issue #1851, not callable APIs. Questions belong in authored option declarations and bounded effects belong in `postInit`. Local TypeScript executes trusted author code on the host. Import scanning and evaluation timeouts are boundary checks, not a security sandbox; authors MUST NOT use factories for top-level effects, arbitrary shell, plugin/global mutation, or network access. Raw init-only secrets remain outside factory data.

Evaluation is bounded by `LANDO_RECIPE_TS_TIMEOUT_MS` (default 30000 ms) and happens once per acquisition; resolution and compilation reuse the evaluated value. Factories MUST NOT broaden post-init destination permissions or bypass `RecipeSource` validation.

Describe, validate, and init evaluate the import-scanned module on the host; a disallowed import fails with `RecipeManifestParseError` before module execution. A missing default export also fails with `RecipeManifestParseError`, while an evaluated but invalid source fails with `RecipeManifestValidationError`. Programmatic recipes otherwise share all source, destination, preparation, post-init, and constraint rules. Explain and migration MUST NOT execute recipe code.

#### 8.8.15 Recipe composition (`extends:`)

`extends:` accepts any recipe reference and provides bounded, acyclic single inheritance over authored sources. The child inherits the parent's actual `config` and `variants`: parent base and variants execute before child base and variants in the compiled layer sequence (§8.8.3), so a child declares only what differs and never restates the parent's output. Options replace by name with `{ drop: true }` removal; files replace or drop by destination; post-init appends parent-first; child scalars win. Inherited `files` and `postInit` entries retain their declaring origin (bundled recipe id or source directory) as explicit per-entry data, so their sources resolve against the declaring recipe tree, and after a remote hop further parents stay inside that acquired tree and load YAML only. Resolution yields ordered parent content evidence; the child's derived identity is its own and incorporates parent producers (§8.8.3). A missing parent, escape from the acquisition root, or cycle fails with `RecipeExtendsError`. Programmatic recipes MAY return `extends:`.

#### 8.8.16 Recipe option parity

`drupal` MUST offer supported Drupal, PHP, webserver, database/version, webroot, and Composer choices, with project-local Drush. `drupal-cms` inherits that surface and serves the real scaffold docroot. `lamp` MUST offer database/version, PHP, Composer, and webroot choices. Every prompt has a non-interactive default, and each `README.mdx` exercises a non-default variant (§19.13).

Recipe and init failures preserve these schema-backed `_tag` values:

| `_tag` | Boundary |
|---|---|
| `InitTargetExistsError` | Landofile destination already exists |
| `RecipeSourceError` | Source acquisition failed; `kind` names the cause (`clone-failed`, `auth`, `subpath-invalid`, `subpath-missing`, `cache`, `unsupported-source`, `missing-url`, `missing-package`, `download-failed`, `checksum-mismatch`, `checksum-unverified`, `extract-failed`, `registry-failed`, `package-not-found`, `version-not-found`, `integrity-mismatch`, `integrity-missing`, `missing-id`, `recipe-not-found`, `registry-invalid`) |
| `RecipeManifestNotFoundError` | Resolved source has no `recipe.yml` or `recipe.ts` |
| `RecipeManifestParseError` | Manifest text or module fails to parse, has a disallowed import, or lacks a default export |
| `RecipeManifestValidationError` | Decoded manifest, authoring, Landofile, or auxiliary output invalid; carries `issues` |
| `RecipeExtendsError` | Parent missing, escape from the acquisition root, cycle, or depth (`kind`: `parent-not-found`, `cycle`, `depth`) |
| `RecipeMissingAnswerError` | Required answer absent; aliases `InteractionRequiredError` |
| `RecipeRunNotAllowedError` | Programmatic command outside `runs`; carries `commandId` and `allowlist` |
| `RecipeFetchNotAllowedError` | URL outside `fetchAllowlist`; carries `url`, `allowlist`, and `viaRedirect` when a redirect left the allowlist |
| `RecipeInitBlockedError` | Preparation blocked at `secret-prompts`, `translate`, `validate`, `encode`, or `diagnostics`; no scaffold written |
| `RecipeInitCommitError` | Destination changed or static publication failed (`phase`, `reason`, optional transaction id and state); no post-init action ran and published files are not rolled back |
| `RecipeInitPostInitError` | Public post-init failure, including bounded Bun failures and changed prepared scripts; retains failed-action and committed-file context with `rolledBack: false` |

Cancellation is Effect interruption, not a tagged error: the in-flight acquisition or post-init action is awaited to settlement, the source-store lease is released with the scope, and committed files are not rolled back.

Recipe persisted locations are `recipes/<id>/` and the §12.8 source store, `<userCacheRoot>/sources/git/<commit>/` and `<userCacheRoot>/sources/archive/<sha256>/` (npm tarballs included). Compiled manifests, generated Landofiles, and derived snapshots MUST remain independent of provider state.

### 8.9 Renderers and messages

The Effect service tag `Renderer` has `id`, current `RendererCapabilities`, `render(Stream<RenderEvent>)`, and immediate first-paint emission. `RendererCapabilities` is the schema-backed boolean set `color`, `interactive`, `animation`, and `notifications`.

Named renderer contracts include `Renderer`, `RendererCapabilities`, `RenderEvent`, `ImmediateLine`, and `RenderError`.

`Renderer.output.stdout` and `stderr` MUST accept `string | Uint8Array` and own all payload writes. Full `RendererIO` writers accept the same union; narration IO remains text-only. Byte writes MUST preserve the original bytes without decoding or newline translation. Terminal payloads on either fd MUST suspend and erase the stderr live region before writing, then repaint when the payload line is complete. The stream sink MUST use only the Renderer output channel, never raw IO. The closed-pipe guard and shared-descriptor restore (§8.11.2) are fixed process-level policy in `@lando/renderer`, not behavior a `Renderer` plugin supplies or replaces.

The default `lando` renderer MUST publish a fixed immutable capability snapshot synchronously at construction: `RENDERER_CAPABILITIES_TTY` (all four fields true) when the stderr narration terminal is a TTY, with `color` false when the host opts out of color, otherwise `RENDERER_CAPABILITIES_NONE` (all four false). `RendererNarrationIO.isTTY`, terminal columns/rows, and terminal stream MUST describe stderr. Event consumers MUST receive narration-only IO without stdout writers. `RendererIO` MUST add stdout writers and separate stdout TTY/width metadata for result formatting. Capability resolution MUST NOT import OpenTUI, probe the substrate or terminal, delay first output, or keep the process alive after command completion. OpenTUI presentation failure falls back to line mode (§8.9.3) without changing this snapshot. `plain` and `json` expose all four fields false; stderr-TTY `verbose` exposes color only, and nothing when the host opts out of color.

The host opts out of color when `NO_COLOR` holds any non-empty value or `TERM` is `dumb`; `FORCE_COLOR` does not override either. The IO boundary resolves this once and carries it as `RendererNarrationIO.noColor`; renderers and result painters MUST read that fact and MUST NOT re-read the environment. Narration color follows the `color` capability. Result decoration keys on stdout and is colored only when stdout is a TTY, the renderer is `lando`, and the host has not opted out. When color is off, renderer-owned chrome (task trees, notices, result summaries, help, prompt chrome) MUST NOT emit chromatic SGR (foreground or background color selections); default-color resets, bold, and dim MAY remain, and no state MAY rely on color alone. OSC 8 hyperlinks follow the same opt-out. Tool payload bytes are never rewritten. A TTY container exec receives `NO_COLOR=1` when the host opted out, unless the service or explicit environment already defines `NO_COLOR`. `TERM=dumb` additionally selects `lando` append-only line mode, as a stdout pipe does.

Third-party renderers MUST use immutable capability snapshots and MAY replace them only by monotonic promotion. Callers MUST reread capabilities at use time to support those renderers; events dropped before promotion MUST NOT be replayed. Third-party capability resolution MUST NOT delay first output or process exit.

Built-in `RenderEvent` names are:

| Family | Events |
|---|---|
| Tasks | `task.start`, `task.progress`, `task.complete`, `task.fail`, `task.tree.start`, `task.tree.complete`, `task.detail`, `task.detail.expand`, `task.detail.collapse` |
| Logs/messages | `log.line`, `message.info`, `message.warn`, `message.error` |
| Tables/prompts | `table.row`, `table.end`, `prompt.start`, `prompt.complete` |
| Presentation | `paint.banner`, `code.snippet`, `diff.render`, `markdown.block`, `notify.desktop` |

`task.tree.start` identifies parent, label, children, and optional layout mode. `task.detail` identifies task, stdout/stderr stream, and line. Detail expand/collapse are renderer input events, not caller output events.

The default renderer is plugin `@lando/renderer-lando`, id `lando`. Core fallbacks are `json`, `plain`, and `verbose`. Selection precedence MUST be `--renderer` → `LANDO_RENDERER` → global `renderer:` → default `lando`, including non-TTY and CI. The `lando` renderer MUST degrade to line mode when stderr is not a terminal. Redirecting stdout to a regular file MUST NOT disable the live tree; a pipe or socket on stdout selects line mode (§8.9.2). Typed messages and schemas are published from `@lando/sdk`.

#### 8.9.1 First-paint contract

Renderers MUST meet §2.1 policy:

| Event | Requirement |
|---|---|
| Pre-bootstrap banner | One line within 50 ms cold, before plugin import for bootstrap ≥ `plugins` |
| TTY events | Flush as they arrive; only structured single-document output MAY buffer |
| Table first paint | Headers by first row within 80 ms cold |
| Spinner | Show after 100 ms without progress; avoid shorter flashes |
| Completion | Final line within 50 ms of terminal event |
| Level-`none` fast path | Direct native output without `Renderer`; dispatcher-routed `none` commands may use the normal renderer boundary |

The tiny pre-renderer MUST NOT import Effect, OCLIF, renderer services, or plugins and is the only pre-Layer direct-output path. Renderer construction consumes synthetic `paint.banner` state to avoid duplication. Non-TTY output has no spinners; tables MAY buffer, but first-byte budgets remain. All narration, including live regions and every `message.*` contract, MUST use stderr. stdout MUST carry only command results, envelopes, stream frames, and tool payloads; when a CLI-granted data payload owns stdout, machine envelopes, frames, and `--jq` output MUST instead use stderr. A terminal stdout payload MUST suspend and erase the stderr live frame, write the original payload bytes to stdout, then repaint on stderr. A redirected stdout payload MUST NOT interact with the live frame. Result decoration and table width MUST use the destination's TTY state and dimensions (stdout normally, stderr for machine output accompanying a granted stdout payload). Non-streaming JSON emits one envelope on that destination; streaming JSON follows §8.11.3. In human result formats, the `json` renderer emits structured stderr events, with a first stderr event inside the meaningful-line budget; machine result formats keep its event narration off stderr and carry streamed events as §8.11.3 event frames.

#### 8.9.2 Concurrent task tree contract

`task.tree.start`/`complete` bracket concurrent children. TTY renderers MUST show the live tree and alternate-screen full-tail on stderr. When stdout is a pipe or socket, the `lando` renderer MUST use append-only line mode instead, because the consuming process may write to the same terminal and a repaint would erase its output. They show parent/child state, recent per-task `task.detail`, success/failure summaries, focus navigation, and Enter/Escape expand/collapse. Keyboard input MUST come from stdin only when stdin is a TTY. Expanded full-tail view uses persisted §6.13.6/§12.4 transcripts and MUST preserve cancellation and restore the tree. It remains available after completion. Renderers publish `task.detail.expand` and `task.detail.collapse` through `EventService`. `task.complete` outcomes are `ok`, `warn`, and `info`; `info` is a neutral completion for results the user owns (app-owned check verdicts, §10.5.2) and MUST NOT be painted as success or warning. A tree settles on every exit of its work, including defects. Settling a failed or interrupted tree fails only the children that started and had not finished; children that never started stay pending and drop out of the final frame instead of inheriting the tree's failure. A producer that cancels queued work it owns MAY settle those children itself with an explicit summary, as build does with `aborted`; the child whose own work failed, including before it started, settles as failed, never aborted. `task.tree.complete` carries `outcome: "failure"` or `"interrupted"` whenever a child failed or the tree's work failed or was interrupted, so a tree whose failure happened outside every child still ends as failed, never "done"; an absent outcome means success.

A command that hands the terminal to a foreground child (`apps:scratch:run`, keyboard-attached tooling, or a keyboard-mode `.bun.sh` script) first retires that invocation's event-rendering consumer and waits for it: delivered events render in order, any open tree paints as a final static frame, and renderer input, the live region, and output interception are released before the child's first byte or keystroke. Tooling MUST publish its task tree whenever `EventService` exists; the CLI retires its consumer before keyboard-attached tooling publishes that tree. The handoff is one-way; later events in that invocation are not repainted, and the `Renderer` output service stays usable for the child's raw output.

In human-result formats, `lando` line mode MUST emit stable-prefixed detail lines and tree summaries on stderr, without input handling or an alternate screen. `json` emits structured task events on stderr. `plain` MUST emit flat renderable event lines on stderr for every renderable event, without a tooling-only detail-only filter. Lifecycle event steps that run outside a tooling bracket are narration: their redacted output publishes as `task.detail` on stderr. Tool body bytes of tooling, exec, scratch runs, and scripts use the unified sink (§8.2), not per-line `task.detail` publication. Output already delivered through a live sink MUST NOT be duplicated as narration. `verbose` MUST emit human lines and full event payloads on stderr; framed JSON streams carry events as §8.11.3 event frames instead. All renderer `message.*` narration MUST use stderr, including scrollback committed above an attached live region. Publishers redact `task.detail` when it is used (build transcripts and expanded full-tail); local transcript full-tail is not exported to telemetry, guide transcripts, or JSON. Ctrl+C MUST interrupt every in-flight child and MUST NOT be swallowed in expanded view.

#### 8.9.3 Default renderer implementation contract

`@lando/renderer-lando` uses `@opentui/core` for TTY rendering; the selected release is pinned in the package manifest and lockfile (§2).

- Production code MUST use the literal dynamic import `import("@opentui/core")` inside the renderer plugin.
- Core, level-`none`, pre-renderer, non-TTY, `plain`, and `json` paths MUST NOT load it.
- Renderer tests MAY statically import `@opentui/core/testing`.

Initialization failure MUST degrade to non-TTY line mode with a debug notice and MUST NOT fail the command or contaminate machine output. Task trees MUST paint inline on stderr with atomic frames, native scrollback, and resize replay. OpenTUI MUST use the stderr WriteStream for the expanded alternate-screen full-tail and prompt driver; custom-stream resize MUST be forwarded explicitly. OpenTUI is acquired lazily, and retirement (§8.9.2) leaves the final inline frame static. Animation runs only while needed and is capped at 30 fps. Prompt chrome uses the same substrate without changing `InteractionService` contracts. Headless frame snapshots cover task transitions, all prompt types, narrow terminals, and resize.

#### 8.9.4 Rich render events

`CodeSnippetEvent` (`code.snippet`) carries code plus optional language, path, start line, and highlighted lines. `DiffRenderEvent` (`diff.render`) carries unified diff plus optional path/language. `MarkdownBlockEvent` (`markdown.block`) carries Markdown. These schemas are stable public contracts; rich TTY presentation and core emitters build on them without a schema change.

Without rich presentation, and in degraded/plain modes, renderers emit safe verbatim forms; JSON passes structured events. Publishers MUST redact content. Plain unified diffs MUST remain patch-applicable. Unknown languages fall back to plain text.

#### 8.9.5 Renderer panel slots

Renderer panel schemas are stable public contracts; default-renderer runtime support and bundled consumers build on them without a schema change. Published schema contracts are:

- `RendererPanelSlot`: closed ids `status-bar`, `task-tree:footer`, `doctor:summary`.
- `RendererPanelId`: validated plugin-scoped id.
- `RendererPanelWatch`: bounded unique closed-event list.
- `RendererPanelManifestEntry`: `id`, `slot`, `watch`, contained relative `module`.
- `StyledSpanTone`: `default`, `muted`, `accent`, `success`, `warning`, `danger`.
- `StyledSpan`, bounded `PanelView`, positive `RendererPanelSize`, and `RendererPanelContext` using optional `AppRef`, size, and `LandoEvent`.
- `RendererPanel`: matching `id` and pure synchronous `render(RendererPanelContext) -> PanelView`.

`RendererPanelManifestEntry.watch` is manifest metadata so the loader can decide whether to import. `StyledSpan` exposes text, tone, bold, dim, italic, and underline. `PanelView` is bounded schema data; validation failure drops the panel rather than truncating it.

Plugins contribute `rendererPanels:` (§9.5). Manifest shape, ids, slots, watch events, and module containment validate before import; failures are `PluginManifestError`. Panels import only in isolated workers when their slot becomes visible. Export failures, identity mismatch, or load failure are `PluginLoadError`. Runtime/decode/bound failures isolate and permanently drop only that panel with a debug notice; malformed output MUST NOT be clipped into validity. Panels are output-only, have no terminal/input control, and consume already-redacted events. Untrusted panels use standard plugin trust.

The panel runtime MUST enforce bounded worker startup, binary messages, render deadlines, one in-flight render, coalescing, and last-good view retention without blocking the render loop. The `@lando/sdk/test` Renderer panel contract suite proves timeout, throw, invalid output, purity, determinism, and bounds in a terminable worker. It is a §13.1 shared suite, not one of the §4.2 six plugin-abstraction kit suites.

#### 8.9.6 Keymap: renderer actions and bindings

The closed action vocabulary and defaults are stable; global `keymap:` overrides and the help overlay build on them without adding actions.

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

Published schemas are `RendererActionId`, `RendererKeyName`, `RendererKeyChordPattern`, `RendererKeyChord`, `RendererKeyBinding`, and `KeymapConfig`. Chords use canonical lowercase modifier order `ctrl+`, `alt+`, `shift+` and a closed key vocabulary. Each action has a bounded unique chord list. Malformed bindings fail ordinary `ConfigError`. While the renderer owns keyboard input, `ctrl+c` is permanently reserved for `Effect.interrupt` and cannot be bound, disabled, or shadowed.

Same-surface chord collisions fail after schema decode with `KeymapConflictError`, carrying `_tag: "KeymapConflictError"`, `surface`, `chord`, sorted `actions`, `message`, and `remediation`. Cross-surface reuse is valid. Plugins cannot add actions. Non-TTY binds nothing.

#### 8.9.7 Desktop notifications

`NotifyDesktopEvent` (`notify.desktop`) carries nonempty `title`, optional `body`, and optional urgency `info|success|failure`. Publishers MUST redact content. The renderer sanitizes line/control and bidi characters, normalizes Unicode NFC, drops empty results, and realizes notifications only when current `RendererCapabilities.notifications` is true. JSON passes the structured event; plain/non-TTY drops it.

The default TTY renderer MUST emit sanitized OSC 99 frames through the stderr writer of `RendererNarrationIO`, without importing OpenTUI, constructing a `CliRenderer`, querying the terminal, or waiting for a terminal response. Its `notifications` capability declares an available emission path, not detected terminal support; unsupported terminals ignore the frames. Notification presentation MUST NOT depend on OpenTUI availability or stdout TTY state.

Bundled plugin `@lando/notify-lando` owns policy through `NotifyConfig` at global `notify:` with `enabled` default true, `thresholdMs` default 15000, and bounded additional canonical `commands`. The default eligible family is ordered: `app:start`, `app:stop`, `app:restart`, `app:rebuild`, `app:destroy`, `meta:setup`, `meta:update`. Config ids validate against the cwd-independent global registry, then deduplicate in first-occurrence order. Unknown ids return `ConfigError`.

Only the outer invocation qualifies, at `durationMs >= thresholdMs`, once per run, on success or failure. Nested canonical calls never notify independently. Lower-tier eligible commands promote to bootstrap `commands` except `app:config:describe`, `meta:global:config:describe`, `meta:doctor`, `meta:config`, `meta:version`, `meta:shellenv`, and `meta:uninstall`, which keep their declared bootstraps and cannot notify. Promotion raises the bootstrap level only; it never loads the current Landofile, so Landofile mutation commands need no exemption (§8.2.1). The subscriber priority is **900**. `notify.enabled: false`, plugin disablement, non-TTY, or missing capability silences presentation. Container-initiated notification or clipboard relay is a non-goal (§10.10).

#### 8.9.8 Interactive log viewer

The `app:logs --follow` TTY viewer contract is stable. It consumes the same redacted labeled `LogChunk` stream and selectors as line mode, adds bounded scrollback and source filtering, starts following, unsticks on scroll, and uses `viewer.*` actions. Exit leaves visible logs in normal scrollback. `--no-viewer`, non-TTY, `plain`, and `json` force byte-identical line mode. While the default renderer has no viewer, `--no-viewer` is accepted as a no-op; the viewer introduces no new schema.

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

Per prompt precedence is explicit answers → defaults when `--yes` or non-interactive → interactive prompt → `InteractionRequiredError`. `auto` is interactive only with TTY stdin and stderr; `--interactive` forces prompting; when stdin or stderr is not a TTY it uses line input. Prompt text and controls MUST use stderr; redirecting stdout MUST NOT disable prompts. CI and non-interactive fail-fast behavior MUST remain intact. CLI defaults to `auto`; library mode defaults non-interactive (§16.3).

One shared parser owns repeated `--answer`, `--answers`, `--yes`, `--no-interactive`, and `--interactive` for both entries. Scratch `--option` merges into the same answer source (§21.10.1).

The `--yes` flag and its `-y` short form follow §8.3.1.

#### 8.10.4 Required behaviors

The core `InteractionService` implementation layer requirements:

- Construct lazily through `Layer.suspend`.
- Touch no input for commands that never prompt.
- Require no network, provider, or plugin at bootstrap `minimal`.
- Never echo secrets or place them in transcripts, logs, or errors.
- Fail fast for missing non-interactive answers.
- Route prompt chrome through `Renderer` when present and use only the declared no-renderer fallback carve-out.

Interruption returns `InteractionCancelledError` after restoring terminal state. Dynamic choices use the allowed canonical runner; failures return `ChoicesUnavailableError` with interactive fallback. Mid-build prompting and an `Interaction` lifecycle scope are non-goals.

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

Published schemas are `CommandResultFormat` (`text|json|table|yaml|ndjson`), `FailureRole`, `CommandWarning`, `CommandCompletion`, `CommandOutputChunk`, `CommandOutput`, and `CommandResultEnvelope`.

**Advertised formats.** `text`, `json`, and `yaml` are universal and are attached to every command's `--format` flag. `table` and `ndjson` are opt-in render-path values declared through the command's `resultFormats`. Help, the generated command-registry manifest, and the MCP catalog projection MUST show exactly the supported set. A command that does not advertise a value MUST reject it with `RendererSelectionError` rather than silently emit text. Advertisement and implementation MUST agree on every surface. `text` is the default.

| Envelope field | Contract |
|---|---|
| `apiVersion` | Literal `v4`; changes only for a breaking envelope revision |
| `command` | Canonical command id |
| `ok` | Success discriminator |
| `result` | Optional command `resultSchema` value |
| `error` | Optional primary `TaggedErrorJson`; non-empty `error.additionalErrors` carries ordered, non-recursive additional tagged failures with required `role` |
| `error.cause` | Optional recursively projected wrapped tagged failure, retaining its message and diagnostic fields; omitted for non-tagged causes |
| `output` | Optional `CommandOutput`: bounded, redacted text chunks with channel/provenance and an explicit truncation flag; mandatory for completed MCP command responses; carries the collected child output of Bun-backed commands under `json`/`yaml` (§8.2.4) |
| `warnings` | `CommandWarning[]` |
| `deprecations` | `DeprecationUse[]` |

Payloadless commands return an empty result object.

Unsuccessful process completion MUST retain its schema-encoded `result` alongside `error`, with `ok: false`; result-key projection and result-derived redaction tokens apply to that retained value too. CLI output uses its ordinary result renderer rather than presenting an expected nonzero child exit as an internal Lando defect. Effect-native library operations keep their existing typed results and failure channels (§16).

CLI and MCP failure envelopes MUST share one Cause projection. The primary is the first `Fail` reason without a failure role, otherwise the first such `Die`, otherwise the first `Fail`, otherwise the first `Die`, otherwise the squashed Cause. Failure-role annotations take precedence over Cause order, which breaks ties within each category. Every other `Fail` and `Die` reason, in Cause order and excluding interruptions, is an additional error with a `role`: `rollback` (undoing the failed operation's partial work), `cleanup` (best-effort release, teardown, or bookkeeping), or `peer` (a sibling step in the same phase, and the default for unannotated reasons). Roles are reason annotations set only by the engine compensation helpers; error mappings and nested defect conversion MUST preserve every reason and its annotations.

`error.additionalErrors` is omitted when empty and never nests. Each entry is the additional error's `TaggedErrorJson` plus `role`, encoded and redacted like the primary. Additional errors MUST NOT change the primary's exit status. Human reports show the primary body and remediation, then one `Rollback also failed (<tag>)`, `Cleanup also failed (<tag>)`, or `Also failed (<tag>)` block per additional error with its body, indented continuation and remediation lines, and diagnostic fields that differ from the primary's, without stack traces. Interruption-only Causes follow the invocation surface's cancellation policy. Effect-native library results follow §16.7.

Primary and additional errors preserve `cause` only when it has own string `_tag` and `message` data properties. Cause projection uses the same diagnostic projection recursively, with a shared maximum of eight edges through `cause` and `failures`, omitting ancestor cycles. Projection MUST NOT invoke accessors or proxy traps and MUST omit stacks and raw mutation-conflict payloads (`existing` and `incoming`). Nested cause strings receive the same envelope redaction as the primary error. Human reports keep their outer-first raw-cause traversal and MUST NOT print the nested projected object as a second copy of its messages. The published `TaggedErrorJson` schema admits `cause` through its open additional keys rather than a dedicated property, so per-tool MCP output schemas stay within the discovery budget.

`CommandWarning` carries `code`, `message`, and optional `remediation`. Only a breaking envelope change may change `apiVersion`.

Every primary and additional `TaggedErrorJson` MUST carry `_tag`, `message`, and required nonblank `remediation`. Unknown failures and serialization fallbacks MUST also satisfy that schema with a specific diagnostic/reporting action. CLI human reports, JSON/YAML envelopes, and MCP MUST use one field-generic SDK diagnostic projection, not error-tag presentation branches. Human reports print a cause's message only when it adds a sentence the message lines have not already shown, and a cause's remediation only when it adds a sentence the remediation has not already shown. Human formatters MAY specialize by field name (`issues`, `failures`, `logTail`, `outputTail`); a `failures` array of tagged errors renders each member with its own path, location, message, nested `issues`, and remediation. Error-owned fields carry tag-specific human context such as a 1-based event step.

Defects at CLI presentation and MCP command-outcome boundaries MUST normalize to `LandoInternalError`, including routing, bootstrap, command, formatter, and finalizer failures. A defect that is already a tagged error with a message and nonblank remediation keeps its tag and remediation instead; only unexpected values (plain exceptions, strings, untagged objects) become internal errors. A primary defect exits `1`. Normal stdout/stderr MUST NOT contain stack traces, raw Causes, or `Cause.pretty` embedded in an exception message. Redacted pretty Causes go only to the existing opt-in debug diagnostic channel (`--debug`, structured stderr records); `--trace` supplies invocation timings. Remediation MUST name those flags, explain that debug records can be captured from stderr and runtime worker logs live under the reported `logsDir`, and say how to report the problem. The dependency-light entrypoint fallback remains for failures before dispatch or inside terminal emission.

Validation failures carry the collected `issues` (`ValidationIssue`: `path` as an array of keys and indexes, `message`, optional `rule`, optional `kind` (§7.8), optional `suggestion`, optional authored `source: { file, layer, path }`) in the envelope's `error`, and MCP results carry the same structure. The text renderer prints one line per issue as `<path>: <message>`, formatting the path with `formatValidationIssuePath` (`services.web.routes[0]`), subject to the stage boundaries in §7.8. A completed lint returns `ok: true` with `ConfigLintResult`, including `valid: false` and its `violations` when configuration errors were found; a failure that prevents that result uses the failure envelope.

#### 8.11.2 The single serialization seam

`encodeCommandResult` is the only JSON result serializer. It schema-encodes success or tagged failure, preserves exit status, wraps the envelope, and passes it through `RedactionService` before output. Per-command render helpers produce only human formats. §13.4 MUST reject any other command-result `JSON.stringify` path.

Outside the command-result boundary, an unrecoverable entrypoint failure MAY emit only a stderr diagnostic, redacted as §10.10.2 describes, and exit non-zero; it MUST NOT emit a partial stdout envelope.

`yaml` is boundary-owned: `--format=yaml` MUST emit the same envelope `--format=json` emits for that command, serialized through the `@lando/sdk/yaml` scalar and mapping-key policy, and parsing that YAML MUST yield the same model the JSON parses to. Redaction, `--json` projection, `--jq`, warning capture, and the closed-pipe policy apply to `yaml` exactly as to `json`; they share the command-result boundary. Every YAML projection MUST round-trip its input model, including strings YAML could reinterpret: the `[redacted]` sentinel, `yes`/`no`/`on`/`off`, numeric-looking strings, `null`/`~`, values containing `: `, and leading `*`, `&`, `%`, `@`. `@lando/sdk/yaml` is the one quoting policy; the CLI emitter and the shared Compose serializer owned by `@lando/container-runtime` consume it rather than re-implementing it. A command MAY declare a justified YAML `documentOutput` exception in its command metadata when its successful result is itself a product document; `app:config:translate` preview uses it to emit the target Landofile with diagnostic comments. Failures, JSON output, and runs using `--json` projection or `--jq` keep the canonical envelope.

**Closed pipe.** A downstream consumer that closes stdout or stderr early (`head`, `jq -e`, a terminated agent) ends output cleanly: Lando MUST NOT report an internal error or print a stack trace, MUST stop writing to the closed stream, and MUST exit with the conventional terminated-pipeline status `141`. stdout and stderr follow this rule independently, since they can be redirected separately. `@lando/renderer` owns the guard, so every renderer and machine format inherits it.

**Shared descriptors.** Lando's stdin, stdout, and stderr are often open file descriptions shared with the invoking shell and its other children (`exec > >(tee log) 2>&1`, `{ lando info; cmd; } | less`, CI log collectors). The runtime may switch a pipe to non-blocking mode while Lando runs, and a sibling that inherits that mode can fail its own writes with `EAGAIN`. On glibc Linux and macOS, the CLI MUST snapshot the `O_NONBLOCK` bit of descriptors 0–2 at startup, before anything acquires the process streams, and return each still-identical descriptor to that state on orderly exit, before a Lando-managed SIGINT/SIGTERM re-raise (§8.4.1), and before the self-update re-exec. Other file-status bits stay as they are. Concurrent writers during the run, uncatchable termination, and hosts whose C library cannot be loaded (restoration is then skipped, never an error) are outside this guarantee. `@lando/renderer` owns the snapshot and restore. The CLI has a single process-exit owner: it installs the snapshot before anything else runs, and every path that ends the process without the runtime's exit event (signal re-raise, self-update re-exec) MUST go through it so the restore runs first.

#### 8.11.3 Streaming commands

Live commands MUST treat `StreamFrameSink` as optional (`Effect.serviceOption`). YAML runs have no live sink and MUST collect output into the single result envelope.

One pure routing function decides where output goes from the renderer, result format, whether the command declares a frame schema, and whether it streams live; the boundary MUST NOT re-derive these choices elsewhere:

| Result format | Machine/result destination (stdout unless a granted payload owns it) | Events |
| --- | --- | --- |
| `json` (and `ndjson` once advertised, below), frame schema declared or live | NDJSON frames ending in one `result` frame | `event` frames on the same destination |
| `json` otherwise, and `yaml` | One envelope | `lando`: no narration (desktop notifications still realized); `plain`: none; `json`: `notify.desktop` records on stderr; `verbose`: full event dump on stderr |
| `text`, `table`, and `ndjson` a command renders itself (`meta:doctor`) | Rendered result and tool payload | Renderer narration on stderr: `lando` tree or lines, `plain` lines, `json` event lines, `verbose` dump |

A live sink attaches for live commands in every format except `yaml`.

When a CLI-granted data payload owns stdout (§8.3), that payload alone uses stdout, byte-exact. The envelope, every frame (including event and terminal result frames), and `--jq` output MUST use stderr, for success and failure; pre-command failures use the same destination when parsed argv requests the stdout grant. Human result formats keep their existing routing. Machine output follows any diagnostics the selected renderer writes there. Default `lando` and `plain` suppress event narration in envelope formats; with redirected stderr, no explicit `Renderer.message` diagnostics or §18.6 deprecation diagnostics, and no opt-in debug defect logs (§8.11.1), the envelope or frame sequence is the only stderr output. The `json` renderer can precede an envelope with `notify.desktop` records; `verbose` can precede it with a full event dump. Default `lando` can also realize desktop notifications when stderr is a TTY. Framed publications are carried in the frame sequence, without duplicate event narration. Closing either destination independently retains exit `141`; interruption retains the ordinary cancellation status.

Streaming specs emit newline-delimited `StreamFrame` values tagged `stdout`, `stderr`, `event`, or terminal `result`. Data frames carry chunks and optional service/source; event frames carry redacted events; result frames carry `CommandResultEnvelope`. Every JSON frame stream, live or buffered, delivers events through one `subscribeWithHistory` subscription (§11.1): the retained history at acquisition, then each event as it is published. Bootstrap lifecycle markers (`pre-bootstrap-*`, `post-bootstrap-*`, `post-bootstrap`, `ready`) are not framed; every other event is, including messages published during bootstrap. The terminal sequence is: finish data producers, publish the terminal lifecycle event, stop the subscription, drain its queued events, then emit any buffered data frames and the result frame; no frame follows the result frame. Publishers MUST NOT wait on stdout: a saturated subscription drops events instead of blocking, and a non-zero drop count adds a `LANDO_EVENT_FRAMES_DROPPED` warning to the result envelope. Event frames keep publication order among themselves; their order relative to data frames is unspecified, because data frames wait for a complete line. The event consumer MUST NOT additionally narrate framed publications on stderr; explicit `Renderer.message` diagnostics and §18.6 deprecation reporting retain their channels. Human sinks deliver tool bytes through value-only payload redaction (§3.7). JSON data frames MUST first apply the boundary-safe byte value layer, then accumulate complete lines (including `\n`), flush at end of stream or a 64 KiB byte cap, decode with UTF-8 replacement, and apply the full `secrets` profile through `redactString` before encoding. UTF-8 codepoints split at the cap MUST decode incrementally; an incomplete final codepoint becomes a replacement character. Pattern matching is bounded to each line or capped fragment; registered-value matching MUST span fragments. Envelopes keep §8.11.2 redaction unchanged. Data frames are not also published as events. `--format=ndjson` is that frame sequence, one JSON document per line, and is advertised only by streaming commands: a command with no frame sequence does not advertise `ndjson` rather than inventing one.

Tooling MUST use one sink path. Without a host-provided live sink it MUST install a collecting sink and return stdout and stderr, including for envelope, library, and event invocations. A live sink MUST NOT also accumulate an unbounded copy in those result channels or replay live frames at completion. `ExecAppResult` and `ToolingResult` MUST include `stdout` and `stderr`, including empty strings, when output is collected, and MUST omit both when a supplied sink receives the output. Collected log results MUST include `lines`, including an empty array; live-follow results delivered through a sink MUST omit `lines`. Human delivery remains byte-exact after value redaction. MCP additionally retains a bounded final text capture (§10.14); that authoritative result evidence is not a second live emission. Live memory MUST be bounded by chunk size, the registered value set and longest-prefix hold, the JSON line cap, and any explicitly bounded capture, not total output size.

Producer frames MUST distinguish continuous `kind: bytes` chunks from complete `kind: record` strings. Byte chunks invent no delimiter or terminal prefix; records contain no terminating delimiter, and machine/captured text adds one LF. Human record presentation MAY add provenance labels. Producers receive an emit-only sink. The invocation owner closes or joins producer scopes, calls its idempotent terminal `finish`, resolves completion, then publishes the terminal lifecycle event and final result. Nested exec/tooling steps MUST NOT finish a supplied parent sink or expose held secret prefixes between sibling steps. Locally created collectors are finished by their local owner. CLI and MCP MUST agree on Unicode, record boundaries, and final-tail behavior without sharing protocol-specific inspection or presentation.

`CommandResultEnvelope`, `CommandWarning`, `CommandResultFormat`, and `StreamFrame` are published from `@lando/sdk`, re-exported by `@lando/core/schema`, and snapshot-governed by §13.2.

#### 8.11.4 Required behaviors

Every non-interactive canonical command MUST accept `--format json` and `-j`; interactive commands are exempt only while interactive. Pre-command usage failures (an unknown command, an unknown or malformed CLI flag or argument value, an invalid invocation shape, an unsupported result format, a renderer, log-level, or format selection the CLI rejects, conflicting JSON controls) exit `2`, and their human reports omit the `logsDir` and `cacheDir` bug-report fields because nothing ran; the dispatcher classifies these at the failure site, never by error tag, and machine envelopes are unchanged. A command's `cli-<id>-error` event reports the same exit code the process exits with. Every envelope and per-command result schema belongs in the §13.2 snapshot. Source and compiled entries MUST emit identical schema-valid output. The §13.1 conformance gate exercises every canonical id for success and failure against `TestRuntime`.

#### 8.11.5 `--json` field lists and `--jq`

`--json` rules:

- Bare `--json` after command resolution lists selectable top-level result keys as a JSON array on stdout and does not run the command or grant payload stdout.
- Valued `--json` projects comma-separated keys and dot paths into `envelope.result`.
- A failure's retained `result` MAY be projected; its failure metadata MUST remain intact.
- Space form consumes a value only when it contains comma or dot.
- Equals form always supplies a field list.
- `-j` never consumes the next token.

`--jq <expr>` implies JSON, evaluates an embedded jq 1.8-compatible subset against the redacted envelope, replaces the machine result output (stderr when a granted payload owns stdout), preserves exit status, and renders scalars raw. It is bounded, has no environment or module loading, and never spawns system jq. For streaming commands it transforms only the terminal result frame. MCP returns the full redacted envelope and accepts neither projection nor jq; Effect-native library APIs retain typed results and Causes (§16).

The ordered path is schema encode → optional projection → envelope → redaction → optional jq → stdout, or stderr when a granted data payload owns stdout.

- Help/no-command JSON remains catalog output.
- Domain `--path` flags are unrelated.
- Bare list mode with `--jq` is an error.
- Non-JSON format with projection or jq is an error.
- On command failure, jq still evaluates the failure envelope.
- `encodeCommandResult` remains the only serializer.

#### 8.11.6 Command tracing and the `trace` envelope field

A global `--trace` flag (and `LANDO_TRACE=1` through the env helper) enables the tracer for one dispatcher-routed command. Without it, and without a configured exporter (below), the CLI composition provides `References.TracerEnabled` as `false` and the level-`none` fast path is unchanged.

Each traced command runs under one root span `lando <command-id>` with init, run, and render children; §6 `Effect.fn` boundaries supply the rest. The Lando `Tracer` retains finished spans in a bounded buffer of 10,000 and counts overflow.

Output:

- Text renderers print a timing tree to stderr after the result, collapsing spans under 1% of the root duration.
- `--format json` adds an optional `trace` envelope field typed by the public `CommandTrace` schema: `{ totalDurationMs, spans: [{ id, name, parent?, startOffsetMs, durationMs, status: ok|error|interrupted, attributes }], droppedSpans }`. JSON spans are not collapsed. `CommandTrace` is published from `@lando/sdk`, registered in `publicSchemaRegistry`, and snapshot-governed by §13.2.
- Span attributes pass through `RedactionService` before retention, rendering, or export.

Opt-in OTLP export:

- Global config `tracing.otlp.endpoint` (OTLP/HTTP base URL; Lando posts JSON to `<endpoint>/v1/traces`) and `tracing.otlp.headers` (values are secrets in every config view). When both are unset, `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`) are read through the env helper. Config wins over env.
- When configured, spans export over Lando's `HttpClient` with resource attributes `service.name=lando`, `service.version`, `os.type`, and `host.arch`.
- Export is fire-and-forget. Export failure MUST NOT change exit status or result output. The flush runs after the completion line and is bounded to 1 second. Nothing is sent when neither config nor env names an endpoint.

---
