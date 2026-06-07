# PRD: ALPHA3-06 — Scratch apps

## Introduction

Scratch apps (§21 / `spec/19-scratch-apps.md`) are short-lived isolated apps created either by forking an existing app or scratch-starting from a recipe. Alpha 3 ships `ScratchAppService`, the `scratch` bootstrap level, the `apps:scratch:*` CLI namespace, fork-mode and scratch-mode lifecycles, `--isolate=full` (content-copy isolation; copy-on-write deferred to post-4.0), scope-bound finalizer cleanup, a registry + orphan-reap pass, and the `--mount-cwd` / `--share-global-storage` flags.

Depends on: **ALPHA3-05** (global app must be running and reachable for scratch apps to share storage / network).

## Source References

- [`spec/19-scratch-apps.md`](../19-scratch-apps.md) §21 entire part.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) `apps:scratch:*` namespace.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) scratch-app registry + finalizers.
- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) `ProviderCapabilities.copyOnWriteAppRoot` (not used in Alpha 3 — content copy only).

## Goals

- Make scratch apps a first-class concept users can rely on for ephemeral test/CI work.
- Keep scratch-app lifetimes scope-bound so abandoned scratch apps clean themselves up.
- Reap orphaned scratch apps (e.g. left over from a crashed CI run) via provider labels.
- Ship content-copy isolation (`--isolate=full`); preserve the architecture for future copy-on-write.

## User Stories

### US-120: `ScratchAppService` + `scratch` bootstrap level

**Description:** As the runtime, scratch apps boot through a dedicated `scratch` bootstrap level that loads the minimum subset needed (no app discovery, no plugin tooling).

**Acceptance Criteria:**
- [ ] `ScratchAppService` Effect Service tag + contract published in `@lando/sdk`.
- [ ] `scratch` added to `BootstrapLevel` ranking between `commands` and `provider` (or per spec — implementer confirms with §3.2).
- [ ] Live Layer composed in `core/src/runtime/layer.ts`; scratch bootstrap takes no Landofile from CWD.
- [ ] Tests pass; typecheck passes; lint passes.

### US-121: `apps:scratch:*` CLI namespace

**Description:** As a user, I can run `apps:scratch:start`, `apps:scratch:stop`, `apps:scratch:destroy`, `apps:scratch:list`, `apps:scratch:info`, `apps:scratch:logs`, and `apps:scratch:gc`.

**Acceptance Criteria:**
- [ ] All seven commands implemented and aliased per §8.2.
- [ ] `apps:scratch:gc` runs the orphan-reap (US-126) on demand.
- [ ] `--detach` flag on `apps:scratch:start` returns the scratch app id immediately and runs lifetime in the background.
- [ ] Tests pass; typecheck passes; lint passes.

### US-122: fork mode (`apps:scratch:start --fork=<app>`)

**Description:** As a user, I can fork an existing app into a scratch copy with the same services, mounts, and config.

**Acceptance Criteria:**
- [ ] Fork mode resolves the source app via `AppRef`, deep-copies the plan, and creates a new scoped id (e.g. `<source>-scratch-<rand>`).
- [ ] Source app is not modified; fork's volumes/mounts are separate.
- [ ] Scenario test forks a Node+Postgres app, asserts both source and fork run simultaneously.
- [ ] Tests pass; typecheck passes; lint passes.

### US-123: scratch mode (`apps:scratch:start --recipe=<id>`)

**Description:** As a user, I can scratch-start from any recipe (canonical or remote, per PRD-07) and get an ephemeral app without scaffolding into the CWD.

**Acceptance Criteria:**
- [ ] Scratch mode runs the recipe against a temp directory under the per-user data root (`<userDataRoot>/scratch/<id>/`).
- [ ] All recipe prompts that take defaults can be auto-answered via `--option=key=value` flags; remaining prompts run interactively unless `--yes`.
- [ ] Tests pass; typecheck passes; lint passes.

### US-124: `--isolate=full` content copy

**Description:** As a user, `--isolate=full` causes the scratch app to be a content copy (not a shared bind mount) of the source app's app root.

**Acceptance Criteria:**
- [ ] `IsolateMode` schema in `@lando/sdk`: `"none" | "full"`. `--isolate=full` is opt-in; default is `"none"` (shared mount with source).
- [ ] Content-copy implementation uses platform-appropriate fast copy (`cp -r --reflink=auto` on Linux where supported, falling back to byte copy).
- [ ] Provider declares `copyOnWriteAppRoot: false` for Alpha 3; reflink/clonefile/overlay paths are preserved as the post-4.0 substitution point.
- [ ] Tests pass; typecheck passes; lint passes.

### US-125: scope-bound lifetime + finalizer

**Description:** As a user running `apps:scratch:start` without `--detach`, the scratch app is destroyed automatically when the command exits — even on Ctrl-C.

**Acceptance Criteria:**
- [ ] Finalizer registered against the Effect scope of the command; `Ctrl-C` triggers destroy.
- [ ] `--detach` skips the finalizer; the scratch app survives until `apps:scratch:destroy` or `gc`.
- [ ] Tests cover both attached + detached lifetimes including signal-on-exit cleanup.
- [ ] Tests pass; typecheck passes; lint passes.

### US-126: scratch-app registry + provider-label orphan reap

**Description:** As an operator, `apps:scratch:gc` lists and removes scratch apps whose registry entry no longer matches a live provider container set.

**Acceptance Criteria:**
- [ ] Per-user scratch-app registry in `<userDataRoot>/scratch/registry.json` per §12.
- [ ] Provider containers tagged with `lando.scratchId=<id>` label.
- [ ] GC pass cross-references registry × provider label set; orphans on either side are reported; `--prune` removes them.
- [ ] Tests pass; typecheck passes; lint passes.

### US-127: `--mount-cwd` + `--share-global-storage` flags

**Description:** As a user, I can opt the scratch app into mounting my current working directory and/or sharing the global app's storage scope.

**Acceptance Criteria:**
- [ ] `--mount-cwd[=<container-path>]` adds a mount of `$PWD` into the scratch app's primary service.
- [ ] `--share-global-storage` joins the scratch app to the shared cross-app network and exposes the global app's storage scope.
- [ ] Flags are mutually compatible; tests cover both individually + together.
- [ ] Tests pass; typecheck passes; lint passes.

### US-128: `apps:scratch:list` + `apps:scratch:info`

**Description:** As an operator, I can inspect what scratch apps exist, when they were created, what mode they were started in, and their lifetime status.

**Acceptance Criteria:**
- [ ] `apps:scratch:list` renders id / source / mode / created / status (`attached` | `detached` | `orphan`).
- [ ] `apps:scratch:info <id>` shows the same data plus mount points, network membership, and per-service endpoints.
- [ ] JSON renderer output covered by a named snapshot fixture.
- [ ] Tests pass; typecheck passes; lint passes.

## Functional Requirements

- FR-1: `scratch` bootstrap level loads no per-CWD Landofile; scratch apps live under `<userDataRoot>/scratch/<id>/`.
- FR-2: `apps:scratch:*` namespace covers start / stop / destroy / list / info / logs / gc.
- FR-3: Fork mode deep-copies the plan from a source app; scratch mode runs a recipe against a temp directory.
- FR-4: `--isolate=full` produces a content copy; copy-on-write is preserved as a future capability.
- FR-5: Attached scratch apps clean themselves up via Effect-scope finalizers on command exit (including signals).
- FR-6: Detached scratch apps survive until explicit destroy or GC; provider labels enable orphan reap.

## Non-Goals

- Copy-on-write isolation (`reflink`, `clonefile`, overlay) — post-4.0 (§14.2 row "Copy-on-write scratch isolation").
- Scratch fleets (post-4.0; users compose via repeated `apps:scratch:start --detach`).
- Hot reload from fork-mode source (post-4.0 — `FileSyncEngine` plugin).
- Recipe `runs:` allowlist for scratch mode beyond what PRD-07 ships.
- UI for scratch-app lifecycle management.

## Technical Considerations

- The scoped finalizer pattern matches Effect's `Scope.addFinalizer`; the CLI command runs inside a per-invocation scope.
- Orphan reap is cheap (registry + provider label query) but must be safe — never destroy an unlabeled container.
- Content copy on Linux should use `cp --reflink=auto` opportunistically; the implementation must still complete on filesystems without reflink support (no hard requirement).
- `--mount-cwd` interacts with the host-proxy + global app — paths must be absolute, and the mount goes into the scratch app's per-service mount plan, not into the global app.

## Success Metrics

- `apps:scratch:start --recipe=node --detach` returns an id in under 5 seconds on Linux x64 (post-image-pull).
- `apps:scratch:gc --prune` is idempotent: running it twice in a row makes no provider-side changes the second time.
- Forked scratch apps share `node_modules` (when source declares it as a volume) and do not double-allocate disk.

## Guide Coverage

Per [PRD-12 US-198](./prd-alpha-3-12-executable-guides.md) (`## Guide Coverage` convention) and [US-199](./prd-alpha-3-12-executable-guides.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-122 | fork mode (`apps:scratch:start --fork=<app>`) | `docs/guides/scratch/fork-existing-app.mdx` | Required at story acceptance |
| US-123 | scratch mode (`apps:scratch:start --recipe=<id>`) | `docs/guides/scratch/scratch-from-recipe.mdx` | Required at story acceptance |
| US-126 | scratch registry garbage collection (`apps:scratch:gc`) | `docs/guides/scratch/scratch-gc.mdx` | Required at story acceptance |
| US-127 | `--mount-cwd` + `--share-global-storage` flags | `docs/guides/scratch/mount-and-share-flags.mdx` | Required at story acceptance |
| US-128 | `apps:scratch:list` + `apps:scratch:info` | `docs/guides/scratch/list-and-info.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `core/src/scratch-app/**`
- `core/src/cli/commands/scratch.ts`
- `core/src/cli/oclif/commands/apps/scratch/**`

## Open Questions

- Should `apps:scratch:start --recipe=…` default to scaffold inside `<userDataRoot>/scratch/<id>/` or honor a `--target=<path>` override? Default: data-root unless `--target` is passed.
- How should we surface scratch-app logs in the renderer (tailed vs final)? Defer to PRD-09; default is `task.detail`-style tailing.
- Should `apps:scratch:destroy` always delete volumes, or honor `--keep-volumes`? Default: always delete (scratch apps are ephemeral by definition).
