# Lando v4 — Caches and Persistence

> **Part 12 of 18** · [Index](./README.md)
> **Read next:** [13 Testing and Distribution](./13-testing-and-distribution.md)

This part defines Lando-owned caches, durable state, on-disk artifacts, atomicity, hot-path budgets, and offline behavior.

---

## 12. Caches and Persistence

### 12.1 Cache catalog

| Cache | Location | Encoding | Contract |
|---|---|---|---|
| `core-command` | embedded plus `<userCacheRoot>/command-cache.bin` | binary | Built-in command, alias, and docs metadata; invalidated by core version or clear. |
| `plugin-command` | `<userCacheRoot>/plugin-command-cache.bin` | binary | Sole metadata owner for precedence-merged bundled/external plugin commands; invalidated by plugin graph changes or clear. Executable external dispatch remains deferred (§9.7). |
| `app-command` | `<userCacheRoot>/apps/<app-id>/commands.bin` | binary | App tooling routing metadata and app-plan key; invalidated by relevant app inputs, rebuild, refresh, or clear. |
| `cwd-app-map` | `<userCacheRoot>/cwd-app-map.bin` | binary | Bounded CWD-to-app-root index with Landofile freshness metadata; stale entries fall back to discovery. |
| `plugin` | `<userCacheRoot>/plugin-cache.json` | JSON | Resolved manifests, dependency graph, and contribution index. |
| `app-plugin` | `<userCacheRoot>/apps/<app-id>/plugins.json` | JSON | App plugin lock resolution and local install metadata. |
| `app-plan` | `<userCacheRoot>/apps/<app-id>/plan.bin` | Effect Schema binary | Frozen `AppPlan`, provider id, compiled tooling graphs, expression ASTs, and fingerprints. |
| `global-app-plan` | `<userCacheRoot>/global/plan.bin` | Effect Schema binary | Cross-app-readable global `AppPlan` (§20.5), invalidated by global layers/config/contributions or lifecycle changes. |
| `global-app-info` | `<userCacheRoot>/global/info.json` | JSON | Last known global `ServiceInfo[]`. |
| `scratch-app-plan` | `<userCacheRoot>/scratch/<scratch-id>/plan.bin` | Effect Schema binary | Scratch `AppPlan`, tooling graphs, and expressions; removed atomically at destroy (§21.5). |
| `scratch-app-info` | `<userCacheRoot>/scratch/<scratch-id>/info.json` | JSON | Last known scratch `ServiceInfo[]`. |
| `scratch-build-results` | `<userCacheRoot>/scratch/<scratch-id>/build-results.bin` | binary | Scratch `BuildResult[]`, sharing content-addressed build keys with other app kinds. |
| `scratch-registry` | `<userCacheRoot>/scratch/registry.bin` | binary | Locked, corruption-quarantined scratch registry (§21.11). |
| `service-info` | `<userCacheRoot>/apps/<app-id>/info.json` | JSON | Last known user-app `ServiceInfo[]`. |
| `provider` | `<userCacheRoot>/provider-cache.json` | JSON | Provider availability and version metadata. |
| `command-registry-manifest` | embedded generated module | generated object | Built-in `LandoCommandSpec` projection for native routing; build-derived only and MUST NOT duplicate plugin metadata (§17.2). |
| `template-compile` | `<userCacheRoot>/templates/<engineId>/<contentHash>.bin` | binary | Cross-app compiled `CompiledTemplate` content (§7.3.2). |
| `template-render` | `<userCacheRoot>/templates/<engineId>/<contentHash>-<varsHash>.bin` | binary | Rendered output keyed by template and canonical resolved variables. |
| `host-proxy-allowlist` | `<userCacheRoot>/host-proxy-allowlist.bin` | binary | Canonical ids permitted through `HostProxyService.runLando` (§10.10). |
| `mcp-allowlist` | `<userCacheRoot>/mcp-allowlist.bin` | binary | Default non-destructive MCP command allowlist, refined by configured allow/deny policy (§10.14). |
| `tunnel-registry` | `<userCacheRoot>/tunnels/registry.bin` | binary | Locked detached-tunnel registry with redacted public summaries (§10.2.2). |
| `file-sync-sessions` | `<userCacheRoot>/file-sync/sessions/<app-id>.bin` | binary | Reconciliable per-app file-sync session metadata; survives stop but not destroy or plan rebuild (§10.6). |
| `build-results` | `<userCacheRoot>/apps/<app-id>/build-results.bin` | binary | Bounded build outcome index pointing to persistent transcripts (§6.13.5). |
| `update` | `<userCacheRoot>/update-cache.json` | JSON | Plugin update-channel metadata. |
| `tool-downloads` | `<userCacheRoot>/tool-downloads/<toolId>/<filename>` | raw binary | Checksum-keyed verified tool artifacts; matching pinned artifacts require no network (§10.3.4). |

Plugin-command compilation MUST derive ordered plugin identity, fingerprints, and command maps from the same resolved manifests. Duplicate command ids retain the first merged occurrence and the final index is deterministic. Router bootstrap validates known freshness metadata but MUST NOT parse Landofiles, resolve includes, import plugin modules, contact plugin sources, or initialize providers. Missing or stale app routing metadata omits app tooling and returns repair remediation rather than rebuilding on the hot path.

### 12.2 Cache encoding

Router and tooling hot-path caches MUST use binary encoding. `Bun.serialize` is permitted for private cache shapes; public contract caches such as `AppPlan` use Effect Schema binary encoding. A cache MUST NOT mix encodings.

Every cache is versioned. Binary files carry a cache identity, schema/Lando version, and optional freshness hash; mismatch or partial-write detection invalidates and regenerates without surfacing a user error. Command caches retain all inputs needed to validate routing freshness.

Tooling caches MUST contain only expression ASTs and static redacted metadata. They MUST NOT contain dynamic shell-variable results, decrypted secrets, host output, provider connection state, or status/precondition results.

### 12.3 Atomicity

`CacheService.writeAtomic` encodes before mutation, writes and syncs a sibling temporary file, then atomically renames it. In-process read/modify/write uses an Effect `Ref`. Crashes MUST leave either the prior complete cache or a regenerable invalid file, never a partial live value.

### 12.4 Persistent artifacts

| Location | Artifact class |
|---|---|
| `<userConfRoot>/config.yml`, `config.d/*.yml` | Global configuration layers. |
| `<userConfRoot>/global.config.yml` | Global-service enablement map (§20.3.1). |
| `<userCacheRoot>/logs/` | Core and file-sync logs under §10.9 retention. |
| `<userCacheRoot>/cwd-app-map.bin` | Router-phase CWD index. |
| `<userCacheRoot>/apps/<app-id>/` | User-app caches and provider workdir. |
| `<userCacheRoot>/templates/<engineId>/`, `includes/`, `tool-downloads/<toolId>/` | Cross-app derived and verified content. |
| `<userCacheRoot>/logs/file-sync/` | Retained file-sync daemon and engine logs. |
| `<userCacheRoot>/scratch/<scratch-id>/root/` | Materialized scratch app root, removed atomically at destroy. |
| `<userCacheRoot>/scratch/<scratch-id>/lock` | Per-scratch lifecycle lock. |
| `<userCacheRoot>/scratch/registry.bin`, `registry.lock` | Durable scratch registry and cross-process lock (§21.11). |
| `<userDataRoot>/plugins/`, `apps/<app-id>/plugins/`, `plugin-auth.json` | User and app plugins plus private-registry auth. |
| `<userDataRoot>/global/`, `global/.lando.dist.yml` | Global app root and generated contribution layer (§20.3). |
| `<userDataRoot>/keys/`, `certs/`, `bin/` | Managed SSH keys, certificates, and checksum/version-pinned helper binaries. |
| `<userDataRoot>/runtime/config/`, `bin/`, `storage/`, `run/`, `machines/` | Default-provider private config, binaries, storage, sockets/PIDs, and managed VM state. |
| `<userDataRoot>/run/<app-id>/host-proxy.sock` | Owner-only user-app host-proxy socket (§10.10). |
| `<userDataRoot>/run/scratch/<scratch-id>/host-proxy.sock` | Owner-only scratch host-proxy socket, removed at destroy or scope close. |
| `<userDataRoot>/run/tunnels/<session-id>.{pid,sock,json}` | Best-effort detached-tunnel process handles reconciled against `tunnel-registry`. |
| `<userDataRoot>/bin/mutagen[.exe]`, `bin/mutagen-agents/` | Isolated verified Mutagen host and guest binaries; never sourced from containers. |
| `<userDataRoot>/run/file-sync/daemon.sock`, `daemon.pid` | Lando-owned file-sync daemon endpoint and orphan-detection PID; Windows uses the corresponding named pipe. |
| `<userDataRoot>/file-sync/mutagen-data/` | Opaque embedded-Mutagen state; uninstall owns final removal. |
| `<userDataRoot>/builds/<app-id>/...`, `builds/global/...`, `builds/scratch/...` | Per-step build transcripts, never telemetry; user/global retention follows build policy and scratch transcripts disappear at destroy (§6.13.6). |
| `<userDataRoot>/snapshots/<app-id>/<store>/<snapshot-id>.<format>` | Snapshot archives and `SnapshotInfo` sidecars; survives ordinary destroy and is purged explicitly (§10.11). |
| `<userDataRoot>/snapshots/<app-id>/index.bin` | `StateStore` snapshot index. |
| `<userDataRoot>/managed-files/<app-id>/ledger.json` | `ManagedFileService` ownership ledger through `StateStore` (§10.13). |
| `<systemPluginRoot>/plugins/` | Read-only system-installed plugins. |
| State-store transaction journal | Owner-only managed-file transaction plan and recovery state. |
| `<target>.lando-stage.<transaction-id>` | Same-directory owner-only staged target with recorded digest and mode. |
| `<file>.bak.<full-before-sha256>` | Immutable digest-named backup retained until user removal. |

#### 12.4.1 Managed-file transaction lifecycle

Explicit conversion and migration (§7.4.1, §8.2.1) MUST use the private `@lando/managed-file` transaction coordinator with `ManagedFileService`, `FileSystem`, and `StateStore`; commands and translators MUST NOT bypass it. It locks the canonical app root, rejects source/destination symlinks, and requires targets, backups, and stage parents to remain under that root. Only the journal under the state-store root is exempt.

Every existing regular input MUST have an immutable digest-named backup. Reuse requires exact digest, regular non-symlink type, and owner-safe mode. Stages are exclusive and same-directory. Existing nonsecret outputs preserve mode; new outputs are restrictive; secret outputs are owner-only. Raw bytes and secrets MUST NOT enter events, diagnostics, telemetry, transcripts, or journals (§3.5, §3.7).

The journal state is `prepared` → `committing` → `committed` or `blocked`. Before mutation, a complete ordered before/after plan MUST be durably recorded. Commit rechecks digests around each rename and durably records completion before cleanup. Recovery derives applied operations from recorded before/after state, MUST preflight every path, and MUST NOT overwrite concurrent edits forward or backward. Conflicts preserve user files and mark `blocked`; cooperative locking is not filesystem-wide atomicity against noncooperative editors.

A crash before `prepared` MUST alter no target. Unjournaled stages MUST NOT be guessed or auto-deleted. Recovery and scoped cancellation remove only identity- and digest-verified owned stages. Committed journals are removed after cleanup; immutable backups remain. A transaction guard MUST run before native loading and start, recovering safely or refusing blocked state. Dry-run reports recovery but MUST NOT lock for writing or mutate anything.

### 12.5 Hot-path read budgets

Warm router reads of core, plugin, app-command, and CWD-map indexes MUST complete in under 30 ms. Warm tooling reads of `app-plan` and compiled `ToolingProgram` MUST independently complete in under 30 ms. No provider contact, include resolution, expression parsing, or graph construction occurs on these paths. The perf-budget suite enforces both (§13.1), alongside the user-visible budgets in §2.1.

### 12.6 Disconnectable local-dev state

After successful materialization/build, resolved plugins and includes, provider metadata and artifacts, app-plan/tooling caches, and service information required for routine development MUST be local. `start`, `stop`, `restart`, `info`, `logs`, and cached tooling MUST work without network access when state is complete.

Missing managed dependencies fail with a tagged error naming the missing artifact and online repair command. Routine offline-capable commands MUST NOT silently retry the network. Telemetry and update checks are best-effort and MUST NOT invalidate caches or alter local-command exit status.

### 12.7 State store

`CacheService` is the process-lifetime memo and raw atomic-cache service. `StateStore` is the level-`minimal` core Effect service for durable, schema-validated, versioned, atomic, optionally cross-process-locked files (§3.4). It is host/test-overridable but MUST NOT be a plugin contribution surface (§4.2).

#### 12.7.1 Buckets

`StateStore.open` accepts `StateBucketSpec` and returns `StateBucket`. Named contracts are `StateRoot`, `StateCodec`, `StateBucketSpec`, `StateBucket`, `StateMigrator`, and tagged `StateStoreError`. A bucket maps to exactly one contained file; opening resolves and validates the path without reading.

`StateRoot` selects user data/cache/config, an app root, or an explicit host path. `StateCodec` is `json`, `binary`, or a custom codec for a user-facing stable format. `StateBucketSpec` names root, optional namespace, single-segment key, Effect Schema, version, codec, lock policy, corruption/version policy, and optional default. `StateBucket` exposes `path`, `get`, `set`, `update`, `modify`, `remove`, and `exists`.

All mutations encode before atomic replace. Version mismatch either discards or runs `StateMigrator`. Corruption policy is quarantine, discard, or fail. Advisory locking serializes mutation across processes, is scope-acquired, and uses bounded stale-owner recovery. Resolved paths MUST remain under their root; traversal, absolute keys, and symlink escapes fail with `StateStoreError` reason `path`. Roots MUST come from §7.5.1. `StateStoreError` also distinguishes `io`, `decode`, `lock`, and `version` and carries operation, path, cause, and remediation.

Hot-path caches remain under their existing readers and MAY adopt `StateStore` only while preserving §12.5 budgets.

#### 12.7.2 Reference consumers

The scratch registry uses an advisory, quarantining bucket; the include lockfile uses an app-root custom YAML codec without advisory locking; snapshot indexes use app-scoped buckets; and the managed-file ledger uses an advisory, quarantining bucket. These subsystems MUST NOT implement bespoke persistence primitives.

#### 12.7.3 Plugins and embedding hosts

Plugins receive a `stateStore` factory pre-namespaced to `plugins/<plugin-id>/` under user data and MUST NOT access core or other-plugin state (§9.8). Embedding hosts MAY open explicitly isolated buckets (§16.5). `@lando/core/testing` supplies `TestStateStore`; `@lando/sdk/test` supplies `runStateStoreContract` and `StateStoreContractHarness`.

---
