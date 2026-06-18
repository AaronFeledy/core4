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
| `scratch-registry` | `<userCacheRoot>/scratch/registry.bin` | binary | Single-file registry of every scratch app on the host (§21.11). One entry per id with source, isolation, owning PID, status, root path, host-proxy socket, timestamps. Read by `apps:scratch:list` and `apps:scratch:gc`; written atomically per `CacheService.writeAtomic` (§12.3) plus a fcntl-style lockfile at `<userCacheRoot>/scratch/registry.lock` for cross-process serialization | Every `ScratchAppService` lifecycle transition; corruption quarantines the file to `registry.bin.corrupt-<timestamp>` and rebuilds empty so a label-driven `apps:scratch:gc` can recover orphans (§21.14 `ScratchRegistryCorruptError`) |
| `service-info` | `<userCacheRoot>/apps/<app-id>/info.json` | JSON | Last known `ServiceInfo[]` for fast `info`/`list` | Start, stop, restart, rebuild, destroy |
| `provider` | `<userCacheRoot>/provider-cache.json` | JSON | Provider availability + version metadata | `setup`, provider config change, `--clear` |
| `oclif-manifest` | embedded in binary + `<userCacheRoot>/oclif-manifest.bin` | binary | OCLIF adapter shim cache derived from core/plugin/app command indexes | Plugin install/remove, app command index change |
| `template-compile` | `<userCacheRoot>/templates/<engineId>/<contentHash>.bin` | binary | Compiled `CompiledTemplate` blobs per `TemplateEngine` (§7.3.2). Content-addressed by canonical template-content hash; cross-app | Template content change (hash mismatch), engine version change, `--clear` |
| `template-render` | `<userCacheRoot>/templates/<engineId>/<contentHash>-<varsHash>.bin` | binary | Rendered template output. Content-addressed by template content hash + canonical resolved-vars hash; cross-app | Template content change, resolved `vars:` change, render context schema/version change, `--clear` |
| `host-proxy-allowlist` | `<userCacheRoot>/host-proxy-allowlist.bin` | binary | Generated allowlist of canonical command ids that the in-container `lando` shim may forward via `HostProxyService.runLando` (§10.10). Built from every `LandoCommandSpec` with `hostProxyAllowed: true` (§8.3), every plugin command with the same flag, and every per-app tooling task with `hostProxyAllowed: true` (§8.5) | Plugin install/remove/update, app command index change, app-plan rebuild, `--clear` |
| `ambient-state` | `<userCacheRoot>/apps/<app-id>/ambient-state.bin` | binary | Per-app shell-integration state (§8.2.5): the encoded `HostEnvProjection` (host-shell env keys/values, the full mode-independent shim inventory, the shim-dir path) plus the **precomputed trust bit and host-wide `ambient.enabled`/`ambient.shims` flags**. This is the ONLY file the per-prompt `meta:ambient:export` reads (alongside the binary `cwd-app-map` lookup) — binary because it is read on the level-`none` hot path, which has no Effect runtime and must not parse YAML (§3.2, §12.5). Materialized by `app:start` / `app:cache:refresh`; the trust/flag fields are re-emitted (without a full app-plan rebuild) by `lando ambient allow`/`deny` and by `meta config` writes touching `ambient.*` | App-plan rebuild, `app:cache:refresh`, `app:destroy`, Landofile `ambient:`/`env:` change, `ambient allow`/`deny`, `meta config` `ambient.*` write, `--clear` |
| `ambient-manifest` (debug mirror) | `<userCacheRoot>/apps/<app-id>/ambient.json` | JSON | Human-readable mirror of `ambient-state.bin`, written alongside it for `cat`-debugging only. **Never on a read path** — no command consumes it at runtime; it exists so a developer can inspect what ambient mode would export. Safe to delete | Rewritten whenever `ambient-state` is, `--clear` |
| `file-sync-sessions` | `<userCacheRoot>/file-sync/sessions/<app-id>.bin` | binary | Per-app `FileSyncEngine` session metadata (§10.6): engine id, engine-issued session id, source path (with `${HOME}` normalized), target shape (volume name or service path), mode, canonicalized excludes hash, `mountKey`, last-known status. Read at `app:start` to reconcile or recreate sessions, written at every `pre-/post-file-sync-*` event, read at `app:stop` to terminate cleanly. Survives `lando stop`; cleared by `lando destroy` and by app-plan rebuild | App-plan rebuild, `app:cache:refresh`, `app:destroy`, engine version change, `--clear` |
| `build-results` | `<userCacheRoot>/apps/<app-id>/build-results.bin` | binary | Per-app `BuildResult[]` index (§6.13.5): for each `(service, phase, buildKey)`, the most recent `complete` and `fail` outcomes with `exitCode`, `durationMs`, `artifactRef` (artifact phase), `transcriptPath` pointer, and `completedAt`. Bounded per `(service, phase, buildKey)`: the most recent N=10 `complete` and N=5 `fail` entries are kept (configurable via `build.transcripts.keep*` global). Read by `BuildOrchestrator` at `pre-build-phase` to short-circuit unchanged steps; written on every `build-step-complete` / `build-step-fail`. The cache stores only the index — actual transcripts live as the persistent artifact in §12.4. | `app:rebuild`, `app:destroy`, `app:cache:refresh --rebuild`, build orchestrator schema/version change, `--clear` |
| `update` | `<userCacheRoot>/update-cache.json` | JSON | Plugin update channel metadata | `update`, scheduled refresh |

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
| `<userConfRoot>/ambient-trust.yml` | Ambient-mode trust ledger (§8.2.5): `{ <absolute-app-root>: { allowedAt } }` map, written by `lando ambient allow`, pruned by `lando ambient deny`. Non-expiring until revoked; keyed on resolved absolute app root. Gates whether the shell integration may export an app's env/shims |
| `<userConfRoot>/config.d/*.yml` | Layered global config |
| `<userCacheRoot>/` | Cache root |
| `<userCacheRoot>/logs/` | Core log files |
| `<userCacheRoot>/cwd-app-map.bin` | Bounded LRU mapping of cwd → resolved app root for fast router-phase lookup (§12.1) |
| `<userCacheRoot>/templates/<engineId>/` | Cross-app `template-compile` and `template-render` caches per engine (§12.1) |
| `<userCacheRoot>/apps/<app-id>/` | Per-app caches and provider workdir |
| `<userCacheRoot>/apps/<app-id>/ambient-state.bin` | Per-app binary shell-integration state consumed by the per-prompt `meta:ambient:export`; encodes the `HostEnvProjection` plus the precomputed trust bit and host-wide mode flags (§8.2.5, §12.1) |
| `<userCacheRoot>/apps/<app-id>/ambient.json` | Human-readable debug mirror of `ambient-state.bin`; never read at runtime (§8.2.5, §12.1) |
| `<userCacheRoot>/apps/<app-id>/bin/` | Per-app ambient-mode shim directory (one dispatcher per tooling task); **always materialized** from the app command index at `app:start` / `app:cache:refresh` regardless of the active ambient mode, so the cache survives an `ambient.shims` flip. Whether it is prepended to `PATH` is decided per prompt from the flags in `ambient-state.bin` (§8.2.5) |
| `<userDataRoot>/` | Persistent data root |
| `<userDataRoot>/plugins/` | User-installed plugin packages (read-write; written by `meta:plugin:add`) |
| `<userDataRoot>/global/` | App root for the global Lando app (§20.3); contains the six-file merge layers and plugin-generated `dist` layer |
| `<userDataRoot>/global/.lando.dist.yml` | Plugin-contributed canonical layer for the global Landofile, regenerated by `GlobalAppService.regenerateDist` from every enabled `globalServices:` contribution; carries a `# DO NOT EDIT — regenerated by Lando` header (§20.3) |
| `<userDataRoot>/apps/<app-id>/plugins/` | App-scoped plugin packages resolved from a Landofile `plugins:` block |
| `<userDataRoot>/plugin-auth.json` | npm-style auth for private registries |
| `<userDataRoot>/keys/` | Lando-managed SSH keys |
| `<userDataRoot>/bin/` | Lando-managed binary helpers (per-platform) |
| `<userDataRoot>/certs/` | CA + leaf certificates |
| `<userDataRoot>/runtime/` | Default provider private runtime root |
| `<userDataRoot>/runtime/config/` | Default provider private config (registries, policy) |
| `<userDataRoot>/runtime/bin/` | Private Podman and helper binaries |
| `<userDataRoot>/runtime/storage/` | Private container image and volume storage |
| `<userDataRoot>/runtime/run/` | Private API socket and PID files (Linux; inside VM on macOS/Windows) |
| `<userDataRoot>/runtime/machines/` | Managed VM state (macOS and Windows only) |
| `<userDataRoot>/run/<app-id>/host-proxy.sock` | Per-app `HostProxyService` Unix socket (mode `0600`). Bound at `app:start`, unlinked at `app:stop` or scope finalization (§10.10) |
| `<userDataRoot>/bin/mutagen[.exe]` | Mutagen host CLI used by the bundled `@lando/file-sync-mutagen` engine (§10.6.2). Downloaded by `lando setup` against the plugin's pinned checksum manifest. NOT a system Mutagen install — bit-for-bit isolated from any user-installed copy |
| `<userDataRoot>/bin/mutagen-agents/mutagen-agent-<platform>` | Per-platform Mutagen agent binaries deployed into containers by the engine via `RuntimeProvider.run`. One binary per Lando-supported guest platform target (`linux-amd64`, `linux-arm64`, `linux-armv7`). Downloaded alongside the host CLI; checksum-verified; never replaced from inside a container |
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
| `<systemPluginRoot>/plugins/` | System-installed plugins (read-only from Lando; populated by OS package managers or admins; see §7.5 for the platform defaults that resolve `<systemPluginRoot>`) |

### 12.5 Hot-path read budgets

Reading the core/plugin/app command indexes plus the `cwd-app-map` lookup during router bootstrap MUST complete in under 30 ms on a warm filesystem. After a tooling command resolves, reading the app-plan cache and compiled `ToolingProgram` at bootstrap level `tooling` MUST also complete in under 30 ms on a warm filesystem. The binary encoding rule in §12.2, the `cwd-app-map` short-circuit in §12.1, and the lack of any provider contact at these levels make this achievable. Tooling includes, Landofile `includes:` resolution (against the cache + lockfile per §7.7), expression parsing, and task graph construction happen when the app plan is built or invalidated, not on the warm tooling hot path.

Hot-path budgets are enforced by the perf-budget test layer (§13.1). Read regressions surface there before they regress the user-visible §2.1 budgets.

### 12.6 Disconnectable local-dev state

After a successful app materialization/build, Lando-owned state required for routine local development MUST be present on disk: resolved app plugins, resolved includes, provider metadata, app-plan/tooling caches, service info cache, and provider artifacts that Lando itself was responsible for pulling or building. Routine commands (`start`, `stop`, `restart`, `info`, `logs`, and cached tooling) must work without network access when that state is complete.

If an offline command needs a missing Lando-managed dependency, Lando fails with a tagged error explaining which cache/artifact is missing and which online command will repair it. Lando MUST NOT silently attempt repeated network retries for routine offline-capable commands.

Telemetry and update checks are queued/best-effort. Failure to reach telemetry or update endpoints never invalidates local caches and never changes a local-dev command's exit code.

### 12.7 Owned host artifacts (`OwnedHostArtifactRegistry`)

§12.4 lists the files Lando writes **inside its own roots** (`<userCacheRoot>`, `<userDataRoot>`, `<userConfRoot>`). A distinct class of file is written into **user-visible, user-owned locations** — the shell-profile hook line, the per-app ambient shim directory and its `bin/` dispatchers, generated git-hook scripts under a repo's `.git/hooks/`, a generated `.env` or devcontainer file, CA cert files dropped into a project, and host-side `files:` outputs (a future surface). These are not caches: deleting them changes what the user sees, and overwriting one could clobber a file the user edited. They need an **ownership ledger** so Lando knows exactly what it wrote where, can verify it before touching it, and can reap it cleanly on `app:destroy`, `meta:uninstall`, or a feature opt-out.

`OwnedHostArtifactRegistry` is that ledger. It is an ownership/cleanup primitive — **not** a content engine. It does not render templates (it delegates to `TemplateRenderer`, §7.3.2) and does not implement atomic IO (it delegates to `CacheService.writeAtomic`, §12.3); it records *who wrote what, where, and whether it is safe to remove*.

```ts
// illustrative; OwnedHostArtifact record is core-internal at v4.0 (not an @lando/sdk schema)
interface OwnedHostArtifact {
  readonly path: AbsolutePath;            // resolved, realpath-normalized destination
  readonly owner: string;                 // contributing feature id, e.g. "ambient", "git-hooks", "ca-mkcert"
  readonly scope: "app" | "global" | "host";
  readonly appId?: string;                // present when scope === "app"
  readonly mode?: string;                 // POSIX mode for the written file
  readonly createdHash: string;           // SHA-256 of bytes Lando first wrote
  readonly lastWrittenHash: string;       // SHA-256 of bytes Lando most recently wrote
  readonly cleanup: "reap" | "keep" | "prompt";  // policy on destroy/uninstall/opt-out
  readonly writtenAt: string;
}

export class OwnedHostArtifactRegistry extends Context.Service<OwnedHostArtifactRegistry, {
  // write through the registry: renders+writes (via TemplateRenderer/CacheService), then records ownership
  readonly write:  (spec: OwnedHostArtifactSpec) => Effect.Effect<OwnedHostArtifact, HostArtifactError>;
  readonly list:   (filter?: OwnedHostArtifactFilter) => Effect.Effect<ReadonlyArray<OwnedHostArtifact>>;
  // reap respects the modification guard unless force is set
  readonly reap:   (filter: OwnedHostArtifactFilter, opts?: { force?: boolean }) => Effect.Effect<ReapReport, HostArtifactError>;
  readonly verify: (filter?: OwnedHostArtifactFilter) => Effect.Effect<ReadonlyArray<HostArtifactDrift>>;
}>()("@lando/core/OwnedHostArtifactRegistry") {}
```

Rules:

- **Ledger location.** The registry persists to `<userDataRoot>/owned-host-artifacts.bin` (binary, atomic per §12.3). It is data root, not cache root, because losing it would orphan user-visible files; `--clear` MUST NOT purge it.
- **Modification guard.** `reap` MUST refuse to delete an artifact whose on-disk bytes hash differently from `lastWrittenHash` (the user edited or replaced it) unless `force: true` is passed. `verify` reports these as `HostArtifactDrift` so `lando doctor` can surface "Lando wrote this file but you've since edited it." This is the rule that makes generating files into a user's repo safe.
- **Containment.** Every `path` is resolved with realpath and checked for symlink containment before any write or delete, reusing the local-`includes:` path-safety rules (§7.7.6). The registry MUST NOT follow a symlink out of the intended scope root, so a hostile symlink in `.git/hooks/` cannot redirect a reap to an arbitrary file.
- **Cleanup wiring.** `app:destroy` reaps `scope: "app"` artifacts for that app id (policy `reap`); `meta:uninstall` (§17.7) reaps `scope: "host"` and `scope: "global"` artifacts and is the authoritative answer to "what did Lando write onto this host?" — it enumerates the ledger in its `--dry-run` preview. A feature opt-out (e.g. `lando ambient deny`, disabling git-hooks) reaps just that owner's artifacts.
- **Not for cache/data-root files.** Files already covered by §12.1/§12.4 inside Lando's own roots are owned by their subsystem and are NOT entered in this ledger; the registry tracks only files written into user-owned locations. The ambient `bin/` shim dir and the shell-profile hook line ARE tracked here (they live in user space); the binary `ambient-state.bin` cache is NOT (it lives under `<userCacheRoot>`).
- **Not recipe scaffolds.** Files emitted by `apps:init` recipe scaffolds (§8.8) are intentionally the user's from birth and are NOT Lando-owned; a recipe MAY opt a specific generated file into the ledger only by declaring it reapable, which recipes do not do at v4.0.
- **SDK surface.** `OwnedHostArtifactRegistry`'s service tag is exported from `@lando/core/services` (§16.2) for embedding hosts that write host artifacts; the `OwnedHostArtifact` record stays a core-internal type at v4.0 (no `@lando/sdk` schema) until a second non-core consumer proves the shape, matching the §8.2.6 freeze discipline.

**Deliberately not persisted at v4.0.** Two adjacent surfaces have **no** cache or persistent artifact: (1) `CheckRunner` results (§10.11) are computed per `app:hooks:run` / `app:test` invocation and rendered/returned, not cached — a `check-results` cache is a future optimization that would key on a content hash of the inputs (the same up-to-date discipline as `build-results`, §12.1), but v4.0 re-runs checks every time. (2) Supervised-process state (§10.13) is **foreground/scope-bound in-memory state** held by `ProcessRegistry` for the duration of an `app:processes:start` session; there is no on-disk registry of running processes at v4.0 because there is no daemon to own it. The detached/background process registry — and the persistent state file it would require — is deferred to the post-v4.0 persistent-agent work (§14.2). Secret values resolved through `SecretStoreRegistry` (§3.4, §7.3.1) are **never** written to any cache or artifact in this catalog, decrypted or otherwise.

---
