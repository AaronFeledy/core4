# Lando v4: Caches and Persistence

> **Part 12 of 19** · [Index](./README.md)
> **Read next:** [13 Testing and Distribution](./13-testing-and-distribution.md)

This part defines Lando-owned caches, durable state, on-disk artifacts, atomicity, hot-path budgets, and offline behavior.

---

## 12. Caches and Persistence

### 12.1 Cache catalog

| Cache | Location | Encoding | Contract |
|---|---|---|---|
| `core-command` | embedded plus `<userCacheRoot>/command-cache.bin` | binary | Built-in command, alias, and docs metadata; invalidated by core version or clear. |
| `plugin-command` | `<userCacheRoot>/plugin-command-cache.bin` | binary | Sole metadata owner for precedence-merged bundled/external plugin commands; invalidated by plugin graph changes or clear. External plugin commands contribute metadata only; executable dispatch of them is governed by §9.7. |
| `app-command` | `<userCacheRoot>/apps/<app-id>/commands.bin` | binary | App tooling routing metadata and app-plan key; invalidated by relevant app inputs, rebuild, refresh, or clear. |
| `cwd-app-map` | `<userCacheRoot>/cwd-app-map.bin` | binary | Bounded CWD-to-app-root index with Landofile freshness metadata; stale entries fall back to discovery. |
| `plugin` | `<userCacheRoot>/plugin-cache.json` | JSON | Resolved manifests, dependency graph, and contribution index. |
| `app-plugin` | `<userCacheRoot>/apps/<app-id>/plugins.json` | JSON | App plugin lock resolution and local install metadata. |
| `app-plan` | `<userCacheRoot>/apps/<app-id>/plan.bin` | Effect Schema binary | Frozen `AppPlan`, provider id, compiled tooling graphs, expression ASTs, and fingerprints, plus the host-path shadow eligibility verdicts behind its storage shadows; a changed verdict invalidates the entry. The key includes the environment dependencies of app-feature `fromConfig` selectors, captured once for both key derivation and selector evaluation: statically referenced names, with unset values distinct from strings, or the complete captured environment when a selector reads it whole or by computed member. The key MUST also include §7.4.2 input/metadata/translator/context fingerprints and generated-output digests; changed fingerprints invalidate it. Environment and credential values are stored as `EnvironmentValue` descriptors (§7.3.1); the key and record hash descriptors, never resolved bytes. No session secrets or live endpoints. |
| `remote-metadata` | `<userCacheRoot>/apps/<app-id>/remote-metadata.bin` | Effect Schema binary | Nonsecret translation snapshots keyed by source/config identity, resolved remote, environment, branch, and schema version, carrying revision/content digest (§7.4.2). Only explicit translation refresh, the initial refresh of pull-with-code or switch, and §8.8.13 init materialization MAY fetch and populate it, always under the final app identity; no TTL network refresh on routine lifecycle commands. |
| `global-app-plan` | `<userCacheRoot>/global/plan.bin` | Effect Schema binary | Cross-app-readable global `AppPlan` (§20.5), invalidated by global layers/config/contributions or lifecycle changes. |
| `global-app-info` | `<userCacheRoot>/global/info.json` | JSON | Last known global `ServiceInfo[]`. |
| `scratch-app-plan` | `<userCacheRoot>/scratch/<scratch-id>/plan.bin` | Effect Schema binary | Scratch `AppPlan`, tooling graphs, and expressions; removed atomically at destroy (§21.5). |
| `scratch-app-info` | `<userCacheRoot>/scratch/<scratch-id>/info.json` | JSON | Last known scratch `ServiceInfo[]`. |
| `scratch-build-results` | `<userCacheRoot>/scratch/<scratch-id>/build-results.bin` | binary | Scratch `BuildResult[]`, sharing content-addressed build keys with other app kinds. |
| `scratch-registry` | `<userCacheRoot>/scratch/registry.bin` | binary | Locked, corruption-quarantined scratch registry (§21.11). |
| `service-info` | `<userCacheRoot>/apps/<app-id>/info.json` | JSON | Last known user-app `ServiceInfo[]`. |
| `provider` | `<userCacheRoot>/provider-cache.json` | JSON | Provider availability and version metadata. |
| `command-registry-manifest` | embedded generated module | generated object | Built-in `LandoCommandSpec` projection for native routing; build-derived only and MUST NOT duplicate plugin metadata (§17.2). |
| `compiled-decoders` | embedded generated module | generated JavaScript plus declaration | Ahead-of-time compiled decoders for the fixed hot-path schema list (§2.5, §12.5); build-derived only, installed by the compiled CLI entry, never read from disk at runtime (§17.2). |
| `template-compile` | `<userCacheRoot>/templates/<engineId>/<contentHash>.bin` | binary | Cross-app compiled `CompiledTemplate` content (§7.3.2). |
| `template-render` | `<userCacheRoot>/templates/<engineId>/<contentHash>-<varsHash>.bin` | binary | Rendered output keyed by template and canonical resolved variables. |
| `host-proxy-allowlist` | `<userCacheRoot>/host-proxy-allowlist.bin` | binary | Canonical ids permitted through `HostProxyService.runLando` (§10.10). |
| `mcp-allowlist` | `<userCacheRoot>/mcp-allowlist.bin` | binary | Default non-destructive MCP command allowlist, refined by configured allow/deny policy (§10.14). |
| `tunnel-registry` | `<userCacheRoot>/tunnels/registry.bin` | binary | Locked detached-tunnel registry with redacted public summaries (§10.2.2). |
| `file-sync-sessions` | `<userCacheRoot>/file-sync/sessions/` | opaque | The bundled file-sync engine's configured `MUTAGEN_DATA_DIRECTORY`: daemon session history that is durable state, not regenerable plan-cache metadata. Stop, rebuild, and plan-cache invalidation MUST preserve it; verified disposal at destroy retires the app's session state (§10.6.2, §12.4). Listed here for its location only. |
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
| `<userCacheRoot>/logs/<label>-worker-<app-id>.log` | Detached host-proxy and agent-relay stderr. Owner-only `0600` on POSIX, verified private ACL on Windows; no symlink or non-regular target. Lando-created log directory `0700`; outer failures and error tails redacted (§10.4, §10.10.2). |
| `<userCacheRoot>/cwd-app-map.bin` | Router-phase CWD index. |
| `<userCacheRoot>/apps/<app-id>/` | User-app caches and provider workdir. |
| `<userCacheRoot>/templates/<engineId>/`, `includes/`, `tool-downloads/<toolId>/` | Cross-app derived and verified content. |
| `<userCacheRoot>/logs/file-sync/` | Retained file-sync daemon and engine logs. |
| `<userCacheRoot>/scratch/<scratch-id>/root/` | Materialized scratch app root, removed atomically at destroy. |
| `<userCacheRoot>/scratch/<scratch-id>/lock` | Per-scratch lifecycle lock. |
| `<userCacheRoot>/scratch/registry.bin`, `registry.lock` | Durable scratch registry and cross-process lock (§21.11). |
| `<userDataRoot>/plugins/`, `apps/<app-id>/plugins/`, `plugin-auth.json` | User and app plugins plus private-registry auth. |
| `<userDataRoot>/global/`, `global/.lando.dist.yml` | Global app root and generated contribution layer (§20.3). |
| `<userDataRoot>/keys/`, `certs/`, `bin/` | Managed SSH keys (the §10.4 managed identity), certificates, and checksum/version-pinned helper binaries. |
| `<userDataRoot>/secrets/` | Persistent writable `lando` user-grant store (§9.5.1), including refresh grants: private directory, owner-only files, locked atomic replacement; excluded from managed-file backups, journals, exports, and support bundles. Access tokens/resource credentials remain session-only. |
| `<userDataRoot>/runtime/config/`, `bin/`, `storage/`, `run/`, `machines/` | Default-provider private config, binaries, storage, sockets/PIDs, and managed VM state. |
| `<userDataRoot>/run/<app-id>-<root-hash>/host-proxy.sock` | Owner-only host-proxy socket for a user or scratch app (§10.10). `<root-hash>` is the first 12 hex digits of the SHA-256 of the app root. Removed at stop, destroy, or scratch scope close. |
| `<userDataRoot>/run/<app-id>-<root-hash>/worker.json` | Owner-only host-proxy worker record (§10.10.1): pid, transport endpoint, protocol version, configuration digest, and the session id, bearer token, and control token a later start reuses. Removed at stop, destroy, uninstall, or replacement. |
| `<userDataRoot>/run/<app-id>-<root-hash>-<kind>-agent/worker.json` | Owner-only SSH or gpg relay worker record (§10.4): pid, control endpoint and token, delivered mount, protocol version, and configuration digest. Removed with the relay directory at stop, destroy, or uninstall; replacement keeps the mounted directories. |
| `<userDataRoot>/run/tunnels/<session-id>.{pid,sock,json}` | Best-effort detached-tunnel process handles reconciled against `tunnel-registry`. |
| `<userDataRoot>/bin/mutagen[.exe]`, `bin/mutagen-agents/` | Isolated verified Mutagen host and guest binaries; never sourced from containers. |
| `<userDataRoot>/run/file-sync/daemon.sock`, `daemon.pid` | Lando-owned file-sync daemon endpoint and orphan-detection PID; Windows uses the corresponding named pipe. |
| `<userDataRoot>/plugins/@lando/file-sync-mutagen/sessions/mutagen.json` | Plugin-private ledger of the bundled process client (§12.7.3): durable session ownership and app drain/disposal receipts. Survives stop, rebuild, and plan-cache invalidation; verified disposal retires the app's entries (§10.6.2). |
| `<userCacheRoot>/file-sync/sessions/` | Opaque embedded-Mutagen daemon history, the configured `MUTAGEN_DATA_DIRECTORY`. Durable, not a regenerable cache: stop, rebuild, and plan-cache invalidation MUST preserve it; uninstall owns final removal. |
| `<userDataRoot>/builds/<app-id>/...`, `builds/global/...`, `builds/scratch/...` | Per-step build transcripts, never telemetry; user/global retention follows build policy and scratch transcripts disappear at destroy (§6.13.6). |
| `<userDataRoot>/snapshots/<owner-key>/<store>/<id>.json` | Owner-keyed `SnapshotInfo` catalog sidecars, one fail-closed version-1 JSON `StateStore` bucket per snapshot; no separate index (§10.11.2). |
| `<userDataRoot>/snapshots/<owner-key>/<store>/<id>.<format>` | Copy-mode snapshot archives beside their sidecars. Snapshots survive ordinary destroy; explicit purge and pruning, including automatic recovery retention, remove them (§10.11.2). |
| `<userDataRoot>/managed-files/<app-id>/ledger.json` | `ManagedFileService` ownership ledger through `StateStore` (§10.13). |
| `<systemPluginRoot>/plugins/` | Read-only system-installed plugins. |
| State-store transaction journal | Owner-only managed-file transaction plan and recovery state. |
| `<target>.lando-stage.<transaction-id>` | Same-directory owner-only staged target with recorded digest and mode. |
| `<file>.bak.<full-before-sha256>` | Immutable digest-named backup retained until user removal. |
| Provider-private `resource-ownership` namespace | Durable ownership manifest, one JSON document per canonical owner (§12.4.2). Not a fingerprint cache. |
| `<userDataRoot>/accelerated-starts/<sha256(appRootIdentityKey)>.json` | Accelerated-start journal (§10.6.3): one owner-only (`0600`) JSON document per app root, version 2, advisory-locked, fail-closed on corruption; version 1 documents are migrated when read and the version 2 representation is persisted on the next journal mutation. Holds the attempt id, app, root, provider, engine, mount-plan digest, phase, and planned target and session identities. Survives stop and every failed or interrupted start; destroy or a successful provider apply completes it. |

`lando-session` values and metadata MUST NOT persist. Private config payloads, stages, backups, and snapshots (§10.12.7) are distinct from credential stores and from caches/logs; approved payload persistence MUST NOT authorize storing control-plane grants or access tokens in them.

#### 12.4.1 Managed-file transaction lifecycle

Conversion and migration (§7.4.1, §8.2.1), and every declared translation materialization (§7.4.2), MUST use the private `@lando/managed-file` transaction coordinator with `ManagedFileService`, `FileSystem`, and `StateStore`. This includes explicit refresh, init, automatic lifecycle refresh, and both code-sync commands; commands, lifecycle handlers, and translators MUST NOT bypass it. It locks the canonical app root, rejects source/destination symlinks, and requires targets, backups, and stage parents to remain under that root. Only the journal under the state-store root is exempt.

Init acquisition and pure preview are not generated-file materialization. Init MUST place permitted source files and establish the final canonical root before committing generated fragments/Landofiles through this coordinator (§8.8.13). It MUST NOT create transaction or ownership records in an acquisition-cache root and relocate them later. Failures after source placement MUST retain truthful side-effect/recovery context rather than promise whole-init rollback.

Every existing regular input MUST have an immutable digest-named backup. Reuse requires exact digest, regular non-symlink type, and owner-safe mode. Stages are exclusive and same-directory. Existing nonsecret outputs preserve mode; new outputs are restrictive; secret outputs are owner-only. Raw bytes and secrets MUST NOT enter events, diagnostics, telemetry, transcripts, or journals (§3.5, §3.7).

For config datasets, every secret-bearing target, stage, backup, and snapshot MUST pass §10.12.7 before mutation: owner-only file access, owner-controlled repository parents without group/world write access, containment, gitignore coverage for each repository path, and export/support-bundle exclusion. Repository parents MAY be `0755`; Lando-owned secret-storage directories MUST remain private, with equivalent protections through Windows ACLs. Ignoring the target alone MUST NOT authorize a sibling stage or backup. An unsafe required backup MUST block the transaction, not be skipped or written publicly.

The journal state is `prepared` → `committing` → `committed` or `blocked`. Before mutation, a complete ordered before/after plan MUST be durably recorded. Commit rechecks digests around each rename and durably records completion before cleanup. Recovery derives applied operations from recorded before/after state, MUST preflight every path, and MUST NOT overwrite concurrent edits forward or backward. Conflicts preserve user files and mark `blocked`; cooperative locking is not filesystem-wide atomicity against noncooperative editors.

A crash before `prepared` MUST alter no target. Unjournaled stages MUST NOT be guessed or auto-deleted. Recovery and scoped cancellation remove only identity- and digest-verified owned stages. Committed journals are removed after cleanup; immutable backups remain. A transaction guard MUST run before native loading and start, recovering safely or refusing blocked state. Dry-run reports recovery but MUST NOT lock for writing or mutate anything.

#### 12.4.2 Durable ownership manifest

This durable provider-private identity record lets stop, destroy, and a converging start finish when a failed or interrupted attempt left resources in place (§5.3.1, §6.7). It survives app-plan cache invalidation. Verified absent or removed containers and private networks are retired; volume identities remain until the existing volume flags select their cleanup.

| Field | Contract |
|---|---|
| Namespace | `resource-ownership` on the provider-private `ctx.stateStore`, keyed by canonical owner. |
| Document | One JSON object per owner, version 1. |
| Mode | `0600`. |
| Lock | Advisory. |
| Corruption or version mismatch | Fail closed. Do not treat the hint as absent. |
| Payload | Container, private-network, and volume identities and digests only, with expected app, provider, root, and owner, and the actual physical name. No raw config, no per-value hashes, no resolved secret values. |

`ResourceOwnership` (`appRoot`, `ownerKey`, `providerId`, `appIds`) is the summary hint. `OwnedResourcesCleanupResult` (`servicesRemoved`, `networksRemoved`, `volumesRemoved`) is the verified cleanup result. `RuntimeProviderContribution.resourceOwnership(ctx, root)` reads this namespace from the filesystem and MUST NOT construct, initialize, or contact a runtime. The global app root's inventory is scoped to the realized global provider, or the host provider when no applied global plan exists (§5.3.1). Cleanup MUST verify ownership labels before mutation; recorded names alone are not ownership proof. A legacy unlabeled network entry is retired after its verified-by-id removal, or a 404 for that id, consistent with §5.3.1.

### 12.5 Hot-path read budgets

Warm router reads of core, plugin, app-command, and CWD-map indexes MUST complete in under 30 ms. Warm tooling reads of `app-plan` and compiled `ToolingProgram` MUST independently complete in under 30 ms. No provider contact, include resolution, expression parsing, or graph construction occurs on these paths. The perf-budget suite enforces both (§13.1), alongside the user-visible budgets in §2.1.

#### 12.5.1 Compiled hot-path decoders

Schema decoding on the CLI hot path uses ahead-of-time compiled decoders under the §2.5 policy: the schema stays the canonical contract, the CLI installs the compiled set, and embedding hosts keep the interpreter. This section fixes what the policy leaves to the cache layer: which schemas, where the module comes from, and how caches meet it.

- The compiled set is the fixed, ordered AST list in `core/src/cli/compiled-decoder-targets.ts`: `GlobalConfig`, `LandoRuntimeOptions`, `BunShellScriptFrontMatter`, the CLI command init and run events, the deliverable-event union, `LandofileShape`, and `AppPlan`. Install order and AST identity are the contract; the generated module MUST be regenerated after any change to a listed schema, to the list, or to the Effect version, and the target list MUST NOT import the generated module so generation works on a clean checkout.
- The `compiled-decoders` derived codegen entry (§17.2) emits the gitignored generated module and its declaration. `runCompiledCli` installs them before any decode; `makeLandoRuntime` and other library entries never install them.
- Compiled and interpreted decoding MUST agree on verdict, decoded value, and every issue path and message. The parity suite (§13.1) decodes the Landofile corpus in separate interpreted and compiled processes and fails on any difference.
- Membership is earned and kept under §2.5: end-to-end measurement on compiled binaries against the §2.1 hot-path budgets, recorded with the change that adds the schema. Compiled decoders optimize the hot path; they are never a second source of truth for validity.
- Binary hot-path caches (`core-command`, `plugin-command`, `app-command`, `cwd-app-map`) are V8-serialized behind header checks and perform no Schema decode, so they have nothing to compile. Effect Schema binary caches (`app-plan`, `global-app-plan`, `scratch-app-plan`) decode through the compiled `AppPlan` decoder when installed.

### 12.6 Disconnectable local-dev state

After successful materialization/build, resolved plugins and includes, provider metadata and artifacts, app-plan/tooling caches, and service information required for routine development MUST be local. `start`, `stop`, `restart`, `info`, `logs`, and cached tooling MUST work without network access when state is complete. `app:rebuild` and `meta:global:rebuild` refresh referenced artifacts with local fallback and a warning (§6.13.3); acquisition needs network only for referenced artifacts with no local copy. Build steps that download packages still need network access when they execute rather than reuse a cached build layer.

Missing managed dependencies fail with a tagged error naming the missing artifact and online repair command. Routine offline-capable commands MUST NOT silently retry the network. Telemetry and update checks are best-effort and MUST NOT invalidate caches or alter local-command exit status.

Automatic translation MUST use local snapshots and stored same-identity nonsecret metadata without API probes or TTL refresh (§7.4.2). Missing required metadata/output MUST block mutation with explicit refresh remediation. Explicit translation/code-sync metadata fetch failures MUST fail visibly, never use stale-success fallback or another environment's cache. Init populates required metadata before it reports success (§8.8.13), so first-start translation needs no vendor API call; this does not waive normal runtime/image/build dependency acquisition. Remote sync and tether require their declared connectivity and are not routine offline workflows.

### 12.7 State store

`CacheService` is the process-lifetime memo and raw atomic-cache service. `StateStore` is the level-`minimal` core Effect service for durable, schema-validated, versioned, atomic, optionally cross-process-locked files (§3.4). It is host/test-overridable but MUST NOT be a plugin contribution surface (§4.2).

#### 12.7.1 Buckets

`StateStore.open` accepts `StateBucketSpec` and returns `StateBucket`. Named contracts are `StateRoot`, `StateCodec`, `StateBucketSpec`, `StateBucket`, `StateMigrator`, and tagged `StateStoreError`. A bucket maps to exactly one contained file; opening resolves and validates the path without reading.

`StateRoot` selects user data/cache/config, an app root, or an explicit host path. `StateCodec` is `json`, `binary`, or a custom codec for a user-facing stable format. `StateBucketSpec` names root, optional namespace, single-segment key, Effect Schema, version, codec, lock policy, corruption/version policy, and optional default. `StateBucket` exposes `path`, `get`, `set`, `update`, `modify`, `remove`, and `exists`.

All mutations encode before atomic replace. Version mismatch either discards or runs `StateMigrator`. Corruption policy is quarantine, discard, or fail. Advisory locking serializes mutation across processes, is scope-acquired, and uses bounded stale-owner recovery. Resolved paths MUST remain under their root; traversal, absolute keys, and symlink escapes fail with `StateStoreError` reason `path`. Roots MUST come from §7.5.1. `StateStoreError` also distinguishes `io`, `decode`, `lock`, and `version` and carries operation, path, cause, and remediation.

Hot-path caches remain under their existing readers and MAY adopt `StateStore` only while preserving §12.5 budgets.

App mutation locks left by dead commands MUST be reclaimed without a contention warning. Reclaim and vanished-file attempts retain the normal acquire deadline and retry delay; only an observed live holder triggers the wait message.

#### 12.7.2 Reference consumers

The scratch registry uses an advisory, quarantining bucket; the include lockfile uses an app-root custom YAML codec in an unlocked bucket, and its writers re-read and merge under a host-wide `StateStore.withLock` operation lock so no lock file lands beside it; snapshot sidecars use owner/store-scoped, version-1 JSON buckets that fail on corruption or version mismatch, with per-snapshot removal locks; and the managed-file ledger uses an advisory, quarantining bucket. The provider resource-ownership manifest uses an advisory, fail-closed bucket in the provider-private `resource-ownership` namespace (§12.4.2). The accelerated-start journal uses an advisory, fail-closed, version-migrating bucket in the user-data `accelerated-starts` namespace (§10.6.3). These subsystems MUST NOT implement bespoke persistence primitives.

Detached host-proxy and agent-relay worker locks MUST live under the resolved user-data `operation-locks` namespace, outside disposable run directories. Their stable key combines worker kind with a SHA-256 digest of the absolute run-directory path. Ensure, replacement, shutdown, teardown, and root sweeping MUST use the same identity and injected private-file access and MUST NOT expire a live owner. Root sweeping MUST acquire before inspecting or deleting worker state, including legacy and untrusted records. Release removes the lock file; purge removes the data root.

#### 12.7.3 Plugins and embedding hosts

Plugins receive a `stateStore` factory pre-namespaced to `plugins/<plugin-id>/` under user data and MUST NOT access core or other-plugin state (§9.8). Embedding hosts MAY open explicitly isolated buckets (§16.5). `@lando/core/testing` supplies `TestStateStore`; `@lando/sdk/test` supplies `runStateStoreContract` and `StateStoreContractHarness`.

---
