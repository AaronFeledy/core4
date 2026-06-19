# PRD: BETA1-16 — Data Movement & Volume Primitives

## Introduction

Beta 1 lands the on-host counterpart to the `HttpClient` egress chokepoint: the `DataMover` primitive and the `RuntimeProvider` data plane that backs it. Where `HttpClient` (§10.3.2) is the single chokepoint for **outbound/remote** bytes, `DataMover` (§10.11) is the single chokepoint for **local/volume/service** byte movement — moving bytes between five typed `DataEndpoint`s (host path/archive, in-process stream, named volume, service path/command, built artifact) and owning snapshot/restore, streaming, interruption, checksum verification, redaction, and the `Data` lifecycle events.

Today every byte-moving feature would hand-roll its own path. The only data-move code that exists is host-filesystem-only: `reflinkCopyAppRoot` / `copyAppRoot` in `core/src/scratch-app/service.ts` (`cp -a --reflink=auto` with a `node:fs` byte-copy fallback) for scratch `--isolate=full`. There is no volume export/import/snapshot, no host↔container file copy, and no artifact export/import on the provider contract; `EphemeralRunSpec` cannot mount a volume or stream stdio, so even a generic "tar a volume through a helper container" approach is impossible. Snapshot/restore, DB import/export, the local landing half of hosting `pull`/`push`, disposable-toolbox seeding, and `image save`/`load` each have no shared substrate to build on.

This PRD implements the normative §10.11 primitive: the SDK data-transfer schemas and `DataMover` service tag, the `RuntimeProvider` data-plane contract (eight capability-gated methods plus a mount- and stream-aware `run`/`runStream`), the five new `ProviderCapabilities` fields that drive native-vs-fallback dispatch, the core `DataMoverLive` orchestrator (dispatch matrix, streaming verification, the `Data` events, redaction), the snapshot store rooted at a `PathsService`-resolved path and indexed in a `StateStore` bucket, and the native data-plane implementation on the three bundled providers. It then migrates the one existing consumer (scratch `--isolate=full`) onto `DataMover` and adds the adjacent cache-volume storage kind.

`DataMover` is **not** a sync engine (live bidirectional sync stays `FileSyncEngine`, §10.6) and **not** a remote transport (a `HostingProvider` plugin owns remote I/O via `HttpClient`; it uses `DataMover` only for the local extract/land half). The primitive lands now; its full consumer wave — the bundled `@lando/sql` DB verbs, hosting `pull`/`push` (local landing half only), and `image save`/`load` — is 4.x. (`lando share` is **not** in this wave: a tunnel moves no local/volume bytes, so it consumes the `HttpClient`/tool-provisioning egress cluster, not `DataMover`; its contract is frozen in PRD-09.) The shared streaming-hash helper, the snapshot-store-on-`StateStore`, the `PathsService` snapshot roots, and `DataMover`-in-`RedactionService` are deliberate reuse of the branch's existing PRD-09 / PRD-13 primitives rather than re-derivation.

Depends on: **BETA1-04** (schema publication and SDK surface discipline), **BETA1-09** (the `HttpClient`/`Downloader` network primitives and the shared streaming-hash/atomic-write helper this PRD factors out and reuses), and **BETA1-13** (the Paths/Roots primitive that resolves the snapshot store and the `StateStore` durable primitive that indexes it).

## Source References

- [`spec/11-subsystems.md`](../11-subsystems.md) §10.11 the data-movement primitive (§10.11.1 the `DataEndpoint` model, §10.11.2 the `DataMover` service and required behaviors, §10.11.3 the snapshot store, §10.11.4 errors, §10.11.5 the contract suite); §10.3.2/§10.3.3 the `HttpClient`/`Downloader` egress chokepoints and the shared `@lando/sdk` streaming-hash/atomic-write helper `DataMover` reuses; §10.3.4 the `ToolManifest` pinning model the generic-fallback helper image follows.
- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) §5.3 the `RuntimeProvider` data-plane methods and the mount-/stream-aware `EphemeralRunSpec` + `runStream`; §5.4 the five data-plane `ProviderCapabilities` fields and capability honesty; §5.7 the provider-side `VolumeOperationError` / `ServiceCopyError` / `ArtifactTransferError`; §5.8 the bundled providers' native data-plane realizations.
- [`spec/03-architecture.md`](../03-architecture.md) §3.4 the `DataMover` core service (level `provider`, `Layer.suspend`, not plugin-replaceable) and the `RedactionService` consumer list; §3.5 the `Data` lifecycle event scope; §3.7 the canonical secret-redaction invariant `DataMover` composes.
- [`spec/06-services.md`](../06-services.md) §6.5 the storage model, scopes, auto-naming, provider labels, and the `kind: data|cache` cache-volume distinction.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) §12.4 the persistent-artifact paths for the snapshot archives, `.json` sidecars, and `index.bin`; §12.7 the `StateStore` bucket the snapshot index is realized through.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.5.1 the Paths/Roots primitive that resolves `appSnapshotsDir`/`snapshotsDir`/`toolDownloadsDir`.
- [`spec/beta-1/prd-beta-1-00-index.md`](./prd-beta-1-00-index.md) verification contract, SDK/schema lockstep, the §13.2 snapshot gate, the §13.1 provider contract suite, and dual-dispatch rules.

## Goals

- Publish the `@lando/sdk/schema/data-transfer.ts` schemas, the `DataMover` service tag, the `Data` event payloads, and the data-plane errors as additive, snapshot-gated SDK surface.
- Extend the `RuntimeProvider` contract with eight capability-gated data-plane methods and a mount-/stream-aware ephemeral run, plus the five `ProviderCapabilities` fields that drive `DataMover` dispatch, with every capability literal updated in lockstep.
- Implement `TestRuntimeProvider`'s in-memory data plane and the §13.1 data-plane contract suite so every provider's behavior — including capability honesty — is pinned before any real provider is touched.
- Factor the stream → SHA-256 → temp → atomic-rename logic into one pure `@lando/sdk` helper consumed by both `Downloader` and `DataMover`, so the verify-and-persist path exists once, not twice.
- Implement `DataMoverLive` at level `provider`: the `DataEndpoint` dispatch matrix (native capability vs generic helper-container `tar` fallback), the `Data` lifecycle events, host-path containment, checksum verification, and composition of the canonical `RedactionService`.
- Realize the snapshot store over `PathsService`-derived roots and a `StateStore` index bucket, with `destroy --purge` removal and data-safe plain-`destroy` retention.
- Implement the native data plane on `@lando/provider-lando`, `@lando/provider-docker`, and `@lando/provider-podman`, declaring capabilities honestly and passing the contract suite.
- Migrate scratch `--isolate=full` onto `DataMover` and resolve the generic-fallback helper image through a pinned, digest-verified manifest.
- Add the cache-volume storage kind (`storage[].kind: cache`) as the adjacent storage-plane primitive.

## User Stories

### US-333: Publish the SDK data-transfer schemas, `DataMover` service tag, and data-plane errors

**Description:** As a plugin author or embedding host, I can consume a stable `DataMover` contract, the typed `DataEndpoint` model, and the data-plane error tags instead of inventing my own byte-movement surface.

**Acceptance Criteria:**

- [ ] A new `sdk/src/schema/data-transfer.ts` exports `DataEndpoint` (the seven-member tagged union: `hostPath`, `hostArchive`, `stream`, `volume`, `servicePath`, `serviceCmd`, `artifact`), `ArchiveFormat` (`"tar" | "tar.gz" | "tar.zst"`), the volume/service/snapshot schemas (`VolumeRef`, `VolumeInfo`, `VolumeFilter`, `VolumeSnapshotSpec`, `VolumeSnapshotRef`, `VolumeRestoreSpec`, `ServiceCopyInSpec`, `ServiceCopyOutSpec`), the transfer schemas (`DataTransferSpec`, `DataTransferResult` with `accelerated: boolean`, `DataTransferProgress`), and the snapshot schemas (`SnapshotHandle`, `SnapshotInfo`, `SnapshotFilter`, `PrunePolicy`), matching the §10.11.1/§10.11.2 shapes verbatim.
- [ ] `@lando/sdk/services` exports the `DataMover` `Context.Service` tag (`@lando/core/DataMover`) with `transfer`, `transferStream`, `snapshot`, `restore`, `listSnapshots`, `removeSnapshot`, and `pruneSnapshots`, and `sdk/src/services/index.ts` carries the matching `declare class DataMover` mirror.
- [ ] `@lando/sdk/errors` exports the tagged `DataTransferError`, `DataEndpointUnsupportedError`, `DataChecksumMismatchError`, `DataSourceOutsideRootError`, `DataTargetExistsError`, `SnapshotNotFoundError`, `VolumeNotFoundError`, and `ArchiveFormatError`, plus the provider-side `VolumeOperationError`, `ServiceCopyError`, and `ArtifactTransferError` added to the `ProviderError` union (§5.7); error fields avoid the `line`/`column` names per the Bun `TaggedError` gotcha.
- [ ] The new persisted schemas are added to `JSON_SCHEMA_REGISTRY` + `SDK_SCHEMA_NAMES` and the §13.2 schema-snapshot gate round-trips them; `bun run codegen:schema-snapshot` then `git diff --exit-code` is clean on generated/snapshot paths.
- [ ] `sdk/API_COMPATIBILITY.md` records the `DataMover` tag, the data-transfer schemas, and the new errors as additive, and the SDK export fixtures + `exports.test.ts` are updated in the same change.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-334: Extend the `RuntimeProvider` contract with the data plane and mount-aware ephemeral run

**Description:** As a provider author, I can implement the data-plane half of the provider contract — native volume/snapshot/copy/artifact methods plus a mount- and stream-aware ephemeral run that backs the generic fallback — against one typed interface.

**Acceptance Criteria:**

- [ ] `ProviderCapabilities` (`sdk/src/schema/networking.ts`) gains `volumeSnapshot` (`"native" | "copy" | "none"`), `serviceFileCopy` (`"native" | "exec" | "none"`), `artifactExport` (`Boolean`), `artifactImport` (`Boolean`), and `ephemeralMounts` (`Boolean`), with the §5.4 semantics documented and the contract that they are informational/truthful, not knobs.
- [ ] `EphemeralRunSpec` gains `mounts?` (`ReadonlyArray<MountPlan | DataStoreMountPlan>`), `stdinStream?` (`AsyncIterable<Uint8Array>`), `captureStdout?`, `env?`, and `remove?` (default `true`), and a `runStream` method (`Stream<ExecChunk, ProviderError, Scope.Scope>`) is added alongside `run`.
- [ ] The `RuntimeProvider`/`RuntimeProviderShape` interface gains the eight data-plane methods — `snapshotVolume`, `restoreVolume`, `listVolumes`, `removeVolume`, `copyToService`, `copyFromService`, `exportArtifact`, `importArtifact` — with the §5.3 signatures and `Scope`-bearing where the spec requires.
- [ ] Every capability literal in the repo is updated to declare the five new fields: `core/src/runtime/bootstrap-layer-support.ts` and the `sdk/src/test` provider double(s); a `ProviderCapabilities` decode of each is exercised.
- [ ] `bun run codegen:schema-snapshot` then `git diff --exit-code` is clean; `sdk/API_COMPATIBILITY.md` records the capability + `EphemeralRunSpec` + interface additions as additive.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-335: Implement the data plane on `TestRuntimeProvider` and add the §13.1 data-plane contract suite

**Description:** As a maintainer, I can pin every provider's data-plane behavior — round-trip, snapshot, copy, artifact, and capability honesty — against one contract suite before any real provider is implemented.

**Acceptance Criteria:**

- [ ] `TestRuntimeProvider` (`sdk/src/test`) implements the eight data-plane methods plus mount-/stream-aware `run`/`runStream` over an in-memory volume/service/artifact store, declaring `volumeSnapshot: "copy"`, `serviceFileCopy: "exec"`, `artifactExport`/`Import: true`, and `ephemeralMounts: true`.
- [ ] `@lando/sdk/test` exports a data-plane contract section (run against `TestRuntimeProvider` and, in later stories, every real provider) asserting `importVolume(exportVolume(x)) == x`, `snapshot → mutate → restore` restores bytes, `copyToService`/`copyFromService` round-trips, and `artifact` export/import round-trips (§10.11.5).
- [ ] The suite asserts **capability honesty**: a provider declaring `volumeSnapshot: "native"` (or `serviceFileCopy: "native"`) must actually exercise the native method and not silently fall back (§5.4).
- [ ] The suite covers the failure surface: an unrealizable `(from, to)` pair fails `DataEndpointUnsupportedError`, and a provider declaring `ephemeralMounts: false` with no matching native capability fails `CapabilityError` rather than degrading.
- [ ] The contract suite is structured so a real provider supplies only its provider factory; no provider-specific assertions leak into the shared suite.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-336: Extract the shared streaming-hash/atomic-write helper and migrate `Downloader` onto it

**Description:** As a maintainer, I can rely on one pure `@lando/sdk` implementation of "stream bytes through a SHA-256 hasher to a temp file, then atomically rename" so `Downloader` and `DataMover` verify and persist identically.

**Acceptance Criteria:**

- [ ] A pure, dependency-free `@lando/sdk` helper (same contracts-only tier as `@lando/sdk/probe` / `@lando/sdk/secrets`) exposes the stream → SHA-256 → unique-temp-file → atomic-rename path, deleting the temp file on interrupt, fetch failure, size mismatch, checksum mismatch, or persistence failure (§10.3.3, §10.11.2).
- [ ] `Downloader` (PRD-09) is rewired to consume the helper for its file-download verify-and-persist path; the hand-rolled hasher/temp/rename logic in `Downloader` is removed.
- [ ] The `Downloader` contract suite (§13.1) stays green with zero behavior change: scheme gating, checksum verification, atomic persistence, cache/offline semantics, redaction, and cancellation finalization are unchanged.
- [ ] The helper imports neither `effect` runtime modules in a way that pulls a runtime nor `@oclif/core`; an import-boundary assertion proves it stays pure.
- [ ] `sdk/API_COMPATIBILITY.md` records the helper export as additive and the SDK export fixtures are updated in the same change.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-337: Implement the `DataMover` core service — `transfer`/`transferStream` + dispatch + `Data` events

**Description:** As the runtime, I move bytes between any realizable pair of `DataEndpoint`s through one service that picks the native provider path when available, falls back to a generic helper container otherwise, verifies archives, and emits redacted lifecycle events.

**Acceptance Criteria:**

- [ ] `core/src/data-mover/service.ts` implements `DataMoverLive` at bootstrap level `provider`, `Layer.suspend`-wrapped so `lando info` pays zero cost; it is host/test-overridable but not a §4.2 plugin contribution surface.
- [ ] `transfer`/`transferStream` dispatch each `(from, to)` pair: native `RuntimeProvider` data-plane method when the matching §5.4 capability is `native`, else the generic helper-container `tar` path via `run`/`runStream`, else fail `DataEndpointUnsupportedError` with remediation; `DataTransferResult.accelerated` reports which path ran.
- [ ] Archive writes compute SHA-256 via the US-336 shared helper; `transfer` to a `hostArchive`/snapshot records the digest and `restore`/`import` verifies it, failing `DataChecksumMismatchError`; there is no skip-verification flag. `tar.gz`/`tar.zst` use Bun-native streams (no external `gzip`).
- [ ] A `hostPath`/`hostArchive` endpoint whose realpath escapes the app root (or an explicitly opted-in base) is rejected with `DataSourceOutsideRootError`; `restore`/`import` into an existing volume without `{ overwrite: true }` fails `DataTargetExistsError`.
- [ ] `DataMover` publishes the `Data` lifecycle scope (§3.5) — `pre-data-transfer`, `data-transfer-progress`, `post-data-transfer`, `pre-volume-snapshot`, `post-volume-snapshot` — with payloads routed through the canonical `RedactionService` (§3.7); `DataMover` is added to the `RedactionService` consumer list, and DB credentials passed to a `serviceCmd` ride env, never argv.
- [ ] All moves are `Scope`-bound; `Effect.interrupt` propagates to the underlying `execStream`/`runStream` `kill()` and reaps children, and `@lando/core/testing` ships an in-memory `TestDataMover` so unit tests need no real provider.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-338: Snapshot store — `snapshot`/`restore`/`list`/`remove`/`prune` over `PathsService` + `StateStore`

**Description:** As a maintainer, I can persist and index volume snapshots through the existing Paths and durable-state primitives instead of a bespoke registry, with data-safe destroy semantics.

**Acceptance Criteria:**

- [ ] `PathsService` / `@lando/core/paths` gain `snapshotsDir`, `appSnapshotsDir(appId)` (default `<userDataRoot>/snapshots/<app-id>/`), and the `toolDownloadsDir(toolId)` derived path, with the §7.5.1 derived-path tests extended; nothing re-derives `<userDataRoot>/snapshots/` by hand.
- [ ] `snapshot` writes `<appSnapshotsDir>/<store>/<snapshot-id>.<format>` (archive, `copy` mode) plus a `<snapshot-id>.json` `SnapshotInfo` sidecar (digest, size, createdAt, label, optional native `VolumeSnapshotRef`); a `volumeSnapshot: "native"` provider stores the `VolumeSnapshotRef` in the sidecar instead of an archive (§10.11.3).
- [ ] The snapshot index is a `StateStore` (§12.7) bucket (`<userDataRoot>/snapshots/<app-id>/index.bin`), inheriting atomic write + version header + advisory lock + corruption quarantine — not a bespoke registry file; `listSnapshots`/`pruneSnapshots` read it.
- [ ] `restore`/`removeSnapshot`/`pruneSnapshots` resolve by id through the index, fail `SnapshotNotFoundError` for a missing id, and verify the recorded digest on restore.
- [ ] `lando destroy --purge` removes an app's snapshot subtree; plain `lando destroy` keeps it (data-safety), verified by a test that asserts the subtree survives a plain destroy and is gone after `--purge`.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-339: Implement the native data plane on the three bundled providers

**Description:** As a user on any bundled provider, snapshot/restore, host↔container copy, and image save/load run through the provider's native fast path when it has one, and through the verified `tar` fallback when it does not.

**Acceptance Criteria:**

- [ ] `@lando/provider-lando` implements a commit-based native volume snapshot/restore, native host↔container copy, and image save/load, declaring `volumeSnapshot: "native"`, `serviceFileCopy: "native"`, and `artifactExport`/`Import: true` (§5.8.1).
- [ ] `@lando/provider-docker` and `@lando/provider-podman` implement copy-mode snapshot (verified `tar` archive), native `docker cp`/`podman cp` host↔container copy, and image save/load, declaring `volumeSnapshot: "copy"`, `serviceFileCopy: "native"`, and `artifactExport`/`Import: true` (§5.8.2/§5.8.3).
- [ ] All three providers declare `ephemeralMounts: true` and honor `EphemeralRunSpec.mounts`/`stdinStream`/`captureStdout`/`env`/`remove` and `runStream` so the generic fallback works.
- [ ] Every bundled provider passes the US-335 §13.1 data-plane contract suite, including the capability-honesty assertion (a provider declaring `native` must not fall back).
- [ ] Provider-side failures surface as `VolumeOperationError` / `ServiceCopyError` / `ArtifactTransferError` (§5.7) and are wrapped by `DataMover` into the §10.11.4 tags with the provider cause attached.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-340: Migrate scratch `--isolate=full` onto `DataMover` and resolve the helper image via a pinned manifest

**Description:** As a maintainer, scratch's full-isolation copy goes through the one byte-movement primitive instead of bespoke host-FS code, and the generic fallback's helper image is pinned and offline-reusable like every other Lando-provisioned artifact.

**Acceptance Criteria:**

- [ ] `core/src/scratch-app/service.ts` replaces `reflinkCopyAppRoot`/`copyAppRoot` with `DataMover.transfer(hostPath → hostPath)` for `--isolate=full`; the inline `cp -a --reflink=auto` + `node:fs` fallback logic is removed (or becomes the host-FS adapter `DataMover` calls), and existing scratch isolation tests stay green.
- [ ] The `hostPath → hostPath` path preserves the security invariant that teardown removes only the materialized scratch instance dir, never an `--isolate=none` source root (§21.7).
- [ ] The generic-fallback `tar` helper image is resolved from a pinned `{ image, digest }` (the §10.3.4 `ToolManifest` model at the provider-image layer) through `RuntimeProvider.pullArtifact`, digest-verified, cached, and offline-reused so the §1.4 offline contract holds once warm.
- [ ] A re-run whose pinned helper-image digest already matches is an idempotent no-op with no network access; a digest mismatch fails loudly before the helper runs.
- [ ] The §17.2 codegen (if applicable) emits/validates the helper-image manifest with a `git diff --exit-code` staleness gate; source-mode and compiled `$bunfs` dispatch resolve the same pinned image.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-341: Add the cache-volume storage kind (`storage[].kind: cache`)

**Description:** As a Landofile author, I can declare a named, cross-app-shareable dependency-cache volume so repeated installs and rebuilds reuse a persistent package-manager cache.

**Acceptance Criteria:**

- [ ] `DataStorePlan` (`sdk/src/schema/mounts.ts`) gains `kind: Schema.Literal("data", "cache")` (default `"data"`) and an optional `key:`; the schema snapshot round-trips it and `bun run codegen:schema-snapshot` + `git diff --exit-code` is clean.
- [ ] A `kind: cache` store auto-names `lando-cache-<key>` (with `key:` defaulting to `kebab(destination)`) and is shared across apps by design, independent of `scope:` (§6.5).
- [ ] Provider-created cache volumes carry the `dev.lando.storage-kind: "cache"` label so they are identifiable.
- [ ] A `kind: cache` store is **never** removed by `lando destroy`; it is removed only by an explicit `lando destroy --purge-caches` (or the `meta:cache:*` surface), verified by a test that asserts survival across a plain destroy.
- [ ] The planner rejects `scope: service` combined with `kind: cache` as a planning error (a cache volume is global-by-nature).
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

## Functional Requirements

- FR-1: All Lando-owned local/volume/service byte movement MUST flow through `DataMover`; hand-rolling host↔volume/container copy, archive export/import, or snapshot/restore outside the primitive is forbidden. Core ships exactly one `DataMover` implementation.
- FR-2: The pluggable seam for byte movement is the `RuntimeProvider` data plane (§5.3/§5.4), not `DataMover` itself. `DataMover` is host/test-overridable but MUST NOT be a §4.2 plugin contribution surface.
- FR-3: `DataMover` MUST dispatch to a native provider data-plane method only when the matching capability is `native`, else the generic helper-container fallback, else fail `DataEndpointUnsupportedError`; `DataTransferResult.accelerated` MUST report which path ran.
- FR-4: Archive writes and reads MUST verify SHA-256 through the shared `@lando/sdk` streaming-hash/atomic-write helper that also backs `Downloader`; there MUST be no skip-verification flag.
- FR-5: Host endpoints MUST be realpath-contained; an escape fails `DataSourceOutsideRootError`. Destructive `restore`/`import` MUST require `{ overwrite: true }`, else `DataTargetExistsError`.
- FR-6: `DataMover` MUST publish the `Data` lifecycle events and route every payload (and every log/transcript) through the canonical `RedactionService`; DB credentials MUST ride env, never argv.
- FR-7: All moves MUST be `Scope`-bound; `Effect.interrupt` MUST propagate to the underlying `execStream`/`runStream` `kill()` and reap helper containers, temp archives, and streams (LIFO).
- FR-8: The snapshot store MUST resolve its root through `PathsService.appSnapshotsDir` (§7.5.1) and index snapshots in a `StateStore` bucket (§12.7); no bespoke registry/lock is permitted. `lando destroy --purge` removes an app's snapshot subtree; plain `destroy` retains it.
- FR-9: Providers MUST declare the five data-plane capabilities truthfully; the §13.1 contract suite MUST verify that a provider declaring `native` does not fall back.
- FR-10: The generic fallback's helper image MUST be resolved from a pinned, digest-verified `{ image, digest }` through `RuntimeProvider.pullArtifact`, cached and offline-reusable.
- FR-11: A `kind: cache` store MUST auto-name `lando-cache-<key>`, carry the `dev.lando.storage-kind: "cache"` label, survive `lando destroy`, and be removable only by `lando destroy --purge-caches`; `scope: service` + `kind: cache` MUST be a planning error.
- FR-12: Every SDK surface addition MUST update `sdk/API_COMPATIBILITY.md`, the SDK export fixtures, the schema registry / `SDK_SCHEMA_NAMES`, and the §13.2 snapshot in the same change, additively.

## Non-Goals

- Shipping the consumer features themselves: the bundled `@lando/sql` DB verbs (`db export`/`import`/`snapshot`/`restore`/`reset`), hosting `pull`/`push`, and the user-facing `image save`/`load` commands are 4.x and out of scope here. This PRD ships the substrate. (`lando share` is not a `DataMover` consumer at all — its contract is frozen in PRD-09 and its feature ships in 4.1.)
- Making `DataMover` a plugin-replaceable `Context.Tag` abstraction or adding a `provides.dataMovers` surface; it is a data-integrity invariant like `RedactionService` / `EmbeddedAssetService` / `StateStore`.
- A backup/scheduling product: no cron, no retention policy beyond simple `pruneSnapshots`.
- Cross-host/remote transfer transport; a `HostingProvider` plugin owns remote I/O via `HttpClient` and uses `DataMover` only for the local extract/land half.
- Replacing the live bidirectional sync engine; `FileSyncEngine` (§10.6) is unchanged.
- A new persisted wire schema for the snapshot index beyond the `StateStore` bucket; the index reuses the durable primitive.
- Landofile `caches:` top-level sugar; the cache-volume primitive ships as `storage[].kind: cache` only, and the per-service `caches:` sugar is deferred.

## Technical Considerations

- The `serviceCmd` endpoint relies on the existing `CommandSpec.stdinStream` / `execStream` contract (§5.3), so piping a dump into a CLI's stdin or capturing a CLI's stdout needs no new provider method — only the orchestrator. Keep that path off the native-capability dispatch.
- The mount-aware `EphemeralRunSpec` is the keystone of the generic fallback: a provider declaring `ephemeralMounts: false` cannot host it, so `DataMover` then requires the corresponding native capability and otherwise fails `CapabilityError`. Implement and test the `false` branch explicitly.
- The shared streaming-hash helper MUST be factored out **before or with** `DataMoverLive`; retrofitting `Downloader` after both exist is the expensive ordering. Land US-336 against the `Downloader` contract suite to prove zero behavior change.
- The snapshot store reuses two PRD-13 primitives deliberately: the root via `PathsService.appSnapshotsDir` and the index via a `StateStore` bucket. Do not re-derive `<userDataRoot>/snapshots/` or hand-roll an atomic registry — that is precisely the duplication PRD-13 removed.
- `DataMover` joins the §3.7 / §4.2 `RedactionService` consumer list; like `HttpClient`/`Downloader`/`FileSyncEngine` it composes the canonical redactor and never ships a local copy. The §13.4 redaction lint gate covers it.
- Native snapshot semantics differ across providers: `@lando/provider-lando` has a commit/clone fast path (`volumeSnapshot: "native"`); Docker/Podman have no first-class volume snapshot and use `copy` mode (verified `tar`). Do not force a native snapshot onto the container providers.
- The helper-image pin follows the §10.3.4 `ToolManifest` precedent but at the provider-image layer (resolved through `pullArtifact`), not the host-binary layer; reuse the pinning/offline shape, not the install-under-`bin/` shape.
- `DataMoverLive` sits at level `provider` (snapshot/restore of a stopped DB needs only `provider` + a plan), and is `Layer.suspend`-wrapped so `lando info` and most tooling pay nothing. Keep one tag at `provider`; do not split the host-FS-only `hostPath → hostPath` slice into a lower-level service.
- The cache-volume kind is adjacent to data movement (storage-plane, not byte-movement) and could ship independently; it lives in this PRD because it is a "volume primitive." Keep its planner changes isolated from the `DataMover` dispatch path.

## Success Metrics

- Grepping the codebase shows one byte-movement implementation; scratch `--isolate=full` calls `DataMover` and no inline `reflinkCopyAppRoot`/`copyAppRoot` remains as a parallel copy path.
- The §13.1 data-plane contract suite runs against `TestRuntimeProvider` and all three bundled providers and covers round-trip, snapshot/restore, copy, artifact, capability honesty, and the unrealizable-pair/`ephemeralMounts:false` failure paths.
- `Downloader` and `DataMover` share one streaming-hash/atomic-write helper; the `Downloader` contract suite stays green with zero behavior change.
- The snapshot store resolves through `PathsService.appSnapshotsDir` and indexes through a `StateStore` bucket; `lando destroy --purge` removes an app's snapshots and plain `destroy` keeps them, verified under test.
- Archive restore/import rejects a checksum mismatch and a path escape; secret redaction is byte-stable in emitted `Data` events and transcripts.
- A `kind: cache` volume survives `lando destroy`, is removed by `lando destroy --purge-caches`, and `scope: service` + `kind: cache` fails planning.
- The schema snapshot and SDK backward-compat fixtures stay green (additive only) after the data-transfer schemas, capability fields, and errors land.

## Guide Coverage

**None — internal/infra PRD.**

This PRD publishes the `DataMover` byte-movement primitive and the `RuntimeProvider` data plane. It does not directly own user-facing guide surface; the user-facing guides for the byte-moving features built on it (DB export/import/snapshot/restore, hosting pull/push, `image save`/`load`) are owned by the 4.x PRDs that ship those commands.

## Open Questions

- Should `DataMover` expose a host-FS-only fast path that is reachable below level `provider` for the `hostPath → hostPath` slice (which needs no provider), or keep one tag at `provider` for simplicity? Default: one tag at `provider`; the `hostPath → hostPath` adapter is provider-independent internally but is reached through the same service.
- Should the container providers (`docker`/`podman`) eventually offer an image-commit-of-a-data-container native snapshot behind `volumeSnapshot: "native"`, or stay `copy`-only? Default: `copy`-only for Beta 1; reserve the native commit path for `@lando/provider-lando` and revisit if storage/restore-speed demand appears.
- Should the snapshot store ever take an automatic safety snapshot before `app:destroy --purge` / scratch teardown (opt-out), per the destructive-confirmation rule? Default: ship the capability (`MAY` per §10.11.3) but leave the auto-hook wiring to the destroy-command PRD so this PRD stays substrate-only.
- Should the cache-volume kind grow the per-service `caches:` Landofile sugar now or after the primitive proves out? Default: `storage[].kind: cache` only for Beta 1; defer the `caches:` sugar.
