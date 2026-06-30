# PRD: BETA1-13 — Paths/Roots & durable StateStore

## Introduction

Beta 1 lands two coupled foundational primitives: the public Paths/Roots primitive and the durable `StateStore` primitive. They stay in one PRD because `StateStore` resolves and contains bucket paths through the Paths/Roots contract, and both features consolidate duplicated filesystem/root/persistence logic before Beta 1 enters feature freeze.

Beta 1 is still the last feature-surface phase, so the public Paths/Roots primitive lands now instead of being deferred to a post-freeze release. Root resolution (`userConfRoot`, `userCacheRoot`, `userDataRoot`, `systemPluginRoot`) and the dozens of paths derived from those roots are currently re-implemented as ad-hoc helpers and hand-rolled `join()` calls across config, cache, plugin, scratch, shellenv, trust-store, planner, and uninstall code. Three separate modules reimplement the `$HOME`/XDG fallback with different bases, none of the non-conf roots implement the macOS/Windows platform defaults the spec mandates, `userCacheRoot` never reads `config.yml`, and `GlobalConfig` is missing the `userCacheRoot`/`systemPluginRoot` fields its own resolution order depends on.

This PRD implements the normative Paths/Roots primitive from §7.5.1: a single Effect-free `@lando/core/paths` resolver, the `PathsService` runtime tag, the `GlobalConfig` field additions, and the migration of every Lando-owned path derivation onto the primitive. Because the repo is private and nothing is published, behavior is aligned to the spec §7.5 matrix now (including the `userConfRoot` default move from `$HOME/.lando` to the platform-conventional config root).

Beta 1 is still the last feature-surface phase, so the canonical durable-state primitive lands now instead of being deferred to a post-freeze release. Three subsystems already persist durable Lando-owned state, each reinventing a slice of the same machinery: the scratch registry (`core/src/scratch-app/registry.ts`) carries the most complete take (versioned envelope + `O_CREAT|O_EXCL` token lockfile + stale-owner detection + corruption quarantine + atomic write), the `.lando.lock.yml` include lockfile (`core/src/landofile/includes.ts`) carries a no-lock variant, and `core/src/cache/atomic.ts` carries the bare write-temp-then-rename. `CacheService` is not this primitive — it is the ephemeral, in-memory, TTL-bounded memo with a raw `writeAtomic` escape hatch.

This PRD promotes the union of those takes into one published, contract-tested primitive — `StateStore` — a core service (eager at `minimal`) that mints `StateBucket` handles (one file each) with `json`/`binary`/custom codecs, advisory file locking, corruption quarantine, version migration, and path containment. It then migrates the scratch registry and include lockfile onto it (behavior- and format-preserving) and exposes a pre-namespaced `StateBucket` factory to plugins and the full tag to embedding hosts, so a `SecretStore`, `UpdateService`, `ConfigTranslator`, or embedding host can persist durable state with the same guarantees core uses.

This PRD implements the normative `StateStore` contract from §12.7 and aligns the existing durable-write call sites onto the published surface.

Depends on: **BETA1-01** (setup/uninstall consume roots and derived paths), **BETA1-04** (schema publication and SDK surface discipline), and **BETA1-11** (SDK/library acceptance and import-boundary contracts). The `StateStore` scope also depends internally on the Paths/Roots primitive defined earlier in this PRD.

## Source References

### Paths/Roots source references

- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.5 global-config roots + platform-default matrix, and §7.5.1 the Paths/Roots primitive (resolver, `PathsService`, derived paths, `GlobalConfig` fields, overridability).
- [`spec/02-toolchain.md`](../02-toolchain.md) §2.7 package surface — the `@lando/core/paths` entry and its Effect-free / OCLIF-free policy.
- [`spec/03-architecture.md`](../03-architecture.md) §3.4 `PathsService` core service and its eager membership at level `minimal`; §3.2 the level-`none` fast path that consumes the resolver.
- [`spec/09-embedding.md`](../09-embedding.md) §16.2 public API surface (the Paths entry), §16.3/§16.5 `RootOverrides` via `makeLandoRuntime` options.
- [`spec/04-pluggability.md`](../04-pluggability.md) §4.2 — `PathsService` is host/test-overridable but not a plugin contribution surface.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) §12.1/§12.4 — the cache catalog and persistent-artifact paths the derived-path builders must encode.
- [`spec/beta-1/prd-beta-1-00-index.md`](./prd-beta-1-00-index.md) verification contract, SDK/schema lockstep, and dual-dispatch rules.

### StateStore source references

- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) §12.7 the state-store primitive (buckets, codecs, locking, versioning, corruption, containment, reference consumers, plugin/embedding exposure); §12.2/§12.3 encoding + atomicity rules; §12.1 scratch-registry row.
- [`spec/03-architecture.md`](../03-architecture.md) §3.4 `StateStore` core service and its eager membership at level `minimal`.
- [`spec/04-pluggability.md`](../04-pluggability.md) §4.2 — `StateStore` is host/test-overridable but not a plugin contribution surface (no `stateStores:`).
- [`spec/10-plugins.md`](../10-plugins.md) §9.8 `LandoPluginContext.stateStore` pre-namespaced factory.
- [`spec/09-embedding.md`](../09-embedding.md) §16.2 service tag on the embedding surface; §16.5 cache-root/path isolation; §16.8 `@lando/core/testing`.
- [`spec/19-scratch-apps.md`](../19-scratch-apps.md) §21.11 scratch registry realized through `StateStore`.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.7.4 include lockfile realized through `StateStore`; §7.5.1 Paths/Roots primitive.
- [`spec/beta-1/prd-beta-1-00-index.md`](./prd-beta-1-00-index.md) verification contract and SDK/schema rules.

## Goals

### Paths/Roots goals

- Publish `@lando/core/paths` as the single Effect-free resolver for the four Lando roots and every derived path, with the full §7.5 precedence and the Linux/macOS/Windows platform-default matrix.
- Publish `PathsService` as the runtime DI tag at bootstrap `minimal`, backed by the same resolver, so runtime code never re-derives roots and never depends on `ConfigService` for them.
- Add `userCacheRoot` and `systemPluginRoot` to `GlobalConfig` so the `config.yml` layer and host `config:` override of the resolution order are typed end to end.
- Migrate every hand-rolled `<root>/...` join and every duplicated `$HOME`/XDG/`%APPDATA%` fallback onto the primitive, removing the divergence between `roots.ts`, `cache/paths.ts`, and scattered `process.platform` host branches.
- Keep the level-`none` fast path and the default `@lando/core` entry free of Effect/OCLIF regressions, enforced by import-boundary and cold-start canary tests.

### StateStore goals

- Publish `StateStore` as the single core service for durable, atomic, schema-validated, versioned, optionally cross-process-locked on-disk documents.
- Encode the §12.7 atomicity, versioning, corruption, locking, and containment behaviors as a contract suite that runs against the published surface and the in-memory test store.
- Generalize the scratch registry's `O_CREAT|O_EXCL` token lock, stale-owner takeover, and corruption-quarantine into reusable internals owned by the store.
- Migrate the scratch registry and include lockfile onto `StateStore` with zero behavior change and zero on-disk-format change.
- Expose a pre-namespaced `StateBucket` factory to plugins and the `StateStore` tag to embedding hosts, with an in-memory `TestStateStore` and a `@lando/sdk/test` contract suite.

## User Stories

### US-302: Publish the Effect-free `@lando/core/paths` resolver, factory, and platform matrix

**Description:** As a cold-start path, embedding host, script, or plugin utility, I can resolve Lando's roots and any derived path without constructing `ConfigService` or the Effect runtime.

**Acceptance Criteria:**

- [ ] A new `core/src/config/paths.ts` exports `resolveLandoRoots(options?)`, `makeLandoPaths(options?)`, and `normalizeHostPlatform(input?)`, and imports neither `effect` nor `@lando/sdk` runtime modules (type-only SDK imports are permitted).
- [ ] `resolveLandoRoots` applies, per root, the §7.5 order: explicit `RootOverrides` field → `LANDO_USER_CONF_ROOT` / `LANDO_USER_CACHE_ROOT` / `LANDO_USER_DATA_ROOT` / `LANDO_SYSTEM_PLUGIN_ROOT` → `config.yml` value → platform default.
- [ ] The platform-default matrix matches the §7.5 table verbatim for `linux`/`darwin`/`win32` (and `wsl` resolving to the Linux column) for all four roots, including the macOS `~/Library/...` and Windows `%APPDATA%`/`%LOCALAPPDATA%`/`%PROGRAMDATA%` paths that do not exist in the current code.
- [ ] The `userConfRoot` self-reference rule holds: `config.yml` is located via the shared overlay-aware conf-root resolver, and a `userConfRoot` value inside `config.yml` never relocates that same config load; the other three roots read `config.yml` only after the conf root is fixed.
- [ ] The env short-circuit keeps the conf/data/cache fast path IO-free when the matching `LANDO_*` env var is set (no `config.yml` read).
- [ ] `makeLandoPaths` returns `roots`, `platform`, and builders for every §12 path the catalog names: `pluginsDir`, `appPluginsDir(appId)`, `pluginAuthFile`, `binDir`, `keysDir`, `certsDir`, `runtimeDir`, `globalAppRoot`, `logsDir`, `scratchDir`, `scratchRegistryFile`, `appCacheDir(appName, appRoot)`, `appPlanCacheFile(appName, appRoot)`, `fileSyncSessionsDir`, `configFile`, `configDir`, `globalConfigFile`; app-scoped builders preserve the §12.1 name sanitization and app-root fingerprint.
- [ ] `core/test/config/paths.test.ts` covers every root × every precedence layer (override/env/config/default) × `linux`/`darwin`/`win32`/`wsl`, plus at least six derived-path builders and the app-cache collision-avoidance behavior, with `env`/`home`/`platform` injected through `RootOverrides`.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-303: Publish the `PathsService` SDK contract and add `GlobalConfig` roots

**Description:** As a plugin author or embedding host, I can consume a stable `PathsService` tag and typed path contracts, and configure every root through `GlobalConfig`.

**Acceptance Criteria:**

- [ ] `@lando/sdk/services` exports the `PathsService` tag (`@lando/core/PathsService`) plus the `LandoRoots`, `LandoPaths`, and `RootOverrides` types, and `sdk/src/services/index.ts` carries the matching `declare class` mirror.
- [ ] `LandoPaths` / `LandoRoots` / `RootOverrides` shapes match §7.5.1 (four roots, `platform`, the derived-path builders, and the `platform`/`env`/`home` override fields).
- [ ] `GlobalConfig` gains `userCacheRoot` and `systemPluginRoot` as optional `AbsolutePath` fields alongside the existing `userConfRoot`/`userDataRoot`.
- [ ] `@lando/core/schema` re-exports the updated `GlobalConfig`, and the §13.2 schema-snapshot gate round-trips it; `bun run codegen:schema-snapshot` then `git diff --exit-code` is clean on generated/snapshot paths.
- [ ] `sdk/API_COMPATIBILITY.md`, the SDK export/compat fixtures, and the four-place schema lockstep are updated in the same change; the additive `PathsService` tag is recorded as additive.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-304: Wire `PathsServiceLive` into bootstrap and resolve config roots through the primitive

**Description:** As the runtime, I resolve every root and derived path through one service that is available from the lowest bootstrap level and honors host overrides.

**Acceptance Criteria:**

- [ ] `PathsServiceLive` wraps `makeLandoPaths` and is emitted eagerly into the generated `minimal` bootstrap layer by editing `scripts/build-bootstrap-layers.ts` and regenerating `core/src/runtime/generated/layers/minimal.ts` (never editing the generated file directly); `git diff --exit-code` is clean after regeneration.
- [ ] `PathsService` resolves correctly at every level `minimal` and above; a test yields it at `minimal` and asserts the resolved roots and a representative derived path.
- [ ] `ConfigService`'s merged base derives `userConfRoot`, `userCacheRoot`, `userDataRoot`, and `systemPluginRoot` from `resolveLandoRoots()` rather than the previous partial base, and `ConfigService.get("userCacheRoot")` / `get("systemPluginRoot")` return resolved values.
- [ ] `makeLandoRuntime`'s `config:` root overrides (§16.5) flow into the resolver so isolated/test runtimes can relocate every root; the `userConfRoot` self-reference rule is preserved (config-load location is unaffected by the config value).
- [ ] `core/src/config/roots.ts` `resolveUserDataRoot`/`resolveUserConfRoot` and `core/src/cache/paths.ts` `resolveUserCacheRoot` become thin wrappers over `resolveLandoRoots()` (keeping their names/signatures so the cold-start fast path and existing tests stay green), and `userCacheRoot` now reads `config.yml`.
- [ ] The fast-path cold-start canary (`core/test/cli/fast-path-canary-preload.ts`, `paint-banner.test.ts`) stays green and `lando shellenv` output is unchanged for unchanged inputs on the current platform.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-305: Export `@lando/core/paths`, keep the default entry OCLIF-free, and document the surface

**Description:** As a package consumer, I can import the Paths primitive from a stable entry point that pulls neither OCLIF nor the Effect runtime.

**Acceptance Criteria:**

- [ ] `core/package.json#exports` adds `"./paths"` mapping to the pure resolver module, and `@lando/core/services` re-exports `PathsService`.
- [ ] `@lando/core/paths` is declared semver-stable in §16.2 and resolves from both workspace and packed installs.
- [ ] An import-boundary test in `core/test/library/` (or `test/types/`) proves `@lando/core/paths` pulls neither `@oclif/core` nor the Effect runtime into its import graph, and the default `@lando/core` entry remains OCLIF-free.
- [ ] The spec surfaces are present and consistent: §2.7 export + policy bullet, §3.4 `PathsService` row + `minimal` eager membership, §7.5 reference + §7.5.1 subsection, §16.2 Paths row + service-tag list + stability list, and the §4.2 not-a-plugin-surface note.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-306: Migrate hand-rolled path derivations onto the primitive and gate against regrowth

**Description:** As a maintainer, I can reason about one path-resolution implementation instead of auditing duplicated `join()` calls and divergent platform branches across the codebase.

**Acceptance Criteria:**

- [ ] Hand-rolled root joins are replaced with `PathsService` (inside Effect contexts) or `makeLandoPaths` (in pure/non-Effect code) across at least: the plugin store paths in `core/src/plugins/registry.ts` and the plugin-`add`/`remove`/`link`/`unlink`/`publish` commands, `core/src/scratch-app/registry.ts` + `service.ts` (`scratch/`), `core/src/cli/commands/shellenv.ts` (`bin/`), `core/src/plugins/trust-store.ts` (conf trust path), `core/src/services/planner.ts` and `core/src/cache/command-index-writer.ts` (cache roots), and `core/src/cli/commands/uninstall.ts`.
- [ ] Host-key `process.platform` branches that select a Lando path/column (as opposed to genuine OS syscall branching) route through `normalizeHostPlatform`.
- [ ] No behavior change for default inputs: the migration is path-equivalent on the current platform, verified by the existing plugin/scratch/shellenv/uninstall tests staying green.
- [ ] A grep-style check (test or lint) proves no remaining hand-rolled `<userDataRoot>/plugins`, `<userCacheRoot>/scratch`, or `<userDataRoot>/bin` joins outside the primitive, and the three legacy resolvers delegate rather than re-deriving fallbacks.
- [ ] Source-mode and compiled `$bunfs` dispatch paths consume the same primitive for setup, shellenv, plugin, scratch, and uninstall path resolution (dual-dispatch parity preserved).
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-311: Publish the `StateStore` SDK service, types, and error

**Description:** As a plugin author or embedding host, I can persist durable Lando-owned state through a stable `StateStore` contract instead of hand-rolling atomic writes, lockfiles, and version envelopes.

**Acceptance Criteria:**

- [ ] `@lando/sdk/services` exports the `StateStore` service tag (`@lando/core/StateStore`) and the typed interface `open(spec) → Effect<StateBucket<A>, StateStoreError>`, with `StateBucket` exposing `path`, `get`, `set`, `update`, `modify`, `remove`, `exists` (all Effect-returning except `path`).
- [ ] `@lando/sdk/services` exports the `StateBucketSpec`, `StateBucket`, `StateRoot`, `StateCodec`, and `StateMigrator` types; `sdk/src/services/index.ts` carries the matching `declare class StateStore` mirror.
- [ ] `@lando/sdk/errors` exports the tagged `StateStoreError` with a `reason: "io" | "decode" | "lock" | "path" | "version"` discriminator plus `operation`, `path`, `cause`, and `remediation` fields (no `line`/`column` field names per the Bun `TaggedError` gotcha).
- [ ] No entry is added to `JSON_SCHEMA_REGISTRY` (the primitive publishes a service tag, types, and one error, not a persisted wire schema); the schema-snapshot gate runs clean with no diff.
- [ ] `sdk/API_COMPATIBILITY.md` lists the `StateStore` tag under "Additive Alpha service tags" and `StateStoreError` under "Additive Alpha errors"; SDK export fixtures and `sdk/test/library/exports.test.ts` are updated in the same change.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-312: Implement `StateStoreLive` and wire it into the `minimal` bootstrap layer

**Description:** As a maintainer, I can rely on one durable-store implementation that is atomic, version-aware, corruption-resilient, lock-capable, and path-contained, available everywhere from bootstrap `minimal` up.

**Acceptance Criteria:**

- [ ] `core/src/state/` implements the store: `codec.ts` (json/binary/custom encode-decode + version header + corruption handling), `lock.ts` (generic `O_CREAT|O_EXCL` token lock with stale-owner takeover via age threshold and `kill(pid, 0)`, bounded retry/backoff, token-checked `Scope`-acquired release), `paths.ts` (`StateRoot` resolution + realpath containment), and `service.ts` (`StateStoreLive`, `makeStateStore`, the `StateBucket` impl).
- [ ] `set`/`update` write `<path>.tmp-<rnd>` then rename (reusing `writeFileAtomicViaRename`); a failed write removes the temp file and never partially writes the live file.
- [ ] `onCorrupt: "quarantine"` renames a bad file to `<path>.corrupt-<timestamp>` and returns the bucket default; `onVersionMismatch` supports `"discard"` and a `StateMigrator`; a `(root, namespace, key)` whose realpath escapes the resolved root fails with `StateStoreError` (`reason: "path"`).
- [ ] `advisory` buckets serialize `update`/`modify` across processes; `none` buckets do not lock. Root resolution flows through `@lando/core/paths` / `PathsService` (no re-derived `$HOME`/XDG/`%APPDATA%`).
- [ ] `StateStoreLive` is emitted eagerly into the generated `minimal` bootstrap layer by editing `scripts/build-bootstrap-layers.ts` and regenerating `core/src/runtime/generated/layers/minimal.ts` (never editing the generated file directly); `git diff --exit-code` is clean after regeneration.
- [ ] `StateStore` construction touches no network, provider, or plugin module, and stays off the level-`none` first-byte path; a test yields it at `minimal` and round-trips a bucket.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-313: Migrate the scratch registry onto `StateStore`

**Description:** As a maintainer, I can reason about one durable-store implementation instead of the scratch registry's bespoke lock + quarantine + envelope copy.

**Acceptance Criteria:**

- [ ] `core/src/scratch-app/registry.ts` is rebuilt on a single `StateBucket` opened with `{ root: "userCache", namespace: "scratch", key: "registry.bin", codec: "json", lock: "advisory", onCorrupt: "quarantine", version: 1 }`; `read` is `get` with an empty-envelope default, and `upsert`/`remove` are `update`.
- [ ] The bespoke `acquireScratchRegistryLock` becomes a thin re-export of (or is deleted in favor of) the generic `core/src/state/lock.ts`; the inline quarantine/rename logic is removed in favor of the store's.
- [ ] The `ScratchRegistry` tag and `ScratchRegistryService` shape (`read`/`upsert`/`remove`/`list`/`get`) are unchanged, so no scratch caller changes; the registry is still wired into the generated `scratch` bootstrap layer.
- [ ] Behavior is preserved: existing scratch registry / `apps:scratch:gc` / lifecycle tests stay green unchanged, including the corruption-quarantine and stale-lock-takeover paths.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-314: Route the include lockfile through `StateStore` without changing its format

**Description:** As a maintainer, I can persist `.lando.lock.yml` through the shared primitive while keeping the committed YAML byte-for-byte identical.

**Acceptance Criteria:**

- [ ] `core/src/landofile/includes.ts` reads and writes the lockfile through a `StateBucket` opened with `{ root: { app: appRoot }, key: ".lando.lock.yml", lock: "none", onCorrupt: "discard" }` and a custom codec wrapping the existing `renderLockfile` / `parseLockEntries`.
- [ ] The on-disk `.lando.lock.yml` output is byte-for-byte identical for every previously valid input (block-style YAML, sorted entries, checksum lines); a fixture asserts round-trip equality against the pre-migration renderer.
- [ ] `writeFileAtomicViaRename` is no longer called directly from `includes.ts`; the atomic write and path containment now come from the store.
- [ ] `app:includes:update` and `app:includes:verify` (source-mode and compiled `$bunfs` paths) consume the same store-backed lockfile read/write; their existing tests stay green.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-315: Expose `StateStore` to plugins and hosts, ship `TestStateStore`, and enforce the contract suite

**Description:** As a plugin author or embedding host, I can persist isolated durable state through a pre-namespaced store and prove any implementation preserves the §12.7 guarantees.

**Acceptance Criteria:**

- [ ] `LandoPluginContext` gains a `stateStore` factory pre-namespaced to `plugins/<plugin-id>/` under `userData`; a plugin-context test proves a plugin cannot open a bucket that escapes its own subtree (containment) and cannot reach another plugin's or core's state.
- [ ] `makeLandoRuntime` exposes `StateStore` on the runtime so embedding hosts can `open` buckets under `{ path: ... }` for per-tenant/per-test isolation; a library-API test opens, writes, and re-reads a host bucket under an isolated path.
- [ ] `@lando/core/testing` exports an in-memory `TestStateStore` (no disk; inspectable) that satisfies the contract suite.
- [ ] `@lando/sdk/test` exports a `StateStore` contract suite that runs against `StateStoreLive`, `TestStateStore`, and any host/test override, asserting atomic replace, version-mismatch discard + migrate, corruption quarantine, containment rejection, advisory-lock contention + stale takeover, and codec round-trip (json/binary/custom).
- [ ] A §13.4-style boundary check (test or lint) proves no durable atomic-write + lockfile + version-envelope is hand-rolled outside `core/src/state/**` (the scratch registry and include lockfile delegate; `CacheService.writeAtomic` and the hot-path binary caches are the documented exceptions).
- [ ] The repo `AGENTS.md` durable-state note and the §12.7 / §3.4 / §4.2 / §9.8 spec surfaces are present and consistent.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-371: Static boundary gates also catch dynamic-import and barrel re-export escapes

**Description:** As a maintainer, the static boundary gates detect dynamic `import()` and barrel re-export escape hatches, so a banned dependency cannot slip past a gate via `await import(...)` or a re-export.

**Acceptance Criteria:**

- [ ] The shared boundary-gate AST scanners detect dynamic `import()` call expressions (constructed or statically resolvable specifiers) in addition to static `import`/`require`, for at least `check:env-helper-boundary` and the `import-boundary` walker.
- [ ] Barrel re-export escape hatches (`export * from` / `export { x } from` re-exporting a banned module) are flagged wherever a direct import would be.
- [ ] `mkdtemp` negative fixtures prove each hardened gate fires on a dynamic-import offender and a re-export offender, and the real working tree passes clean.
- [ ] Intentionally-allowed dynamic imports (e.g. the OpenTUI constructed-specifier boundary) remain allowlisted and are not broken.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

**Notes:** Backlog hardening surfaced in `spec/beta-1/progress.txt` (US-305 and US-362 review notes): dynamic-import / re-export coverage for the static boundary gates was repeatedly deferred as non-blocking lint hardening with no owning story. `Bun.Transpiler().scan()` erases `import type` edges and does not surface dynamic `import()`, so the walker needs a dedicated AST pass for the dynamic and re-export cases.

## Functional Requirements

### Paths/Roots functional requirements

- FR-1: All Lando-owned root and derived-path resolution MUST flow through `@lando/core/paths` (pure) or `PathsService` (runtime); re-deriving `$HOME`/XDG/`%APPDATA%` fallbacks or hand-joining root-relative paths is forbidden outside the primitive.
- FR-2: `@lando/core/paths` MUST be Effect-free and OCLIF-free and MUST be safe to import on the level-`none` fast path.
- FR-3: The four roots MUST resolve in the §7.5 order (explicit option → env → `config.yml` → platform default) with the full Linux/macOS/Windows matrix; `userConfRoot` MUST keep its self-reference rule.
- FR-4: `GlobalConfig` MUST carry `userConfRoot`, `userCacheRoot`, `userDataRoot`, and `systemPluginRoot` as optional `AbsolutePath` fields.
- FR-5: `PathsService` MUST be available eagerly at bootstrap `minimal` and MUST NOT depend on `ConfigService`; `ConfigService` MAY depend on the resolver for its merged base.
- FR-6: `RootOverrides` (via `makeLandoRuntime` `config:`) MUST be able to relocate every root for test/host isolation without process-global mutation.
- FR-7: `PathsService` is host/test-overridable but MUST NOT be a plugin contribution surface; there is no `provides.paths` manifest key.
- FR-8: The existing `resolveUserDataRoot` / `resolveUserConfRoot` / `resolveUserCacheRoot` names MUST keep working as thin delegations during and after migration so the cold-start path and current tests are not broken.

### StateStore functional requirements

- FR-1: All durable, atomic, optionally-locked Lando-owned on-disk writes MUST flow through `StateStore`; hand-rolling write-temp-then-rename + lockfile + version envelope + quarantine outside `core/src/state/**` is forbidden, except `CacheService.writeAtomic` (the low-level shared helper) and the §12.1 hot-path binary caches under their §12.5 budgets.
- FR-2: `StateStore` MUST be available eagerly at bootstrap `minimal` and MUST NOT depend on `ConfigService`, the provider, the network, or any plugin module; it resolves roots through the §7.5.1 Paths primitive.
- FR-3: Every `set`/`update` MUST be atomic (temp + fsync + rename); a crash MUST never leave a partially written live file.
- FR-4: A bucket MUST apply its `onCorrupt` and `onVersionMismatch` policy on read; `"quarantine"` MUST move the bad file aside and return the default rather than failing the caller.
- FR-5: `advisory` buckets MUST serialize cross-process `update`/`modify` and MUST take over a stale lock (dead owner pid or expired age); the lock MUST be `Scope`-acquired so interruption finalizes it.
- FR-6: A resolved bucket path MUST stay under its resolved root after realpath resolution; escapes fail with `StateStoreError` (`reason: "path"`).
- FR-7: The scratch registry and include lockfile MUST be realized through `StateStore` with no public-shape change and no on-disk-format change.
- FR-8: `StateStore` MUST be host/test-overridable but MUST NOT be a plugin contribution surface; there is no `provides.stateStores` manifest key. Plugins persist state only through the pre-namespaced `LandoPluginContext.stateStore`.
- FR-9: Adding the surface MUST update `sdk/API_COMPATIBILITY.md`, the SDK export fixtures, and `exports.test.ts` in the same change, and MUST leave the §13.2 schema snapshot unchanged.

## Non-Goals

### Paths/Roots non-goals

- Making `PathsService` a plugin-replaceable abstraction or adding a `provides.paths` manifest surface.
- Introducing a relocatable single-directory `$HOME/.lando` layout; v4 uses the platform-conventional roots.
- Changing the §12 cache catalog contents or the app-root fingerprint algorithm; this PRD only centralizes how those paths are built.
- Adding new roots beyond the four in §7.5.
- Resolving Landofile/app discovery (cwd-walk, `cwd-app-map`); that remains owned by `LandofileService` and app-resolution code.

### StateStore non-goals

- Migrating the §12.1 hot-path binary caches (`plan.bin`, `cwd-app-map.bin`, command indexes) onto `StateStore`; they keep their existing readers under the §12.5 budgets and MAY adopt the store later.
- Folding `CacheService` into `StateStore` or removing the in-memory/TTL memo; the two stay distinct (ephemeral vs durable).
- Making `StateStore` a pluggable `Context.Tag` abstraction with a `provides.stateStores` surface; it is a state-integrity invariant.
- A general transactional/multi-file commit, a key-value query layer, or cross-bucket transactions; the unit of atomicity is one file.
- Introducing a new persisted wire schema or JSON Schema artifact; `StateBucketSpec` is a config type, not a published schema.
- Changing the committed `.lando.lock.yml` or `registry.bin` on-disk formats.

## Technical Considerations

### Paths/Roots technical considerations

- The shared overlay-aware conf-root resolver (`resolveConfigFileRoot`, `parseMinimalYaml`) MUST remain the single source of truth for *where* `config.yml` is read; `resolveLandoRoots` reuses it rather than re-implementing conf-root logic, preserving the `userConfRoot` self-reference rule.
- Keep `core/src/config/paths.ts` dependency-light: type-only SDK imports for `HostPlatform`/`AbsolutePath`, Node `os`/`path` only. The import-boundary test guards against accidental `effect` imports creeping in.
- The `userConfRoot` default moves from the current `$HOME/.lando` to the spec §7.5 platform-conventional config root; because the repo is private and unpublished, take the spec-aligned default and note the change in the changelog rather than preserving the divergent default.
- Wrappers in `roots.ts`/`cache/paths.ts` bound the migration blast radius: keeping the old named exports lets US-306 migrate call sites incrementally while every consumer already resolves through the new core.
- `ConfigService` integration must not introduce a cycle: the resolver is Effect-free and is consumed by both the `PathsService` Live Layer and `ConfigService`'s base merge.
- App-scoped cache builders must keep producing the exact same directory names as today for unchanged inputs so existing on-disk caches are not orphaned by the migration.

### StateStore technical considerations

- Keep `StateStoreLive` dependency-light (node:fs-backed via the promoted atomic/lock helpers, like `CacheServiceLive`) so it is constructible at `minimal` with no service deps; a FileSystem-service-backed sandbox variant is a possible later refinement, and `TestStateStore` is what tests use regardless.
- The advisory lock's `O_CREAT|O_EXCL` + `{pid, token, createdAt}` + stale takeover + token-checked release is lifted verbatim from `core/src/scratch-app/registry.ts`; preserve its semantics (the scratch tests exercise the corner cases) when generalizing.
- The custom codec for the include lockfile must wrap the *existing* `renderLockfile`/`parseLockEntries` so the format is unchanged; do not re-implement the YAML emit/parse.
- `StateStoreError` is a single tagged error with a `reason` discriminator (mirroring the scratch `ScratchAppError { operation }` shape) to keep the SDK surface minimal; avoid field names `line`/`column` per the Bun `TaggedError` gotcha.
- Plugin namespacing is enforced inside the `LandoPluginContext.stateStore` factory by fixing `root: "userData"` and prefixing `namespace` with `plugins/<id>/`; the plugin cannot pass an arbitrary `StateRoot`.

## Success Metrics

### Paths/Roots success metrics

- Grepping the codebase shows one root/path resolver and no remaining duplicated `$HOME`/XDG/platform fallbacks or hand-rolled `<root>/...` joins outside the primitive.
- `@lando/core/paths` imports cleanly with no OCLIF or Effect-runtime leakage in workspace and packed installs.
- `ConfigService.get("userCacheRoot")` and `get("systemPluginRoot")` return resolved values, and host `config:` overrides relocate every root in tests.
- macOS and Windows resolve the spec §7.5 paths under unit tests with injected `platform`/`env`/`home`.
- The cold-start canary and `lando shellenv` output are unchanged for unchanged inputs on the current platform.

### StateStore success metrics

- Grepping core shows one durable-store implementation under `core/src/state/`; the scratch registry and include lockfile delegate to it, and no inline `writeFileAtomicViaRename` + lockfile + version-envelope + quarantine remains outside `core/src/state/**` and the documented exceptions.
- The `StateStore` contract suite runs against `StateStoreLive` and `TestStateStore` and covers atomicity, versioning, corruption, containment, locking, and codec round-trips.
- A plugin author can persist and re-read isolated durable state in a unit test using only `LandoPluginContext.stateStore`; an embedding host can do the same via the `StateStore` tag under an isolated path.
- The scratch and include test suites stay green unchanged; `registry.bin` and `.lando.lock.yml` on-disk formats are unchanged; the schema snapshot and SDK backward-compat fixtures stay green (additive only).

## Guide Coverage

**None — internal/infra PRD.**

This PRD publishes foundational root-resolution and durable-state primitives. It does not directly own user-facing guide surface; downstream CLI guides remain owned by the PRDs for the commands that expose those primitives.

## Open Questions

### Paths/Roots open questions

- Should the legacy `resolveUserDataRoot`/`resolveUserConfRoot`/`resolveUserCacheRoot` named exports be deprecated (TSDoc `@deprecated` + `DeprecationService`) once every internal consumer migrates, or kept indefinitely as supported thin aliases? Default: keep them as supported internal aliases for Beta 1; revisit deprecation post-GA since they are not part of the published `@lando/core` surface.
- Should `LandoPaths` expose `tempDir` (under the OS temp dir) as a builder now? Default: include it only if a current consumer needs it; otherwise reserve it to keep the contract minimal at first ship.
- Should the `userConfRoot` default change ship with a one-time migration that relocates an existing `$HOME/.lando/config.yml`? Default: no automatic migration in Beta 1; document the new default and let users move config explicitly, since the repo is pre-release and has no installed-base guarantee.

### StateStore open questions

- Should `StateStoreLive` write through the `FileSystem` service (for sandbox/test override) or stay node:fs-backed for v1? Default: node:fs-backed for the dependency-light `minimal` layer; revisit a FileSystem-backed variant if a sandboxing host needs it.
- Should the `binary` codec default to `Bun.serialize`/`Bun.deserialize` or Effect Schema binary encoding? Default: `Bun.serialize` for buckets whose schema is not a public contract, Effect Schema binary for any bucket whose payload crosses the published schema surface, matching the §12.2 rule.
- Should plugin buckets be allowed under `userCache` (not just `userData`) for plugin-owned ephemeral-but-durable caches? Default: `userData`-only in Beta 1; add a `userCache` namespace to the plugin factory in a follow-up if demand appears.
