# Lando v4 — Caches and Persistence

> **Part 12 of 16** · [Index](./README.md)
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
| `service-info` | `<userCacheRoot>/apps/<app-id>/info.json` | JSON | Last known `ServiceInfo[]` for fast `info`/`list` | Start, stop, restart, rebuild, destroy |
| `provider` | `<userCacheRoot>/provider-cache.json` | JSON | Provider availability + version metadata | `setup`, provider config change, `--clear` |
| `oclif-manifest` | embedded in binary + `<userCacheRoot>/oclif-manifest.bin` | binary | OCLIF adapter shim cache derived from core/plugin/app command indexes | Plugin install/remove, app command index change |
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
| `<userConfRoot>/config.d/*.yml` | Layered global config |
| `<userCacheRoot>/` | Cache root |
| `<userCacheRoot>/logs/` | Core log files |
| `<userCacheRoot>/cwd-app-map.bin` | Bounded LRU mapping of cwd → resolved app root for fast router-phase lookup (§12.1) |
| `<userCacheRoot>/apps/<app-id>/` | Per-app caches and provider workdir |
| `<userDataRoot>/` | Persistent data root |
| `<userDataRoot>/plugins/` | User-installed plugin packages (read-write; written by `meta:plugin:add`) |
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
| `<systemPluginRoot>/plugins/` | System-installed plugins (read-only from Lando; populated by OS package managers or admins; see §7.5 for the platform defaults that resolve `<systemPluginRoot>`) |

### 12.5 Hot-path read budgets

Reading the core/plugin/app command indexes plus the `cwd-app-map` lookup during router bootstrap MUST complete in under 30 ms on a warm filesystem. After a tooling command resolves, reading the app-plan cache and compiled `ToolingProgram` at bootstrap level `tooling` MUST also complete in under 30 ms on a warm filesystem. The binary encoding rule in §12.2, the `cwd-app-map` short-circuit in §12.1, and the lack of any provider contact at these levels make this achievable. Tooling includes, Landofile `includes:` resolution (against the cache + lockfile per §7.7), expression parsing, and task graph construction happen when the app plan is built or invalidated, not on the warm tooling hot path.

Hot-path budgets are enforced by the perf-budget test layer (§13.1). Read regressions surface there before they regress the user-visible §2.1 budgets.

### 12.6 Disconnectable local-dev state

After a successful app materialization/build, Lando-owned state required for routine local development MUST be present on disk: resolved app plugins, resolved includes, provider metadata, app-plan/tooling caches, service info cache, and provider artifacts that Lando itself was responsible for pulling or building. Routine commands (`start`, `stop`, `restart`, `info`, `logs`, and cached tooling) must work without network access when that state is complete.

If an offline command needs a missing Lando-managed dependency, Lando fails with a tagged error explaining which cache/artifact is missing and which online command will repair it. Lando MUST NOT silently attempt repeated network retries for routine offline-capable commands.

Telemetry and update checks are queued/best-effort. Failure to reach telemetry or update endpoints never invalidates local caches and never changes a local-dev command's exit code.

---
