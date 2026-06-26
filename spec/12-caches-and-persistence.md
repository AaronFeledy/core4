# Lando v4 — Caches and Persistence

> **Part 12 of 18** · [Index](./README.md)
> **Read next:** [13 Testing and Distribution](./13-testing-and-distribution.md)

This part defines what Lando writes to disk and how. Caches are the mechanism by which the hot path stays hot: tooling commands at `bootstrap: tooling` read the command + app-plan caches in under 30ms on a warm filesystem and skip provider initialization until the command actually executes.

Covered here: the cache catalog (command, plugin, app-plugin, app-plan, service-info, provider, oclif-manifest, update) with their locations and invalidation triggers, encoding choices (JSON for human-friendly small caches, Effect-Schema-encoded binary for the hot-path app-plan), atomicity rules via `CacheService.writeAtomic`, the full list of persistent on-disk artifacts under `<userConfRoot>`, `<userCacheRoot>`, and `<userDataRoot>`, hot-path read budgets, and the disconnectable local-dev state required after an app build.

---

## 12. Caches and Persistence

### 12.1 Cache catalog

The **encoding** column captures the §12.2 rule: every cache read on the router-phase or tooling hot path is binary-encoded; human-readable JSON is reserved for caches a maintainer might `cat` while debugging and that are not on a hot path.

| Cache | Location | Encoding | Contents | Invalidated by |
|---|---|---|---|---|
| `core-command` | embedded in binary + `<userCacheRoot>/command-cache.bin` | binary (§12.2) | Built-in command metadata, default aliases, docs metadata | Core version change, `--clear` |
| `plugin-command` | `<userCacheRoot>/plugin-command-cache.bin` | binary | Plugin command metadata from validated manifests; no command implementation modules | Plugin install/remove/update, plugin cache invalidation, `--clear` |
| `app-command` | `<userCacheRoot>/apps/<app-id>/commands.bin` | binary | App tooling routing metadata: canonical ids, summaries, flag/arg specs, aliases, effective bootstrap levels, app-plan cache key | Landofile change, tooling include change, `.lando.lock.yml` change, app-plan rebuild, `app:cache:refresh`, `--clear` |
| `cwd-app-map` | `<userCacheRoot>/cwd-app-map.bin` | binary | Mapping `cwd` → `{ appRoot, primaryLandofilePath, mtimeNs, sizeBytes }` for fast app-root resolution during the router phase. Bounded LRU (default 256 entries; configurable via global `cache.cwdAppMap.maxEntries`). | Per-entry: primary Landofile mtime/size mismatch on lookup; whole-cache: Lando version change, `--clear` |
| `plugin` | `<userCacheRoot>/plugin-cache.json` | JSON | Resolved manifests, dep graph, contribution index | Plugin install/remove/update, config change, `--clear` |
| `app-plugin` | `<userCacheRoot>/apps/<app-id>/plugins.json` | JSON | App-scoped plugin lock resolution and local install metadata | Landofile `plugins:` change, `.lando.lock.yml` change, plugin cache corruption, `--clear` |
| `app-plan` | `<userCacheRoot>/apps/<app-id>/plan.bin` | binary | Frozen `AppPlan` with provider id, plus compiled tooling task graphs, expression ASTs, and task fingerprint metadata | Landofile change, tooling include change, expression schema/version change, rebuild, destroy, provider change |
| `global-app-plan` | `<userCacheRoot>/global/plan.bin` | binary | Frozen `AppPlan` for the **global Lando app** (§20.5), plus compiled tooling task graphs, expression ASTs, and task fingerprint metadata. Same encoding rules as `app-plan`; cross-app readable | Global Landofile change (any of the six merge layers under `<userDataRoot>/global/`), `<userConfRoot>/global.config.yml` change, plugin install/remove that contributes `globalServices:`, `meta:global:rebuild`, `meta:global:destroy`, provider change |
| `global-app-info` | `<userCacheRoot>/global/info.json` | JSON | Last known `ServiceInfo[]` for the global app's services for fast `meta:global:info`/`meta:global:list` | `meta:global:start`, `meta:global:stop`, `meta:global:restart`, `meta:global:rebuild`, `meta:global:destroy` |
| `scratch-app-plan` | `<userCacheRoot>/scratch/<scratch-id>/plan.bin` | binary | Frozen `AppPlan` for a single scratch Lando app (§21.5), plus compiled tooling task graphs and expression ASTs. Same encoding rules as `app-plan`; written when `ScratchAppService.acquire` materializes the scratch root, removed atomically when the scratch is destroyed | Scratch acquisition (initial write), `apps:scratch:rebuild` (deferred), scratch destroy (removed), provider change (force-rebuild) |
| `scratch-app-info` | `<userCacheRoot>/scratch/<scratch-id>/info.json` | JSON | Last known `ServiceInfo[]` for a single scratch app for fast `apps:scratch:info`/`apps:scratch:list` | `apps:scratch:start`, `apps:scratch:stop`, `apps:scratch:destroy` |
| `scratch-build-results` | `<userCacheRoot>/scratch/<scratch-id>/build-results.bin` | binary | Per-scratch `BuildResult[]` index (§6.13.5) using the same encoding and rotation rules as `build-results`. Read by `BuildOrchestrator` at `pre-build-phase` to short-circuit unchanged steps; the content-hashed `buildKey` is shared across user, global, and scratch apps so a fork-mode scratch reuses cached artifacts when the source has already built them | Scratch destroy, `apps:scratch:start` against an existing scratch id (rare; only via `--detach` re-resolve), build orchestrator schema/version change |
| `scratch-registry` | `<userCacheRoot>/scratch/registry.bin` | binary | Single-file registry of every scratch app on the host (§21.11). One entry per id with source, isolation, owning PID, status, root path, host-proxy socket, timestamps. Read by `apps:scratch:list` and `apps:scratch:gc`; written through the `StateStore` primitive (§12.7) — an atomic write per §12.3 plus a fcntl-style lockfile at `<userCacheRoot>/scratch/registry.lock` for cross-process serialization | Every `ScratchAppService` lifecycle transition; corruption quarantines the file to `registry.bin.corrupt-<timestamp>` and rebuilds empty so a label-driven `apps:scratch:gc` can recover orphans (§21.14 `ScratchRegistryCorruptError`) |
| `service-info` | `<userCacheRoot>/apps/<app-id>/info.json` | JSON | Last known `ServiceInfo[]` for fast `info`/`list` | Start, stop, restart, rebuild, destroy |
| `provider` | `<userCacheRoot>/provider-cache.json` | JSON | Provider availability + version metadata | `setup`, provider config change, `--clear` |
| `oclif-manifest` | embedded in binary + `<userCacheRoot>/oclif-manifest.bin` | binary | OCLIF adapter shim cache derived from core/plugin/app command indexes | Plugin install/remove, app command index change |
| `template-compile` | `<userCacheRoot>/templates/<engineId>/<contentHash>.bin` | binary | Compiled `CompiledTemplate` blobs per `TemplateEngine` (§7.3.2). Content-addressed by canonical template-content hash; cross-app | Template content change (hash mismatch), engine version change, `--clear` |
| `template-render` | `<userCacheRoot>/templates/<engineId>/<contentHash>-<varsHash>.bin` | binary | Rendered template output. Content-addressed by template content hash + canonical resolved-vars hash; cross-app | Template content change, resolved `vars:` change, render context schema/version change, `--clear` |
| `host-proxy-allowlist` | `<userCacheRoot>/host-proxy-allowlist.bin` | binary | Generated allowlist of canonical command ids that the in-container `lando` shim may forward via `HostProxyService.runLando` (§10.10). Built from every `LandoCommandSpec` with `hostProxyAllowed: true` (§8.3), every plugin command with the same flag, and every per-app tooling task with `hostProxyAllowed: true` (§8.5) | Plugin install/remove/update, app command index change, app-plan rebuild, `--clear` |
| `tunnel-registry` | `<userCacheRoot>/tunnels/registry.bin` | binary | Single-file registry of detached public tunnel sessions (§10.2.2), written through `StateStore` with advisory locking. One entry per session with app id, provider id, target summary, redacted public URL summary, owning PID/socket metadata, detached/foreground marker, status, timestamps, and provider-owned opaque session id. Read by `app:share:list`, `app:share:stop`, embedding-host `app.shareList`/`shareStop`, and tunnel GC; foreground sessions may appear as active while the owning process is alive | Every detached `TunnelService` lifecycle transition; app destroy; stale PID/socket reconciliation; corruption quarantines the file to `registry.bin.corrupt-<timestamp>` and rebuilds empty so provider status/GC can recover orphans |
| `file-sync-sessions` | `<userCacheRoot>/file-sync/sessions/<app-id>.bin` | binary | Per-app `FileSyncEngine` session metadata (§10.6): engine id, engine-issued session id, source path (with `${HOME}` normalized), target shape (volume name or service path), mode, canonicalized excludes hash, `mountKey`, last-known status. Read at `app:start` to reconcile or recreate sessions, written at every `pre-/post-file-sync-*` event, read at `app:stop` to terminate cleanly. Survives `lando stop`; cleared by `lando destroy` and by app-plan rebuild | App-plan rebuild, `app:cache:refresh`, `app:destroy`, engine version change, `--clear` |
| `build-results` | `<userCacheRoot>/apps/<app-id>/build-results.bin` | binary | Per-app `BuildResult[]` index (§6.13.5): for each `(service, phase, buildKey)`, the most recent `complete` and `fail` outcomes with `exitCode`, `durationMs`, `artifactRef` (artifact phase), `transcriptPath` pointer, and `completedAt`. Bounded per `(service, phase, buildKey)`: the most recent N=10 `complete` and N=5 `fail` entries are kept (configurable via `build.transcripts.keep*` global). Read by `BuildOrchestrator` at `pre-build-phase` to short-circuit unchanged steps; written on every `build-step-complete` / `build-step-fail`. The cache stores only the index — actual transcripts live as the persistent artifact in §12.4. | `app:rebuild`, `app:destroy`, `app:cache:refresh --rebuild`, build orchestrator schema/version change, `--clear` |
| `update` | `<userCacheRoot>/update-cache.json` | JSON | Plugin update channel metadata | `update`, scheduled refresh |
| `tool-downloads` | `<userCacheRoot>/tool-downloads/<toolId>/<filename>` | binary (raw artifact) | SHA-256-keyed cache of verified archives the tool-provisioning helper (§10.3.4) fetches through `Downloader` before extraction/install (e.g., the Mutagen host CLI and agent archives). A re-run whose pinned artifact already matches its checksum is a cache hit with no network access (§1.4 offline contract). | Pinned `toolVersion` bump, checksum mismatch, `--clear` |

**`cwd-app-map` semantics.** The router phase first does an O(1) lookup of `cwd` → cached entry. On hit, it stats the cached `primaryLandofilePath`; if `mtimeNs` and `sizeBytes` match, the resolved `appRoot` is used directly without walking the directory tree. On miss or staleness, the router falls back to the directory walk, then atomically writes the resolved entry. The cache is bounded; eviction is LRU. This avoids the 30+ stat syscalls that a deep-cwd directory walk costs in the v3-style flow.

### 12.2 Cache encoding

- **Binary encoding for every cache on a hot path.** Every cache read by the router phase (`core-command`, `plugin-command`, `app-command`, `cwd-app-map`, `oclif-manifest`) and the tooling hot path (`app-plan`) MUST use a binary format. JSON is reserved for caches that are not on a hot path and that a maintainer might `cat` while debugging (`plugin`, `app-plugin`, `service-info`, `provider`, `update`).
- **Binary format choice.** Two options are permitted. (1) `Bun.serialize` / `Bun.deserialize` (V8 structured-clone format) for caches that are not crossing the public schema/contract surface — fastest decode, no schema authoring cost. (2) Effect Schema binary encoding for caches whose schema is part of the public contract (`app-plan`, the canonical `AppPlan`). Mixing within a single cache file is forbidden; a cache picks one mechanism and stays with it across versions.
- **Versioned magic header.** Every binary cache file starts with a fixed-size header containing: a 4-byte magic identifier per cache, an 8-byte schema version (Lando version + cache-specific version), and an optional 32-byte content-hash field for caches that include freshness fingerprints inline. A header mismatch triggers automatic invalidation with no error surfaced to the user.
- **Atomicity.** Binary cache writes go through `CacheService.writeAtomic` (§12.3). A partial write resulting from a crash is detected by the magic header on next read and triggers regeneration.
- All caches have a versioned schema header. A version mismatch triggers automatic invalidation.
- Tooling task caches MUST store expression ASTs and static, redacted task metadata only. They MUST NOT store dynamic `vars.<name>.sh` results, decrypted secret values, host command output, provider connection state, or status/precondition command results.
- Command routing caches MUST store freshness metadata: cache schema version, Lando version, app root, Landofile paths, lockfile fingerprint, plugin graph fingerprint, and mtimes/sizes or content hashes for files that affect command registration.
- Router bootstrap MAY stat known files to validate freshness, but MUST NOT parse Landofiles, resolve includes, import plugin modules, contact plugin sources, or initialize providers.
- If an app command cache is missing or stale, router bootstrap omits app tooling commands and `command_not_found` reports remediation instead of reparsing the app config on the hot path.

### 12.3 Atomicity

`CacheService` performs atomic writes:

```ts
const path = "<...>/plan.bin";
yield* fs.writeAtomic(path, encoded);  // write to <path>.tmp, fsync, rename
```

Read-then-write patterns use Effect's `Ref` for in-memory consistency before the atomic write.

### 12.4 Persistent artifacts

Files Lando v4 writes to disk:

| Path | Contents |
|---|---|
| `<userConfRoot>/` | User config root |
| `<userConfRoot>/config.yml` | Global config |
| `<userConfRoot>/global.config.yml` | Plugin enablement map for the global Lando app (§20.3.1); `{ <globalServices.id>: { enabled: bool } }` map populated by `meta:global:install` / `meta:global:uninstall` |
| `<userConfRoot>/config.d/*.yml` | Layered global config |
| `<userCacheRoot>/` | Cache root |
| `<userCacheRoot>/logs/` | Core log files |
| `<userCacheRoot>/cwd-app-map.bin` | Bounded LRU mapping of cwd → resolved app root for fast router-phase lookup (§12.1) |
| `<userCacheRoot>/templates/<engineId>/` | Cross-app `template-compile` and `template-render` caches per engine (§12.1) |
| `<userCacheRoot>/apps/<app-id>/` | Per-app caches and provider workdir |
| `<userDataRoot>/` | Persistent data root |
| `<userDataRoot>/plugins/` | User-installed plugin packages (read-write; written by `meta:plugin:add`) |
| `<userDataRoot>/global/` | App root for the global Lando app (§20.3); contains the six-file merge layers and plugin-generated `dist` layer |
| `<userDataRoot>/global/.lando.dist.yml` | Plugin-contributed canonical layer for the global Landofile, regenerated by `GlobalAppService.regenerateDist` from every enabled `globalServices:` contribution; carries a `# DO NOT EDIT — regenerated by Lando` header (§20.3) |
| `<userDataRoot>/apps/<app-id>/plugins/` | App-scoped plugin packages resolved from a Landofile `plugins:` block |
| `<userDataRoot>/plugin-auth.json` | npm-style auth for private registries |
| `<userDataRoot>/keys/` | Lando-managed SSH keys |
| `<userDataRoot>/bin/` | Lando-managed binary helpers (per-platform), installed by the tool-provisioning helper (§10.3.4). Each binary is accompanied by a `<name>.sha256` fingerprint and a per-tool installed-version marker so re-provisioning the same pinned version is an idempotent no-op with no network access |
| `<userDataRoot>/certs/` | CA + leaf certificates |
| `<userDataRoot>/runtime/` | Default provider private runtime root |
| `<userDataRoot>/runtime/config/` | Default provider private config (registries, policy) |
| `<userDataRoot>/runtime/bin/` | Private Podman and helper binaries |
| `<userDataRoot>/runtime/storage/` | Private container image and volume storage |
| `<userDataRoot>/runtime/run/` | Private API socket and PID files (Linux; inside VM on macOS/Windows) |
| `<userDataRoot>/runtime/machines/` | Managed VM state (macOS and Windows only) |
| `<userDataRoot>/run/<app-id>/host-proxy.sock` | Per-app `HostProxyService` Unix socket (mode `0600`). Bound at `app:start`, unlinked at `app:stop` or scope finalization (§10.10) |
| `<userDataRoot>/run/tunnels/<session-id>.{pid,sock,json}` | Per-session tunnel connector process metadata and optional provider-control socket for detached `TunnelService` sessions (§10.2.2). The durable session index is the `tunnel-registry` `StateStore` bucket; these files are best-effort process handles reconciled and reaped by status/list/stop/GC |
| `<userDataRoot>/bin/mutagen[.exe]` | Mutagen host CLI used by the bundled `@lando/file-sync-mutagen` engine (§10.6.2). Provisioned by `lando setup` through the tool-provisioning helper (§10.3.4) against the plugin's pinned `ToolManifest`. NOT a system Mutagen install — bit-for-bit isolated from any user-installed copy |
| `<userDataRoot>/bin/mutagen-agents/mutagen-agent-<platform>` | Per-platform Mutagen agent binaries deployed into containers by the engine via `RuntimeProvider.run`. One binary per Lando-supported guest platform target (`linux-amd64`, `linux-arm64`, `linux-armv7`). Provisioned alongside the host CLI through the tool-provisioning helper (§10.3.4); checksum-verified; never replaced from inside a container |
| `<userDataRoot>/run/file-sync/daemon.sock` | Lando-owned Mutagen daemon Unix socket (POSIX, mode `0600`); on Windows the equivalent is `\\.\pipe\lando-file-sync-daemon`. Process-scoped lifetime: bound when the first `FileSyncEngine.createSession` runs, unlinked at process exit (§10.6.2) |
| `<userDataRoot>/run/file-sync/daemon.pid` | Lando-owned Mutagen daemon PID file used by `lando doctor` to detect orphan daemons across abnormal exits |
| `<userDataRoot>/file-sync/mutagen-data/` | Mutagen's own state directory (sessions registry, internal logs). Owned by the embedded Mutagen, opaque to Lando. Cleared by `lando uninstall`; not cleared by `lando destroy` because sessions are app-scoped (recorded in `file-sync-sessions` cache) and Mutagen's own registry is daemon-scoped |
| `<userCacheRoot>/logs/file-sync/` | Mutagen daemon and engine-side log streams. Subject to the §10.9 retention policy |
| `<userDataRoot>/builds/global/<phase>/<service>/<buildKey>.log` | Per-step build transcripts for the global app, written by `BuildOrchestrator` exactly as for user apps (§6.13.6) |
| `<userCacheRoot>/scratch/` | Root of the scratch-app subtree (§21.3); contains one `<scratch-id>/` directory per scratch app, plus `registry.bin` and `registry.lock` |
| `<userCacheRoot>/scratch/<scratch-id>/root/` | Materialized scratch app root (§21.3); contains the resolved Landofile and any source-/recipe-rendered files. Removed atomically on scratch destroy |
| `<userCacheRoot>/scratch/<scratch-id>/lock` | Per-scratch fcntl-style lockfile used by `ScratchAppService` to serialize concurrent `acquire` / `stop` / `destroy` against the same id (§21.5) |
| `<userCacheRoot>/scratch/registry.bin` | Single-file scratch registry; encoding and lifecycle rules per the §12.1 `scratch-registry` cache row (§21.11) |
| `<userCacheRoot>/scratch/registry.lock` | Cross-process lockfile for atomic registry writes (§21.11) |
| `<userDataRoot>/run/scratch/<scratch-id>/host-proxy.sock` | Per-scratch `HostProxyService` Unix socket (mode `0600`); bound at scratch start when the plan declares the `lando.host-proxy` feature (§6.11), unlinked at scratch destroy or scope finalization (§10.10) |
| `<userDataRoot>/builds/scratch/<scratch-id>/<phase>/<service>/<buildKey>.log` | Per-step build transcripts for a scratch app, written by `BuildOrchestrator` exactly as for user apps (§6.13.6); removed atomically on scratch destroy |
| `<userDataRoot>/builds/<app-id>/<phase>/<service>/<buildKey>.log` | Per-step build transcripts written by `BuildOrchestrator` (§6.13.6). One file per `(service, phase, buildKey)` containing the full unredacted output of the step. Opened on `build-step-start`, appended atomically as `execStream` chunks arrive, closed on `build-step-complete` / `build-step-fail`. Read directly by the renderer's alt-screen full-tail view (§8.9.2) and by `lando logs <service> --build [--build-key …]`. Rotation: per `(service, phase, buildKey)`, the most recent `build.transcripts.keepCompleted` (default 10) `complete` entries and the most recent `build.transcripts.keepFailed` (default 5) `fail` entries are retained; older transcript files are unlinked when their `build-results` cache entry rolls out. Cleared by `lando destroy`; never sent to telemetry |
| `<userDataRoot>/snapshots/<app-id>/<store>/<snapshot-id>.<format>` | Volume snapshot archives written by `DataMover` (§10.11) in `copy` mode (`tar`/`tar.gz`/`tar.zst`), each paired with a `<snapshot-id>.json` `SnapshotInfo` sidecar (digest, size, createdAt, label, optional native `VolumeSnapshotRef`). The store root resolves through `PathsService.appSnapshotsDir` (§7.5.1). Survives `lando destroy`; removed only by `lando destroy --purge` or `meta`/`app` snapshot-prune. Never sent to telemetry |
| `<userDataRoot>/snapshots/<app-id>/index.bin` | `StateStore` (§12.7) bucket indexing an app's snapshots (id, store, digest, size, label, createdAt). Atomic write + version header + corruption quarantine inherited from `StateStore`; NOT a bespoke registry. Read by `listSnapshots`/`pruneSnapshots` (§10.11.2) |
| `<userDataRoot>/managed-files/<app-id>/ledger.json` | `StateStore` (§12.7) bucket recording `ManagedFileService` (§10.13) ownership state for working-tree files (id, owner, path, mode, format, marker, last checksum, source hash, adopted/conflict state, optional backup metadata). The path resolves through `PathsService.managedFileLedger(appId)` (§7.5.1). Local and rebuildable from on-disk markers; NOT a bespoke registry |
| `<systemPluginRoot>/plugins/` | System-installed plugins (read-only from Lando; populated by OS package managers or admins; see §7.5 for the platform defaults that resolve `<systemPluginRoot>`) |

### 12.5 Hot-path read budgets

Reading the core/plugin/app command indexes plus the `cwd-app-map` lookup during router bootstrap MUST complete in under 30 ms on a warm filesystem. After a tooling command resolves, reading the app-plan cache and compiled `ToolingProgram` at bootstrap level `tooling` MUST also complete in under 30 ms on a warm filesystem. The binary encoding rule in §12.2, the `cwd-app-map` short-circuit in §12.1, and the lack of any provider contact at these levels make this achievable. Tooling includes, Landofile `includes:` resolution (against the cache + lockfile per §7.7), expression parsing, and task graph construction happen when the app plan is built or invalidated, not on the warm tooling hot path.

Hot-path budgets are enforced by the perf-budget test layer (§13.1). Read regressions surface there before they regress the user-visible §2.1 budgets.

### 12.6 Disconnectable local-dev state

After a successful app materialization/build, Lando-owned state required for routine local development MUST be present on disk: resolved app plugins, resolved includes, provider metadata, app-plan/tooling caches, service info cache, and provider artifacts that Lando itself was responsible for pulling or building. Routine commands (`start`, `stop`, `restart`, `info`, `logs`, and cached tooling) must work without network access when that state is complete.

If an offline command needs a missing Lando-managed dependency, Lando fails with a tagged error explaining which cache/artifact is missing and which online command will repair it. Lando MUST NOT silently attempt repeated network retries for routine offline-capable commands.

Telemetry and update checks are queued/best-effort. Failure to reach telemetry or update endpoints never invalidates local caches and never changes a local-dev command's exit code.

### 12.7 State store

`CacheService` (§12.3) is the **ephemeral, in-memory** memo layer: a process-lifetime `Ref` map with TTLs and a raw `writeAtomic` escape hatch. Its durable peer is the **`StateStore`** — the single primitive for every Lando-owned file that must survive process exit, be written atomically, validated against a schema, versioned, and (optionally) serialized across processes. Before `StateStore`, three subsystems each reimplemented a slice of this: the scratch registry (§21.11) carried the most complete take (versioned envelope + token lockfile + stale-owner detection + corruption quarantine + atomic write), the `.lando.lock.yml` include lockfile (§7.7.4) carried a no-lock variant, and `CacheService.writeAtomic` carried the bare write-temp-then-rename. `StateStore` is the union of those, published once.

`StateStore` is a core service (§3.4), constructed eagerly at level `minimal`. It is **not** a §4.2 plugin contribution surface: like `EmbeddedAssetService` and `RedactionService`, it mediates state integrity and is host/test-overridable but never plugin-replaceable.

#### 12.7.1 Buckets

A `StateStore` mints `StateBucket` handles; one bucket is exactly one file. `open` resolves and containment-checks the path and does no IO; reads happen on `get`.

```ts
export type StateRoot =
  | "userData" | "userCache" | "userConf"
  | { readonly app: AbsolutePath }
  | { readonly path: AbsolutePath };

export type StateCodec<A, I> =
  | "json"                                       // { version, data } envelope; debuggable
  | "binary"                                     // LSB1 magic + 4-byte BE schema version + JSON payload body
  | { readonly encode: (a: A) => string | Uint8Array;
      readonly decode: (raw: Uint8Array) => A }; // user-facing formats (the includes YAML)

export interface StateBucketSpec<A, I> {
  readonly root: StateRoot;
  readonly namespace?: string;                   // optional single path segment under root (e.g. "scratch")
  readonly key: string;                          // filename; no path separators
  readonly schema: Schema.Schema<A, I>;
  readonly version: number;                       // document schema version
  readonly codec?: StateCodec<A, I>;             // default "json"
  readonly lock?: "none" | "advisory";          // default "none"
  readonly onCorrupt?: "discard" | "quarantine" | "fail";        // default "quarantine"
  readonly onVersionMismatch?: "discard" | StateMigrator<A>;     // default "discard"
  readonly default?: A;                           // returned by get when the file is absent
}

export interface StateBucket<A> {
  readonly path:   AbsolutePath;
  readonly get:    Effect.Effect<A | null, StateStoreError>;
  readonly set:    (value: A) => Effect.Effect<void, StateStoreError>;            // atomic replace
  readonly update: (f: (cur: A | null) => A) => Effect.Effect<A, StateStoreError>; // RMW (locked if advisory)
  readonly modify: <B>(f: (cur: A | null) => readonly [B, A]) => Effect.Effect<B, StateStoreError>;
  readonly remove: Effect.Effect<void, StateStoreError>;
  readonly exists: Effect.Effect<boolean, StateStoreError>;
}

export class StateStore extends Context.Tag("@lando/core/StateStore")<StateStore, {
  readonly open: <A, I>(spec: StateBucketSpec<A, I>) => Effect.Effect<StateBucket<A>, StateStoreError>;
}>() {}
```

Required behaviors:

- **Atomicity.** Every `set` / `update` encodes in memory, writes `<path>.tmp-<rnd>`, fsyncs, and renames (§12.3). A crash mid-write leaves only a temp file, which is cleaned up; the live file is never partially written.
- **Versioning.** The `json` codec wraps payloads as `{ version, data }`; the `binary` codec writes an `LSB1` magic header, a 4-byte big-endian schema version, and a JSON-encoded payload body (not `Bun.serialize`). On read mismatch the bucket applies `onVersionMismatch`: `"discard"` silently invalidates (cache semantics), or a `StateMigrator` upgrades durable data that must not be lost.
- **Corruption.** A decode failure applies `onCorrupt`: `"quarantine"` renames the bad file to `<path>.corrupt-<timestamp>` and returns `default`/`null` (the scratch-registry behavior, generalized), `"discard"` resets silently, `"fail"` surfaces `StateStoreError`.
- **Locking.** `advisory` buckets serialize `update`/`modify` across processes with an `O_CREAT|O_EXCL` lockfile recording `{ pid, token, createdAt }`, stale-owner takeover (age threshold or dead pid via `kill(pid, 0)`), bounded retry/backoff, and token-checked release; the lock is acquired through `Scope` so interruption finalizes it. `none` buckets assume a single writer.
- **Containment.** The resolved `(root, namespace, key)` realpath MUST stay under the resolved root; `../`, absolute keys, and symlink escapes fail with `StateStoreError` (`reason: "path"`), mirroring the §9.7 plugin module-path containment rule.
- **Roots.** Root resolution flows through the Paths/Roots primitive (§7.5.1); `StateStore` never re-derives `$HOME` / XDG / `%APPDATA%`.
- **Codec-agnostic.** Built-in `json` and `binary` codecs cover most needs; a `custom` codec covers user-facing formats whose on-disk shape is a contract — the include lockfile (§7.7.4) supplies its existing block-style YAML renderer/parser as a custom codec so its file format is unchanged.

The errors live on the service surface as a single tagged `StateStoreError` carrying a `reason: "io" | "decode" | "lock" | "path" | "version"` discriminator plus `operation`, `path`, `cause`, and `remediation` (mirroring the single-error-with-`operation` shape the scratch registry uses today).

`StateStore` and `CacheService` stay distinct: the cache is in-memory, hot-path, and TTL-bounded; the store is durable, off the hot path, and schema-validated. Hot-path binary caches in §12.1 (`plan.bin`, `cwd-app-map.bin`) keep their existing readers under the §12.5 budgets and are not required to migrate; they MAY adopt `StateStore` later behind the same budgets.

#### 12.7.2 Reference consumers

The durable subsystems realized through `StateStore` include:

- **Scratch registry** (§21.11): a single `advisory`, `quarantine` bucket at `{ root: "userCache", namespace: "scratch", key: "registry.bin" }`; `read` is `get` with an empty-envelope default, and `upsert` / `remove` are `update`. The §21.11 token lockfile and corruption-quarantine behavior are now the store's.
- **Include lockfile** (§7.7.4): a `none`-lock bucket at `{ root: { app: appRoot }, key: ".lando.lock.yml" }` with a custom codec wrapping the existing renderer/parser, so the committed YAML is byte-for-byte unchanged while gaining the shared atomic-write and containment path.
- **Snapshot index** (§10.11.3): an app-scoped bucket indexing `DataMover` snapshots under `<userDataRoot>/snapshots/<app-id>/index.bin`; `listSnapshots`/`pruneSnapshots` read and update the bucket instead of a bespoke registry.
- **Managed-file ledger** (§10.13.3): an app-scoped `advisory`, `quarantine` bucket at `{ root: { path: <userDataRoot>/managed-files/<app-id> }, key: "ledger.json" }` (path from `PathsService.managedFileLedger`, §7.5.1) recording marker ownership, checksums, source hashes, and adopted/conflict state for `ManagedFileService`.

#### 12.7.3 Plugins and embedding hosts

Plugins receive a `stateStore` factory through `LandoPluginContext` (§9.8) **pre-namespaced** to `plugins/<plugin-id>/` under `userData`, so a plugin cannot read or clobber core state or another plugin's state. This is the supported way for a `SecretStore` to cache resolved tokens, an `UpdateService` to persist channel metadata, or a `ConfigTranslator` to write a sidecar lockfile. Embedding hosts (§16) resolve the `StateStore` tag from the runtime and MAY open buckets under `{ path: ... }` for per-tenant or per-test isolation, pairing with the §16.5 cache-root override. `@lando/core/testing` ships `TestStateStore` (in-memory, no disk; inspectable); `@lando/sdk/test` ships `runStateStoreContract` and `StateStoreContractHarness` for the disk and in-memory implementations.

---
