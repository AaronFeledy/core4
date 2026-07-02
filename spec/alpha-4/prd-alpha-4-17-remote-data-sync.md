# PRD: ALPHA4-17 — Remote Data Sync (`RemoteSource` + `Dataset`) contract freeze

## Introduction

Alpha 4 freezes the **remote data sync** contract — the egress-side peer of the `DataMover` byte-movement primitive (PRD-16) — so the 4.1 `lando pull`/`push` feature can plug in after feature freeze without inventing new SDK surface. This mirrors exactly how PRD-09 froze the `TunnelService` contract for the 4.1 `lando share` feature: ship the SDK tags, schemas, tagged errors, lifecycle events, manifest surfaces, Landofile keys, contract suites, and command/handle result schemas now; ship the bundled remotes and the real connector wiring in 4.1.

Remote data sync moves **named datasets — database, user files, and config — between a running local Lando app and a *remote*** (pull = remote→local, push = local→remote). A *remote* is any place that holds app datasets across one or more environments: a hosting platform (Pantheon/Acquia/Platform.sh/Lagoon — the marquee "hosting" category), a generic transport (rsync/ssh/s3/url/local), or a future peer/CI-artifact source. **Code is never synced** (git owns it); the scope is DB + files + config.

The design is two §4.2 pluggable abstractions whose split is the whole point: **`RemoteSource`** owns *where data lives and how to move it across the network* (the egress half, over `HttpClient`), and **`Dataset`** owns *what a slice of app state is and how to capture/apply it locally* (the landing half, over `DataMover`). A portable artifact (a `DataMover` `DataEndpoint`) is the seam. Splitting them makes a new hoster one `RemoteSource` and a new dataset kind one `Dataset` — N+M, not the N×M explosion a monolithic hoster abstraction would force (every provider re-implementing dump/tar/gzip/progress/redaction). "Hosting" is the marquee category of `RemoteSource`, **not** the contract name — settled here while it is still pure forward-reference prose, before any code or schema names it.

This PRD ships **contract-only**: the published surface, the contract suites, in-memory test doubles, and provider-aware command/handle skeletons that resolve a `RemoteSource` through the registry and fail with actionable remediation when none is installed. No bundled generic remote, no hoster plugin, and no `database`/`files` `Dataset` implementation ships here — those are 4.1, and the engine-specific `database` dataset (mysqldump/pg_dump) lands in the bundled `@lando/sql` plugin so "no SQL helpers in core" (§10.7) survives intact.

Depends on: **PRD-04** (schema publication + SDK surface discipline; the canonical Landofile serializer the `Dataset`/translator round-trips reuse), **PRD-09** (`HttpClient`/`Downloader`/tool-provisioning — the egress half; the `TunnelService` freeze this PRD mirrors), **PRD-13** (`PathsService` + `StateStore` — remote/lock state), **PRD-14** (the probe primitive for readiness; the §13.1 contract-kit pattern these two suites extend; the `EventService` query surface), **PRD-15** (universal machine-output contract for `pull`/`push`/`remote --format json`), and **PRD-16** (`DataMover` + the `RuntimeProvider` data plane — the local landing half; `DataMover`'s dispatch matrix already lists the hosting-pull rows).

## Source References

- [`spec/11-subsystems.md`](../11-subsystems.md) §10.12 the remote-data-sync primitive (`RemoteSource` + `Dataset` interfaces, the portable-artifact seam, required behaviors, the `Sync` events, tagged errors, the Landofile surface, the contract suites); §10.11 the `DataMover` landing half and its hosting-pull matrix row; §10.3.2/§10.3.4 the `HttpClient` egress + tool-provisioning the remote half rides; §10.2.2 the `TunnelService` freeze this PRD mirrors; §10.7 the SQL-helpers-are-plugin boundary.
- [`spec/04-pluggability.md`](../04-pluggability.md) §4.2 the `RemoteSource` + `Dataset` catalog rows and the §4.3 selection precedence; §4.5 mandatory abstraction guarantees.
- [`spec/03-architecture.md`](../03-architecture.md) §3.5 the `Sync` lifecycle event scope; §3.7 the canonical redaction invariant the sync events compose.
- [`spec/06-services.md`](../06-services.md) §6.12.4 the `creds:` contract a `database` `Dataset` reads local connection details from.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.4 the `remotes:`/`sync:` top-level keys; §7.8/§7.8.1 schema publication + the canonical serializer.
- [`spec/09-embedding.md`](../09-embedding.md) §16.2/§16.3 the `App` handle `pull`/`push`/`remote` methods and the `@lando/core/cli` operations.
- [`spec/10-plugins.md`](../10-plugins.md) §9.5 the `remoteSources:`/`datasets:` contribution surfaces and their contribution rules.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1 the `RemoteSource` + `Dataset` contract suites.
- [`spec/alpha-4/prd-alpha-4-00-index.md`](./prd-alpha-4-00-index.md) verification contract, SDK/schema lockstep, the §13.2 snapshot gate, and dual-dispatch rules.

## Goals

- Publish the `@lando/sdk` `RemoteSource` + `Dataset` service tags, the data-sync schemas, the tagged errors, the `Sync` event payloads, and the `remoteSources:`/`datasets:` manifest surfaces as additive, snapshot-gated SDK surface — frozen so 4.1 needs no new SDK surface.
- Add the `remotes:`/`sync:` keys to `LandofileShape` (accepted raw/unresolved, the same way `includes:` is) and wire the §4.2 catalog rows and §9.5 contribution rules.
- Ship the §13.1 `RemoteSource` and `Dataset` contract suites from `@lando/sdk/test`, plus the in-memory `TestRemoteSource`, a `local` reference source, and `TestDataset` from `@lando/core/testing`, so every guarantee is pinned before any real remote exists.
- Freeze the `app:pull`/`app:push`/`app:remote:*` commands and the `App.pull`/`App.push`/`App.remote` handle methods as provider-aware skeletons: resolve a `RemoteSource` through the registry, return the universal result schemas, and fail with actionable `RemoteProviderUnavailableError`/`RemoteToolMissingError` remediation when none is installed — with source/compiled dual-dispatch parity.
- Settle the naming (`RemoteSource`, with "hosting" as category language only) across every spec/PRD forward-reference, annotate the `DataMover` hosting-pull matrix row with the `Dataset`/`RemoteSource` split, and record the canonical-surface governance note in `AGENTS.md`.

## User Stories

### US-344: Publish the `RemoteSource` + `Dataset` SDK contract surface

**Description:** As a plugin author or embedding host, I can build a remote-sync source or dataset against a stable, frozen contract — two service tags, the data-sync schemas, tagged errors, the `Sync` lifecycle events, and the `remoteSources:`/`datasets:` manifest surfaces — so the 4.1 `lando pull`/`push` feature plugs in without new SDK surface after feature freeze.

**Acceptance Criteria:**

- [ ] `@lando/sdk/services` publishes the `RemoteSource` (`@lando/core/RemoteSource`) and `Dataset` (`@lando/core/Dataset`) `Context.Service` tags with the §10.12 methods, re-exported from `@lando/core/services`, and `sdk/src/services/index.ts` carries the matching `declare class` mirrors.
- [ ] A new `sdk/src/schema/remote-sync.ts` exports `RemoteCapabilities`, `RemoteConfig`, `RemoteEnvironment`, `RemoteEnvId`, `RemoteLocator`, `RemoteFetchOptions`, `RemoteSendOptions`, `RemoteTestResult`, `DatasetKind` (`"database" | "files" | "config" | "blob"`), `DatasetCapabilities`, `DatasetArtifactFormat`, `DatasetContext`, `DatasetCaptureOptions`, `DatasetApplyOptions`, `DatasetApplyResult`, and the `SyncResult` command/handle result schema, matching §10.12 verbatim; the portable-artifact type reuses the PRD-16 `DataEndpoint`.
- [ ] `@lando/sdk/errors` exports the tagged `RemoteError`, `RemoteUnreachableError`, `RemoteAuthError`, `RemoteEnvNotFoundError`, `RemoteDatasetUnsupportedError`, `RemoteProviderUnavailableError`, `RemoteProtectedEnvError`, `RemoteToolMissingError`, `DatasetError`, `DatasetCaptureError`, `DatasetApplyError`, and `DatasetBindingError` (no `line`/`column` field names per the Bun `TaggedError` gotcha).
- [ ] The `Sync` lifecycle event scope (`pre-/post-pull`, `pre-/post-push`, `pre-/post-dataset-fetch`, `pre-/post-dataset-apply`, `pre-/post-dataset-capture`, `pre-/post-dataset-send`; §3.5) ships with **redacted** payload schemas registered in the event inventory used by the §13.x gates.
- [ ] The `remoteSources:` and `datasets:` manifest contribution surfaces (§4.2/§9.5) are added to the `PluginManifest` schema (`id`/`module`/`capabilities`), validated at plugin load, and the manifest-schema snapshot is updated.
- [ ] The new persisted schemas are added to `JSON_SCHEMA_REGISTRY` + `SDK_SCHEMA_NAMES`, the §13.2 snapshot gate round-trips them, and `bun run codegen:schema-snapshot` then `git diff --exit-code` is clean; `sdk/API_COMPATIBILITY.md`, the SDK export fixtures, and `exports.test.ts` are updated additively in the same change.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-345: Add the `remotes:`/`sync:` Landofile keys and wire the pluggability/contribution surfaces

**Description:** As a Landofile author, I can declare remotes and dataset bindings, and as a plugin author I can see `RemoteSource`/`Dataset` in the canonical pluggability and contribution registries.

**Acceptance Criteria:**

- [ ] `LandofileShape` (and `@lando/core/schema`) gains an optional `remotes:` map (each entry a `{ source, ...sourceConfig }` validated structurally; the source-specific block is validated by the selected source's `configSchema` at use time) and an optional `sync:` dataset-binding map, matching §7.4.
- [ ] `LandofileService.discover` ACCEPTS `remotes:`/`sync:` raw/unresolved (it does not beta-reject them and does not resolve a remote), exactly the way it accepts raw `includes:`; resolution/credential reads happen only in the 4.1 `pull`/`push` path, so `discover`'s frozen error union is unchanged.
- [ ] The §4.2 catalog carries the `RemoteSource` and `Dataset` rows; §9.5 carries the `remoteSources:`/`datasets:` contribution rules (unique `id`/`module`/`capabilities`; a `RemoteSource` declares its `datasets`/`auth`/`push`/`protectedByDefault`; a `Dataset` declares its `kind`).
- [ ] Dataset binding inference is specified and decoded: a single `database` service-type with `creds:` auto-provides the `database` dataset bound to itself; multiple DB services require an explicit `sync.database.service`; framework presets bind `files` to the upload dir. (Inference logic itself is 4.1; this story freezes the decoded shape + the ambiguity error `DatasetBindingError`.)
- [ ] `bun run codegen:schema-snapshot` then `git diff --exit-code` is clean; `sdk/API_COMPATIBILITY.md` records the `LandofileShape` additions as additive.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-346: Ship the §13.1 `RemoteSource` + `Dataset` contract suites and the test doubles

**Description:** As a plugin author, I can prove a `RemoteSource` or `Dataset` implementation preserves the §10.12 guarantees by running it through a published shared suite, and core's own built-in test doubles pass it.

**Acceptance Criteria:**

- [ ] `@lando/sdk/test` exports `makeRemoteSourceContractSuite` and `makeDatasetContractSuite`, each asserting the §10.12/§13.1 guarantees for its abstraction (the rows added to the §13.1 table).
- [ ] The `RemoteSource` suite asserts: capability honesty; `listEnvironments`/`resolve` determinism and `RemoteEnvNotFoundError`/`RemoteDatasetUnsupportedError` for unknown env/dataset; all egress issued through the resolved `HttpClient` (no direct `fetch`/socket — proven with a recording `HttpClient`); vendor-CLI provisioning through the tool-provisioning helper/`Downloader`; `Scope`-bound `fetch`/`send` finalizing on `Effect.interrupt`; the local landing half delegated to a `Dataset` + `DataMover` (never re-implemented); `push` rejected when `capabilities.push` is false and `--force` required for a `protectedByDefault` env; token/auth-URL/host-path redaction in the `Sync` events; probe-based readiness (no ad-hoc retry).
- [ ] The `Dataset` suite asserts: `capture` produces and `apply` consumes a portable `DataEndpoint` exclusively through `DataMover`; `capture`→`apply` round-trips bytes; `localStore` is reported so the orchestrator can auto-snapshot; DB creds ride env (never argv); a code-tree-targeting binding fails `DatasetBindingError`; idempotent/replay-safe; redacted `pre-/post-dataset-capture`/`-apply` events.
- [ ] `@lando/core/testing` exports an in-memory `TestRemoteSource`, a reference `local` `RemoteSource`, and a `TestDataset`, all passing their suites with no real network/provider; the suites run against these built-ins and the §13.1 layer-coverage rule treats a published suite with no built-in invocation as a failure.
- [ ] `sdk/API_COMPATIBILITY.md`, the SDK export fixtures, and `sdk/test/library/exports.test.ts` are updated for the new `@lando/sdk/test` exports; the §16/§9 import-boundary test still passes (`@lando/sdk/test` stays OCLIF-free).
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-347: Freeze `app:pull`/`app:push`/`app:remote:*` commands and `App.pull`/`push`/`remote` handle methods as provider-aware skeletons

**Description:** As a CLI user or embedding host, `lando pull` / `App.pull()` resolve a `RemoteSource` through the registry and either dispatch to it or fail with actionable remediation when none is installed — freezing the command, handle, result, and Landofile surface before feature freeze while the bundled remotes ship in 4.1.

**Acceptance Criteria:**

- [ ] `app:pull` / `app:push` (top-level `pull` / `push`) and `app:remote:list` / `:add` / `:remove` / `:test` / `:setup` / `app:remote:env:list` are registered with `LandoCommandSpec` entries (bootstrap `app`), each carrying a `resultSchema` (the universal-output contract, §8.11) and `--remote`/`@env`/`--only`/`--no-snapshot`/`--force`/`-y`/`--no-interactive`/`--format` flags per §10.12.
- [ ] The `App` handle exposes `pull`/`push` (returning `SyncResult`) and a `remote` namespace (`list`/`add`/`remove`/`test`/`setup`/`env`), re-exported through `@lando/core/cli` as `appPull`/`appPush`/`appRemote.*`; the SDK `App` contract addition is recorded additive.
- [ ] With no installed `RemoteSource`, `pull`/`push`/`remote test` fail with `RemoteProviderUnavailableError` carrying remediation that lists install options; `remote add` writes the `remotes:` block to the Landofile via the canonical serializer (§7.8.1) and `remote list` reads it — these two work without a provider.
- [ ] The destructive-op safety contract is wired at the orchestration layer (auto-snapshot before `apply` via `DataMover.snapshot` unless `--no-snapshot`; `InteractionService` confirm unless `-y`/`--no-interactive`; `push` blocked by `capabilities.push: false` and protected-env `--force`) and exercised against `TestRemoteSource`/`TestDataset`; no real connector wiring or bundled remote ships here.
- [ ] Source-mode (OCLIF) and compiled `$bunfs` dispatch parse and dispatch `pull`/`push`/`remote:*` identically (canonical id added to `MVP_COMMAND_IDS` + the matching `runCompiledCli` branch + the §13.1 dispatch-parity probes), and `--format json` emits the universal envelope on both paths.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-348: Settle the `RemoteSource` naming and lock cross-surface consistency

**Description:** As a maintainer, I can rely on one name (`RemoteSource`, with "hosting" as category language only) across every spec and PRD reference, and a gate that keeps the `RemoteSource`/`Dataset` surfaces consistent across the canonical registries.

**Acceptance Criteria:**

- [ ] Every legacy hosting contract token in the spec/PRD tree is renamed to `RemoteSource` (the `DataMover` §10.11 + PRD-16 non-goals, the ROADMAP Phase 8 bullet), with "hosting" retained only as the descriptive feature category; a grep proves no old contract identifier remains.
- [ ] The `DataMover` hosting-pull matrix row (§10.11) carries the annotation that the local landing endpoint is chosen by the resolved `Dataset`, not the `RemoteSource`.
- [ ] A consistency check (test or lint) asserts the `RemoteSource`/`Dataset` surface is present and aligned across the canonical registries: the §4.2 catalog rows, the §9.5 contribution rows, the §13.1 contract-suite rows, the §3.5 `Sync` events, the §7.4 Landofile keys, the §16.3 `App` methods, and the `@lando/sdk/services` tags — the same canonical-surface-governance shape the other Alpha-4 primitives use.
- [ ] The repo `AGENTS.md` carries a note recording the `RemoteSource`/`Dataset` contract freeze, the `Dataset × RemoteSource` (N+M) split, the egress(`HttpClient`)/landing(`DataMover`) composition, the "code is never synced" scope, and that the feature wave (bundled remotes, hoster plugins, `database`/`files` datasets, real connector wiring) is 4.1.
- [ ] The ROADMAP Phase 4 freeze bullet and Phase 8 feature bullet are present and consistent with the `TunnelService` precedent.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

## Functional Requirements

- FR-1: Remote data sync is two §4.2 pluggable abstractions — `RemoteSource` (egress, over `HttpClient`) and `Dataset` (local landing, over `DataMover`) — composed by a core-owned `pull`/`push` orchestration. Neither abstraction re-implements the other's half.
- FR-2: A `RemoteSource` MUST route all control-plane + byte egress through the resolved `HttpClient` (§10.3.2) and acquire any vendor CLI through the tool-provisioning helper/`Downloader` (§10.3.4); it MUST NOT call `fetch` or open sockets directly.
- FR-3: A `Dataset` MUST move bytes only through `DataMover` (§10.11), pass DB credentials via env (never argv), be idempotent/replay-safe, and report `localStore` so the orchestrator can auto-snapshot before a destructive `apply`.
- FR-4: `pull` MUST auto-snapshot the target local store (via `DataMover.snapshot`) before `apply` unless `--no-snapshot`, and confirm through `InteractionService` unless `-y`/`--no-interactive`. `push` MUST be rejected when `capabilities.push` is false and MUST require `--force` + typed confirmation for a `protectedByDefault` environment.
- FR-5: Remote sync MUST move DB + files + config only and MUST refuse a binding that targets the app's tracked code tree (`DatasetBindingError`).
- FR-6: All tokens/auth URLs/signed-URL query params/host paths MUST be redacted through `RedactionService` (§3.7) before any log/event/transcript/JSON/telemetry/durable-state write; the `Sync` events publish only redacted payloads.
- FR-7: `pull`/`push`/`remote --format json` and `App.pull`/`push`/`remote.*` MUST return the universal machine-output/result schemas (§8.11); long-running foreground transfers emit `StreamFrame`s.
- FR-8: Remote configuration lives in the Landofile `remotes:`/`sync:` keys; any remote-resolution lockfile/marker rides a `StateStore` bucket (§12.7); roots resolve through `PathsService` (§7.5.1). Readiness/retry uses the §10.5.1 probe primitive.
- FR-9: This PRD is contract-only: no bundled generic remote, no hoster plugin, and no `database`/`files` `Dataset` implementation ships here. The engine-specific `database` `Dataset` is a plugin (`@lando/sql`), preserving "no SQL helpers in core" (§10.7).
- FR-10: The contract name is `RemoteSource`; "hosting" is category/marketing language only. Every public surface addition updates `sdk/API_COMPATIBILITY.md`, the SDK export fixtures, the schema registry/`SDK_SCHEMA_NAMES`, and the §13.2 snapshot in the same change, additively.

## Non-Goals

- Shipping the feature: bundled `local`/`rsync`/`ssh`/`url`/`s3` remotes (beyond the in-memory/`local` test doubles), hoster plugins (Pantheon/Acquia/Platform.sh/Lagoon), the `database`/`files` `Dataset` implementations, and the real `app:pull`/`push` connector wiring are 4.1.
- Engine-specific dump/import logic in core; the `database` `Dataset` ships in the bundled `@lando/sql` plugin.
- Code sync, continuous/scheduled replication, and live bidirectional sync (that is `FileSyncEngine`, §10.6).
- A new byte-movement path; the local half is `DataMover` (PRD-16) and the remote half is `HttpClient` (PRD-09) — this PRD adds no socket and no provider data-plane method.
- A `peer`/CI-artifact remote implementation (the architecture preserves it as another `RemoteSource`; not built here).
- Making `RemoteSource`/`Dataset` anything other than §4.2 plugin abstractions; the `pull`/`push` orchestration is core, not a contribution surface.

## Technical Considerations

- This is the `TunnelService` freeze pattern (PRD-09 US-342/343) applied to a two-abstraction surface: publish the contract + suites + provider-aware skeletons now; ship providers in 4.1. Reuse that PRD's structure for the command/handle skeleton and the no-provider remediation path.
- The portable artifact is a PRD-16 `DataEndpoint` (`stream`/`hostArchive`); do not invent a second artifact type. `RemoteSource.fetch`→`Dataset.apply` and `Dataset.capture`→`RemoteSource.send` are the only two compositions the orchestrator wires.
- `remotes:`/`sync:` ride `LandofileShape` and are accepted raw by `discover` exactly like `includes:` (PRD-era pattern), so `discover`'s frozen error union does not widen; resolution lives in the 4.1 `pull`/`push` path (analogous to `loadUserLandofile` resolving includes).
- The `database` `Dataset` reads `creds:` (§6.12.4) and lands via `DataMover.transfer(stream → serviceCmd(psql|mysql))`; the `files` `Dataset` lands via `DataMover.transfer(stream/hostArchive ↔ servicePath/hostPath)`. Freeze the `DatasetContext` shape (`{ app, plan, service, creds? }`) so 4.1 implementations have one authoritative input.
- `RemoteSource` joins the §3.7/§4.2 `RedactionService` consumer list alongside `HttpClient`/`Downloader`/`DataMover`/`TunnelService`; it composes the canonical redactor and never ships a local copy. The §13.4 redaction lint gate covers it.
- Keep the §13.1 suites in the `make<X>ContractSuite` shape the PRD-14 kit established; reuse the recording `HttpClient`, in-memory `FileSystem`/`ProcessRunner`, and `TestDataMover` doubles rather than adding new infrastructure.
- The `App.remote` namespace mirrors `App.config`/`App.events` (a nested API object), and `App.pull`/`push` mirror `App.share` (frozen method, feature 4.1) — add them to the SDK `App` contract, whose implementation is opaque/branded so the addition is non-breaking inside 4.x.

## Success Metrics

- `@lando/sdk` publishes `RemoteSource` + `Dataset` tags, the remote-sync schemas, the tagged errors, the `Sync` events, and the `remoteSources:`/`datasets:` manifest surfaces; the schema snapshot and SDK backward-compat fixtures stay green (additive only).
- The §13.1 `RemoteSource` + `Dataset` contract suites run against `TestRemoteSource`/`local`/`TestDataset`, cover capability honesty + egress-through-`HttpClient` + landing-through-`DataMover` + redaction + safety, and the layer-coverage gate fails if a suite or its built-in invocation is removed.
- `lando pull`/`push`/`remote:*` and `App.pull`/`push`/`remote.*` exist, return the universal envelope, parse identically on source/compiled paths, and fail with actionable `RemoteProviderUnavailableError` when no remote is installed; `remote add`/`list` round-trip the Landofile `remotes:` block through the canonical serializer.
- No legacy hosting contract identifier remains in the spec/PRD tree; the `DataMover` matrix row carries the `Dataset`/`RemoteSource` annotation; `AGENTS.md` records the freeze + the N+M split + the 4.1 feature scope.
- A 4.1 plugin author can implement a `RemoteSource` (or the `@lando/sql` `database` `Dataset`) against the frozen contract and pass its suite without any new SDK surface.

## Guide Coverage

**None — internal/infra PRD.**

This PRD freezes the `RemoteSource`/`Dataset` contract surface; it ships no user-facing command behavior (the skeletons fail with remediation when no provider is installed). The user-facing guides for `lando pull`/`push` and the per-hoster flows are owned by the 4.1 PRDs that ship the bundled remotes and hoster plugins.

## Open Questions

- Should the bundled generic remotes (`rsync`/`ssh`/`s3`/`url`) share an internal `Transport` helper that is later promotable to a public `@lando/sdk` contract, or stay private until a third-party transport demand appears? Default: private internal helper in 4.1; promote only on demand (the `local`/`TestRemoteSource` doubles need no transport).
- Should `remotes:` live only in the Landofile, or also in global config for per-user credentials? Default: structure in the Landofile, secrets via `${secret:…}` only (never committed tokens); a `.lando.local.yml` overlay covers per-dev remotes. Revisit if teams want user-global remotes.
- Should a `config` `Dataset` be part of the frozen surface now or added when a concrete consumer appears? Default: freeze `DatasetKind` to include `config`/`blob` (so the enum does not widen later) but ship only `database`/`files` implementations in 4.1.
- Should `App.pull`/`push` default to a safety snapshot the way the CLI does, given a host may want raw control? Default: same safe default as the CLI (`--no-snapshot` equivalent option to opt out), so embedding hosts inherit the data-safety guarantee.
