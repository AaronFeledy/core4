# Lando v4: Scratch Apps

> **Part 19 of 21** · [Index](./README.md)
> **Read next:** [20 Programmable Execution](./20-programmable-execution.md)

**Scratch apps** are short-lived Lando apps whose resources and materialized state are owned by an Effect `Scope`. They support isolated forks of existing apps, recipe-backed temporary stacks, and library-hosted test environments.

---

## 21. Scratch Apps

### 21.1 What scratch apps are

A scratch app:

- Has an identity disjoint from user and global apps (§21.2).
- Has a Lando-managed root at `<userDataRoot>/scratch/<id>/`, populated from a source app, recipe, or explicit programmatic configuration and workspace.
- Uses the standard Landofile, planner, build, provider, router, and certificate contracts.
- Is owned by a `Scope` whose finalizer destroys containers, applicable volumes, routes, host-proxy state, transcripts, caches, and the materialized root.
- Is excluded from cwd discovery and is addressable only through `apps:scratch:*` or the library API.

A scratch app is not a Git worktree, a source-app extension, a persistent project, or a multi-instance fleet. Fork mode is a point-in-time copy; `apps:init` remains the path for permanent projects.

### 21.2 Identity

`AppRef.kind` discriminates `user`, `global`, and `scratch`. Cache keys, provider labels, environment, DNS, events, and persistent artifacts MUST use `(kind, id)` rather than id alone. Scratch ids occupy a separate namespace, so they do not reserve user-app slugs and do not use `AppIdReservedError` (§20.2).

| Field | Contract |
|---|---|
| `kind` | `scratch` |
| `id` | A validated, unique `scratch-<base>-<suffix>` identity derived from source or `--name`. New ids are at most 40 characters, with a base of at most 25 and a six-digit hexadecimal suffix. Existing longer ids remain valid. |
| Root | `<userDataRoot>/scratch/<id>/` with the materialized app under its managed root. |
| Provider labels | `dev.lando.scratch=TRUE` and `dev.lando.scratch-id=<id>` on every provisioned container, volume, and network, in addition to §6.5 labels. |
| Environment | `LANDO_PROJECT=<id>`, `LANDO_APP_NAME=<id>`, `LANDO_APP_KIND=scratch`; `LANDO_APP_KIND` applies to every app kind (§6.9). |
| DNS | `<service>.<id>.internal` |

Scratch ids MAY appear in user-facing output and are not secrets.

### 21.3 The scratch app root

Scratch state lives under `<userDataRoot>/scratch/<id>/`, including the materialized root and the `scratch-app-plan` record, from which `scratch:info` derives its output; artifact-step outcomes use the scratch id's own records in the data-root `artifact-build-results` index and reuse any other owner's record of the same build key (§6.13.5), so a fork reuses its source app's built images; app-step outcomes use the scratch id's own bucket in the `build-results-owned` index (§12.1), so two scratch apps never share app-step results even when forked from one source app. Build transcripts live under the scratch branch of the standard build artifact root (§12.4).

The entire scratch tree MUST be excluded from cwd discovery. After resource destruction succeeds, scope finalization removes the scratch app's app-step results, root, caches, and transcripts; its artifact records are released (§6.13.5), so a scratch app of the same stack started within the release window reuses its built images. App-step results are bound to their container (§6.13.5), so removing them is storage cleanup. A crash may leave them behind; `apps:scratch:gc` reaps them (§21.11).

### 21.4 Scratch sources

`ScratchSource.kind` is `fork`, `recipe`, or `config`:

- `fork` identifies the resolved source app root, source app id, and copied Landofile layers.
- `recipe` identifies a standard `RecipeRef` and resolved answers (§8.8.4).
- `config` carries `config: Schema.Encoded<typeof LandofileAuthoringShapeWire>` and authoritative `sourceRoot: AbsolutePath` (§21.4.3). Acquisition payloads are separate from registry/listing source summaries.

#### 21.4.1 Fork mode

`apps:scratch:start --fork [--source <path>]` copies the resolved source app root; without `--source`, standard cwd discovery applies (§7.1).

- Materialization is a content copy, not a hardlink or CoW overlay (§21.15).
- `--exclude` and `scratch.fork.excludes:` add bounded ignore patterns. Generated and dependency-heavy paths are excluded by default.
- All included Landofile layers and the lockfile are copied; merge and include resolution then run against the scratch root.
- The resolved app name is rewritten to the scratch id.
- Local and user overrides are copied unless `--no-local-overrides` is set.
- Materialization is atomic. Failure raises `ScratchAppError` with operation `materialize` and, unless `--keep-on-failure` applies, attempts to remove the partial root without replacing that failure; provider actions MUST NOT begin first.
- Fork materialization MUST NOT implicitly copy source persisted-home stores (§6.5).

#### 21.4.2 Scratch mode

`apps:scratch:start --from <recipe-ref>` materializes through the standard recipe pipeline (§8.8). `<recipe-ref>` is a `SourceLocator` (§23.3).

Recipe resolution, prompt precedence, validation, fragments, and assets follow §8.8. Missing non-interactive answers fail through the recipe error contract and follow acquisition-failure cleanup (§21.10.1). The generated Landofile uses the scratch id. Scratch mode defaults to `baked` isolation (§21.7).

#### 21.4.3 Programmatic configuration mode

The `config` source requires strict authoring-wire validation, one conversion to native authoring input, and canonical preparation/composition/finalization. It MUST NOT re-decode runtime Landofiles, accept caller plans, or serialize temporary YAML only to reload it.

Copy the workspace under fork containment/exclusion rules; default isolation is `full`. The supplied document is authoritative over copied `.lando.*` and ambient local/user layers. Explicit includes and load inputs follow canonical policy inside the managed workspace. Standard scratch planning, build, and readiness apply, with session admission before materialization (§22.6).

Retain the `LoadScopedLandofile` and managed-root provenance with the handle/plan for later operations and cleanup; never rediscover copied configuration. Registry/listing summaries contain kind, root identity, and digest, not authored input or resolved secrets. Existing applied-plan persistence and orphan recovery remain authoritative.

A `config` acquisition MAY name a `workspace` mount: one authorized host directory bound read-write at the primary service's working directory in place of a copy. Template step environments use it for the destination (§23.8). Inside a session it requires `policy.mountRoots` admission (§22.6.1).

### 21.5 `ScratchAppService` core service

`ScratchAppService` owns scope-bound acquisition, lookup, listing, lifecycle operations, and garbage collection. `ScratchAcquireInput` names the source, isolation mode, optional cwd mount, global-storage policy, name, recipe answers, copy excludes, and foreground or detached lifetime. `ScratchHandle` carries the scratch `AppRef`, plan, source, isolation mode, and creation time.

Required behavior:

- The service belongs to the `scratch` bootstrap level and is lazy when included by higher levels.
- `acquire` binds the root, caches, host-proxy socket, routes, containers, and volumes to the caller's `Scope`. Finalization MUST destroy resources before unlinking state.
- CLI foreground acquisition uses the command scope so interruption reaches finalization.
- Destroy is idempotent after success; an unresolved id or name raises `ScratchAppNotFoundError` (§21.10).
- Destroy, GC, and acquisition-failure cleanup bring the scratch down with its applied receipt kept, withdraw its routes and certificates, retire its owned records, and forget the receipt only after all of those succeed. A retry after a partial failure therefore still recovers the plan, even when the desired plan cache is gone.
- The scratch desired plan is a regenerable record that opts into `onNewerVersion: "discard"`: an older or a newer envelope version is a miss (§12.1, §12.7.1). A miss is not permission to ignore applied state. On a miss, destroy and garbage collection MUST resolve the matching applied scratch plan before falling back to planless orphan cleanup. Unreadable ownership evidence MUST NOT be treated as absence (§5.3.1): a damaged or newer-format applied record for the scratch id is protected evidence (§5.5.2), and destroy and GC MUST refuse with the provider's diagnosis before the planless fallback, workspace removal, or registry removal, including when the runtime is offline. The registry does not record which provider ran a scratch app, so a protected shared (record-layout) receipt on any installed provider also refuses the reap; the refusal names that record and its recovery.
- Operations for one id are serialized across callers and processes by one lifecycle lock: the app mutation lock of kind `scratch` keyed by the id and its canonical instance root `<userDataRoot>/scratch/<id>/`. Acquisition holds it from the registry `acquire` write through `mark-running`, covering its own failure cleanup; explicit destroy and stop, `apps:poweroff`, foreground scope-close cleanup, and each GC reap acquire it. Scope-close cleanup reacquires the lock instead of inheriting the acquisition's hold. The lock is taken before any global or app mutation lock.
- Failures are tagged as listed in §21.14.

The service reuses the standard Landofile, planner, build, routing, certificate, and provider services.

### 21.6 Lifecycle

#### 21.6.1 The `scratch` bootstrap level

`scratch` extends `app` in the §3.2 ladder. A scratch app runs the same lifecycle as a user app, so the tier adds `ScratchAppService` to the app graph and scratch commands get the same Landofile event steps, tooling, command steps, and plugin subscribers. Building that graph MUST NOT contact a provider or start global services: `GlobalAppService` is constructed without I/O, and global services start only when a scratch operation requires them.

`bootstrap: scratch` is a valid `LandoCommandSpec` and plugin `ExecutableCommandSpec` value. Plugins MAY use it in their own namespaces; `apps:scratch:*` remains reserved for core. Library hosts MAY request it through `makeLandoRuntime({ bootstrapLevel: "scratch" })`.

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

Destroy payloads carry the teardown plan when one is available, `reason` (`explicit`, `scope-close`, `poweroff`, `gc`, or `acquire-failure`) and `retainedArtifacts` (`volumes`, and `snapshots` as `none`, `kept`, or `unknown-owner`). Source, isolation, global-storage policy, and detached state are recorded registry values and are omitted for an unregistered orphan rather than inferred; a minimal orphan event carries only scope, app, reason, retained artifacts, and timestamp. Without a plan or registry entry, the `AppRef` root is the instance directory.

#### 21.6.3 Standard event sequence

Acquisition wraps materialization and start; scratch start wraps the standard App lifecycle and any required global-service start (§20.6.3). Every scratch destroy (explicit `apps:scratch:destroy`, scope close, poweroff, GC reap, and acquisition-failure rollback) nests `pre-scratch-destroy`, the standard stop pair, the standard destroy pair, instance-root and registry cleanup, then `post-scratch-destroy`. A failure before registry removal skips `post-scratch-destroy`. Failure to publish `post-scratch-destroy` MUST NOT restore the registry entry or imply that the instance was retained. A routed scratch start with no selectable router MUST fail before placement, certificate issuance, builds, and apply with `ScratchAppError` (operation `start`) carrying the selection reason's message and remediation, with the `ProxySetupError` as cause (§10.2). With no selectable router, scratch destroy withdraws routes through every installed router; when that withdrawal is not completed, cleanup still finishes with the §10.2 warning, without asserting route withdrawal. A selected router's failure still keeps the entry. GC reaps paint no task tree. `apps:poweroff` destroys scratch apps before stopping the global app. `--keep-scratch` suppresses every scratch destroy block and composes with `--keep-global`.

### 21.7 Mount isolation: the `--isolate` knob

`--isolate=full|baked|cwd` defines access to host files.

| Mode | `appMount` and relative mounts | Absolute mounts |
|---|---|---|
| `full` | Resolve against the copied scratch root. Default for fork mode. | Pass through unchanged. |
| `baked` | Recipe mode (the default there): resolve against the Lando-owned materialized recipe root. Fork mode: suppressed, with the exclude shadows, nested includes, and file-sync sessions that belonged to them. | Pass through unchanged. |
| `cwd` | Resolve against the cwd captured at start, in every service. | Pass through unchanged. |

"Relative mounts" are the bind entries planning marked `relativeTo: app` (§6.4). Under `full` and recipe `baked`, a relative mount whose source leaves the scratch root, lexically or through a symlink on an existing ancestor, is not mounted, and acquisition publishes a warning naming the service and target; the scratch root is Lando-owned, so mounting inside it exposes no host files. `--mount-cwd` without a target rebinds those mounts to the cwd; `--mount-cwd=<path>` instead adds one plain bind of the cwd at `<path>`, replacing whatever was planned exactly there, and leaves app mounts and sessions untouched.

`--mount-cwd` is sugar for `--isolate=cwd`; in fork mode it MUST warn that it overrides the safer `full` default. Combining it with an explicit incompatible isolation mode fails with `ScratchIsolationConflictError`. `--isolate=passthrough` is reserved and unsupported; the CLI rejects it as a malformed `--isolate` value (`MalformedCliFlagValueError`). Copy exclusions apply only to fork materialization.

Scratch planning MUST skip dependency-environment materialization before deriving mount isolation: no generated store, activation defaults, or prepare job. This applies to all isolation modes, including passthrough (§6.5.1).

### 21.8 Storage shadowing

At plan time, scratch storage obeys this rewrite:

| Written scope | Effective scope | Destroy behavior |
|---|---|---|
| `service` | `service` | Removed. |
| `app` | `app` | Removed. |
| `global` | `app` by default | Removed. |
| `global` with `--share-global-storage` | `global` | Preserved under §6.5. |

Scratch destroy also removes the scratch app's catalogued snapshots, because the ephemeral root leaves nothing else that could reclaim them; this is the one retention exception to §10.11.2. Selection uses the plan's owner key and the scratch app id together, matching the volume selector. A `--isolate=cwd` scratch binds the source tree but owns volumes under its managed instance root, so destroy never removes the source app's snapshots or leaves ownership records that make the source app unresolvable. Scratch destroy, GC, and acquisition-failure cleanup release, never delete, the scratch's shared global-cache inventory members, so its ownership inventory is removed once nothing else remains. A scratch recorded under its source app's root before scratches had their own owner root loses only its own members from that inventory, cache members included. `--keep-volumes` keeps both named volumes and snapshots; it cannot keep an anonymous volume, which leaves with its container (§6.5). Without a plan, snapshot purge is skipped and reported as `unknown-owner`.

The `scope: global` to `scope: app` rewrite is mandatory unless `--share-global-storage` is explicitly set. It MUST NOT be inferred from another flag. Scratch volumes carry the scratch labels and standard storage ownership labels using the effective scope.

### 21.9 Networking and discovery

#### 21.9.1 DNS

`<service>.<scratch-id>.internal` is the canonical internal address. Providers with `sharedCrossAppNetwork` MAY expose that address from user apps, but committed config SHOULD NOT depend on a transient scratch app (§5.4, §10.1).

#### 21.9.2 Route auto-suffix

`ScratchHostnameSuffix` is the plan-time hostname transform for scratch routes, separate from `RouteFilter` middleware. It runs after endpoint derivation and binding (§6.6). Unless overridden, it rewrites each route hostname with the scratch id before the domain, including nested and wildcard hostnames. A label that already is the scratch id, as in a default route's `<service>.<scratch id>.<domain>`, MUST be left unchanged so the label stays within the 63-character DNS limit. The transform MUST be idempotent. Activation binds public URL descriptors against this suffixed publication table and the router's current authorities. For every routed scratch, whether or not it bound URLs, router setup or publication failure MUST fail acquisition. `AppPlacementError` stays the top-level failure; any other failure becomes `ScratchAppError` with operation `start` that names route publication for the scratch id and retains the original cause and the router's remediation. Unless `--keep-on-failure` applies, the §21.6 acquisition-failure cleanup is attempted, including withdrawal of routes the router wrote before failing, and a cleanup failure MUST NOT replace the startup failure. Activation of a route-free or router-disabled scratch MUST NOT prepare, set up, or publish routes for that scratch; teardown follows §21.6.3. Only successful publication can fail with `authority-changed` if its authorities disagree with the prepared proof.

When the hostname ends in the configured proxy domain, the transform uses the label immediately before that entire domain, including multi-label domains. Otherwise, it uses the label before the final two DNS labels. A rewritten label MUST end in `--<id>`. The transform MUST shorten the label with a digest when needed to fit both 63 characters per label and 253 overall. An impossible rewrite or two distinct hostnames mapping to the same hostname MUST fail with `ScratchAppError` with operation `plan` that names the route. The final scratch plan MUST pass the application plan schema and planning policy before placement, cache writes, builds, or provider apply.

`--no-hostname-suffix` disables the transform. Repeated `--hostname` values preserve selected hostnames and MAY deliberately collide with another app.

#### 21.9.3 Exclusion from cross-app scopes

Scratch `AppFeature` code may consume permitted `globalServices.<name>.*` expressions (§20.8.3). User apps MUST NOT reference `scratchApps.<id>.*`; scratch apps are not cross-app expression sources.

### 21.10 CLI surface (`apps:scratch:*`)

| Canonical id | Alias | Contract |
|---|---|---|
| `apps:scratch:start` | `scratch:start`, `scratch` | Acquire from exactly one of `--fork` or `--from`; foreground by default, detached with `--detach`. |
| `apps:scratch:stop` | `scratch:stop` | Stop and destroy the selected scratch or the current foreground scratch. |
| `apps:scratch:destroy` | `scratch:destroy` | Force resource destruction; `--keep-volumes` retains named volumes for inspection. |
| `apps:scratch:list` | `scratch:list` | List registry entries and provider-label orphans; JSON is the canonical machine form. |
| `apps:scratch:info` | `scratch:info` | Report runtime info with service and format selection. |
| `apps:scratch:logs` | `scratch:logs` | Stream logs with standard service, follow, tail, and since filters. |
| `apps:scratch:run` | `scratch:run`, `run` | Run one command in a scope-bound toolbox scratch (§21.10.3). |
| `apps:scratch:gc` | `scratch:gc` | Report orphans; `--prune` reaps them. |

Every id-addressed command (`stop`, `destroy`, `info`, and `logs`) and the `ScratchAppService` by-id methods (`resolveById`, `info`, `start`, `stop`, `destroy`) resolve their argument through one engine resolver over the registry. The exact registry id wins. Otherwise the argument is sanitized with the same function, and the same 25-character base limit, that builds ids from `--name` or the source name, and the registry entries whose id is `scratch-<sanitized>-<6 hex>` are the matches. Exactly one match selects that scratch. Several matches fail `ScratchAppNotFoundError` with the candidate ids, sorted, in `suggestions` and a remediation naming them; the resolver never picks one. No match fails `ScratchAppNotFoundError` whose `suggestions` hold the registered ids that start with the argument or whose base shares a prefix with it, with the `apps:scratch:list` remediation. The registry stores no name field; the id is the only name record. Poweroff's reap of discovered ids stays exact.

`apps:scratch:logs` resolves the registry handle and that root's exact applied plan; it never reads the acquisition plan cache. Absent applied evidence validates `--since` and returns no lines, an unknown id fails with `ScratchAppNotFoundError`, and orphan or ownership refusals propagate unchanged.

Every command uses `scratch` bootstrap. `apps:list --include-scratch` adds running scratches; `apps:list --all` includes all app kinds of this installation (§8.2). `apps:poweroff` destroys scratches by default; `--keep-scratch` opts out and composes with `--keep-global`.

#### 21.10.1 `apps:scratch:start` flags

Behavior-defining flags are `--fork`, `--from`, `--source`, `--isolate=full|baked|cwd`, `--mount-cwd`, `--share-global-storage`, `--no-hostname-suffix`, `--hostname`, `--name`, `--exclude`, `--no-local-overrides`, recipe-answer and interaction flags, `--detach`, `--keep-volumes`, and `--keep-on-failure`.

Foreground mode owns the scratch in the command scope and blocks until exit or interruption. Detached mode records the identity, source, isolation, policy, owner, and start state in `<userDataRoot>/scratch/registry.bin` and returns. `--keep-volumes` applies to foreground and explicit stop cleanup but MUST NOT prevent `apps:poweroff` cleanup. `--keep-on-failure` retains failed state for explicit inspection and destruction.

Scratch startup MUST pass the shared §6.7 readiness barrier before reporting success, returning a started handle, marking the registry running, or executing `apps:scratch:run` tooling. One interruption-safe compensation boundary covers acquisition after registry registration through `mark-running`. On failure or interruption it MUST attempt to reap the instance, including routes partially written by a failed publication, containers, applicable volumes, and the materialized root. This cleanup MUST NOT remove the scratch source root. `--keep-on-failure` skips compensation and adds `scratchId` to a primary `ScratchAppError`.

If acquisition compensation fails, the original failure keeps its tag and stays primary. Report the cleanup failure as an additional error with role `cleanup` and a `ScratchAppError` carrying `operation: "cleanup"`, `scratchId`, and remediation to run `lando scratch:destroy <id>` if the scratch is still listed. The cleanup error MUST NOT imply that a scratch was retained when only the final notification failed. The user-app and global-app retention policy of §6.7 does not apply to scratch apps and MUST NOT suppress scratch cleanup. Scratch remediation MUST address the scratch identity and MUST NOT prescribe `lando start`.

#### 21.10.2 Top-level alias reservation

The `scratch:` prefix, bare `scratch`, and bare `run` are reserved under §8.1.2. Conflicting plugin aliases raise `CommandAliasConflictError`; user alias overrides MAY remap plugin claims. Reserved tooling names are rejected outright by lint and planning as `landofile.tooling` issues (§7.8). Canonical `apps:scratch:*` ids remain callable.

#### 21.10.3 `apps:scratch:run` and the disposable tool runner

`apps:scratch:run` is a thin `ScratchAppService.acquire` surface, not a separate lifecycle. It defaults to the bundled `toolbox` recipe, cwd isolation, and the primary service. `--from`, `--service`, and `--no-mount` select another recipe, target, or baked isolation.

Arguments after `--` pass verbatim to provider exec. Stdin and PTY follow the §8.2 host-stdin rule, and agent context follows §6.9.1. In human-result formats, acquisition progress renders first and is retired before the tool starts (§8.9.2), then tool output streams live through the unified sink with value-only byte-exact redaction (§3.7, §8.2). Acquisition narration, including the TTY live region, MUST use stderr. In human-result formats, stdout MUST contain only tool output under that sink. JSON uses the §8.11.3 frames and YAML emits one terminal envelope. The tool exit code becomes the command exit code and is not a tagged Lando failure. Scope close attempts to destroy the scratch on success, failure, or interruption. `--keep` converts it to a detached scratch; human output names the kept id on stderr, apart from the tool's stdout. There is no warm pool (§21.15).

### 21.11 Cleanup, registry, and orphan reaping

The `scratch-registry` at `<userDataRoot>/scratch/registry.bin` (§12.1) is the active-process source of truth. Entries identify the scratch, source, isolation, global-storage policy, detached and owner state, managed paths, lifecycle status, and timestamps. Acquisition records state before provider operations, marks running after start, and removes the entry after destroy. A destroy that fails after `pre-scratch-destroy` and before registry removal records `destroyed-pending-cleanup` best effort, without replacing the original failure. GC treats that entry as a candidate whatever its owner liveness or detached state.

Registry updates MUST use the canonical atomic, lockable `StateStore` contract (§12.7). `apps:scratch:gc` combines three authorities:

1. Registry entries whose recorded owner is no longer alive, and entries whose instance directory is missing, are candidates; so are instance directories with no registry entry.
2. Provider resources labeled `dev.lando.scratch=TRUE` whose scratch id is absent from the registry are candidates.
3. Canonical scratch ids with build output under `<userDataRoot>/builds/scratch/<id>/` and no registry entry are candidates.

Without `--prune`, GC reports `inspected`, the candidate ids as `candidates`, and empty `reaped` and `errors`, and exits successfully. With `--prune`, it reports the same `candidates`, takes each candidate's lifecycle lock (§21.5), re-evaluates the id, skips one that stopped being a candidate, and destroys the rest through the scratch reaper, which removes managed host state including the id's app-step results and transcripts.

The registry walk MUST NOT replace the provider-label scan, and the provider-label scan MUST NOT replace the registry walk. The combined protocol recovers both lost registry entries and host-only artifacts. The JSON report is the canonical machine shape and GC is safe for unattended use.

### 21.12 Library mode

`makeLandoRuntime({ scratch })` is the library-mode acquisition form (§16.3). Supplying `scratch` acquires the app in the runtime `Scope`; finalization destroys it. Omitting the option preserves the non-scratch runtime contract.

`runtime.scratch(input)` exposes manual acquisition through `ScratchAppService`. Hosts creating successive scratches SHOULD reuse one runtime. The §13.1 library contract suite MUST verify that repeated acquisitions do not accumulate per-acquisition overhead.

### 21.14 Errors

Every error is tagged and includes remediation:

- `ScratchAppError`, the umbrella for state-transition failures, including materialization, registry, start, and recipe prompt failures
- `ScratchSourceUnresolvedError`
- `ScratchAppNotFoundError`
- `ScratchAppIdInvalidError`
- `ScratchIsolationConflictError`
- `ScratchRunTargetError`
- `RouteUrlBindingError` with `no-route`, `router-unsupported`, or `authority-changed` for public URL binding failures. `retained-consumer` is specific to selected user-app relaunch. An unavailable router is still a `ProxySetupError` wrapped in `ScratchAppError`, not a binding error.

A recipe prompt failure (`RecipeMissingAnswerError`, `RecipePromptValidationError`, `InteractionRequiredError`, or `PromptValidationError`) is wrapped in `ScratchAppError` with the scratch source, naming the prompt to answer when the failure identifies it; a recipe that cannot be resolved or is unsupported (`RecipeManifestNotFoundError`, `RecipeManifestParseError`, `RecipeManifestValidationError`, or `NotImplementedError`) is reported as `ScratchSourceUnresolvedError`. This surface also uses the shared `CommandAliasConflictError` tag (§8.1.2). Corrupt registries are quarantined and recovery invokes label-driven GC. A scope-close finalizer failure MUST publish a `message.warn` event naming the scratch id and how to retry destroy if the scratch is still listed.

### 21.15 Non-goals

- CoW, overlay, and passthrough isolation are outside this contract; they require a provider capability and a cross-platform contract that do not exist here.
- Scratch fleets are not a primitive; callers may compose independent detached acquisitions.
- Fork mode has no hot reload from source changes.
- Scratch apps are not cross-app expression sources.
- `<userDataRoot>/scratch/` is not independently relocatable; changing `<userDataRoot>` relocates it (§7.5).
- A persistent agent is a non-goal and does not change scratch lifetime (§14.2).
- `apps:scratch:run` has no warm toolbox pool; `--keep` or a normal app provides persistence.
- Plugins MUST NOT acquire scratches during install. They MAY contribute recipes or `globalServices:` that user-initiated scratches consume.
