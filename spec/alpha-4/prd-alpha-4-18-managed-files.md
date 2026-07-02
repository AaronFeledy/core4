# PRD: ALPHA4-18 — Managed-file primitive (`ManagedFileService` + format codecs)

## Introduction

Alpha 4 lands the missing member of the branch's chokepoint-primitive family: the
`ManagedFileService` (§10.13) — the single chokepoint for Lando-owned writes into the
**user's working tree** (the project files the user owns and may *adopt*: `settings.php`,
`wp-config.php`, `.env`, `.devcontainer/devcontainer.json`, a generated Landofile
fragment). Where `HttpClient`/`Downloader` (§10.3.2/3) is the chokepoint for outbound
bytes, `DataMover` (§10.11) for local volume/service/archive bytes, and `RemoteSource`/
`Dataset` (§10.12) for remote data sync, **there is today no chokepoint for owned
project-file writes** — and the gap is real: recipe scaffolding (§8.8.3 `files:`) writes
one-shot files with no ownership marker, no idempotency, no adopt path, and there is no
settings-management seam at all.

This PRD implements the normative §10.13 primitive: the SDK managed-file schemas and the
`ManagedFileService` tag, a pure file-format codec module (text/env/json/yaml + the
`@lando/sdk/landofile` serializer), the core `ManagedFileServiceLive` orchestrator (the
ownership-marker + `StateStore`-backed ledger + drift/conflict detection + atomic write +
realpath containment + the `ManagedFile` lifecycle events), the `file` and `block`
management modes, and the migration of the one existing on-disk-scaffold consumer (recipe
`files:`) onto the primitive. It is **contract + substrate only**, mirroring the
`DataMover` (PRD-16) and `RemoteSource` (PRD-17) shape: the user-facing *consumers* — CMS
settings management, `lando add <service>`, devcontainer generation, the user-facing
`files:` Landofile key, the `lando files *` command surface, and the `keys`-mode
structural merge — ship in 4.x. The marker safety model is deliberately **safer than
DDEV's `#ddev-generated`**: an in-place user edit under a still-present marker is detected
via the ledger checksum and surfaces as a *conflict* (skip + `lando doctor`), not a silent
overwrite.

The ledger-on-`StateStore`, the `PathsService`-resolved ledger root, the shared
streaming-hash/atomic-write helper, the realpath-containment helper, the canonical
`RedactionService`, and the `EventService` bounded redacted history are deliberate reuse of
the branch's existing PRD-06/13/16 primitives rather than re-derivation; the
`ManagedFileService` is the only net-new service.

Depends on: **ALPHA4-04** (the `@lando/sdk/landofile` serializer the `landofile`/`yaml`
codecs and `block`/`keys` modes round-trip through, plus SDK surface discipline),
**ALPHA4-06** (the canonical `RedactionService` every managed-file event/transcript is
masked through, and the §13.4 redaction gate), **ALPHA4-13** (the `PathsService` that
resolves the ledger root and the durable `StateStore` the ledger is realized through),
**ALPHA4-14** (the `EventService` bounded redacted history the `ManagedFile` events feed),
and **ALPHA4-16** (the shared streaming-hash/atomic-write helper and the realpath-
containment helper this PRD reuses).

## Source References

- [`spec/11-subsystems.md`](../11-subsystems.md) §10.13 the managed-file primitive
  (§10.13.1 the `ManagedFile` model + `ContentSource`, §10.13.2 the `ManagedFileService`
  and required behaviors, §10.13.3 the marker + `StateStore` ledger + decision algorithm,
  §10.13.4 errors, §10.13.5 the contract suite); §10.11 the `DataMover` delineation
  (`DataMover` = opaque bytes; `ManagedFileService` = owned project files) and the shared
  streaming-hash/atomic-write + realpath-containment helpers it factors out.
- [`spec/03-architecture.md`](../03-architecture.md) §3.4 the `ManagedFileService` core
  service (level `minimal`, `Layer.suspend`, host/test-overridable, not plugin-replaceable)
  and the `RedactionService` consumer list; §3.5 the `ManagedFile` lifecycle event scope;
  §3.7 the canonical secret-redaction invariant the events compose.
- [`spec/04-pluggability.md`](../04-pluggability.md) §4.2 — `ManagedFileService` is
  host/test-overridable but NOT a plugin contribution surface (no `managedFiles:`), like
  `StateStore` / `DataMover` / `RedactionService` / `EmbeddedAssetService`.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.5.1 the
  `PathsService` `managedFileLedger(appId)` derived path; §7.8.1 the `@lando/sdk/landofile`
  serializer the codecs delegate to; §7.3.2 the `TemplateRenderer` the `template`/`inline`
  content sources render through.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.8.3 the recipe `files:`
  manifest realized through `ManagedFileService`.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) §12.7 the
  `StateStore` bucket the ledger is realized through; §12.4 the ledger persistent-artifact
  path.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1 the
  managed-file contract test layer (StateStore-style) and §13.4 the `check:managed-file-
  boundary` gate.
- [`spec/09-embedding.md`](../09-embedding.md) §16.2 the `ManagedFileService` tag on the
  embedding surface; §16.8 the `@lando/core/testing` `TestManagedFileStore`.
- [`spec/alpha-4/prd-alpha-4-00-index.md`](./prd-alpha-4-00-index.md) verification contract,
  SDK/schema lockstep, the §13.2 snapshot gate, and dual-dispatch rules.

## Goals

- Publish `@lando/sdk/schema` managed-file schemas, the `ManagedFileService` service tag,
  the `ManagedFile` event payloads, and the `ManagedFileError` tagged error as additive,
  snapshot-gated SDK surface.
- Ship a pure file-format codec module (text, env, json, yaml; `landofile` delegating to
  the `@lando/sdk/landofile` serializer) shared by `ManagedFileService` and the §6.4 mount
  materializer, so structured encode/decode + the Landofile round-trip exist once.
- Implement `ManagedFileServiceLive` at level `minimal` (`Layer.suspend`): the ownership-
  marker contract, the `StateStore`-backed ledger, the `file` and `block` management modes,
  the create/update/skip/conflict/adopt decision algorithm, realpath containment, atomic
  write through the shared helper, and the redacted `ManagedFile` lifecycle events.
- Make the safety contract testable: an in-place user edit under a present marker is a
  detected conflict (skip + doctor), never a silent overwrite; adoption (delete the marker
  or `release`/`adopt`) is honored.
- Reuse, not re-derive: ledger on `StateStore`, root via `PathsService.managedFileLedger`,
  atomic write + containment via the ALPHA4-16 shared helpers, redaction via
  `RedactionService`, events into the ALPHA4-14 bounded redacted history.
- Migrate the recipe `files:` scaffold writer onto `ManagedFileService` so scaffolded files
  become updatable + adoptable, and add the `check:managed-file-boundary` gate.
- Expose `ManagedFileService` to plugins (pre-namespaced) and embedding hosts, ship an
  in-memory `TestManagedFileStore`, and a `@lando/sdk/test` contract suite.

## User Stories

### US-349: Publish the SDK managed-file schemas, `ManagedFileService` tag, and `ManagedFileError`

**Description:** As a plugin author or embedding host, I can consume a stable
`ManagedFileService` contract, the typed `ManagedFile` model, and the managed-file error
tag instead of inventing my own ownership-aware file-write surface.

**Acceptance Criteria:**

- [ ] A new `sdk/src/schema/managed-file.ts` exports `ManagedFile` (`id`, `owner`, `path`,
  `mode: "file" | "block" | "keys"`, `format`, `content`, `marker?`, `perms?`,
  `onConflict?`, `base?`), `FileFormat` (`"text" | "env" | "json" | "yaml" | "toml" | "ini"
  | "landofile"`), `ContentSource` (the four-member tagged union `text` | `structured` |
  `template` | `inline`), `ManagedFileAction` (`"create" | "update" | "skip-unchanged" |
  "skip-adopted" | "conflict" | "adopt-detected"`), `ManagedFilePlan`, `ManagedFileInfo`
  (`path`, `owner`, `mode`, `state: "managed" | "adopted" | "conflict" | "missing" |
  "drifted"`), and `ManagedFileResult`, matching the §10.13.1/§10.13.2 shapes verbatim.
- [ ] `@lando/sdk/services` exports the `ManagedFileService` `Context.Service` tag
  (`@lando/core/ManagedFileService`) with `plan`, `apply`, `remove`, `status`, `adopt`,
  `release`, and `sdk/src/services/index.ts` carries the matching `declare class
  ManagedFileService` mirror.
- [ ] `@lando/sdk/errors` exports the tagged `ManagedFileError` with a `reason: "io" |
  "decode" | "conflict" | "path" | "format"` discriminator plus `operation`, `path`,
  `cause`, and `remediation` fields (no `line`/`column` field names per the Bun
  `TaggedError` gotcha).
- [ ] The persisted schemas that cross the published surface (`ManagedFile`,
  `ManagedFileInfo`, `ManagedFilePlan`, `ManagedFileResult`) are added to
  `JSON_SCHEMA_REGISTRY` + `SDK_SCHEMA_NAMES` and the §13.2 schema-snapshot gate
  round-trips them; `bun run codegen:schema-snapshot` then `git diff --exit-code` is clean
  on generated/snapshot paths.
- [ ] `sdk/API_COMPATIBILITY.md` records the `ManagedFileService` tag, the managed-file
  schemas, and `ManagedFileError` as additive, and the SDK export fixtures +
  `exports.test.ts` are updated in the same change.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-350: Implement the shared file-format codec module and route the mount materializer through it

**Description:** As a maintainer, I can encode/decode structured project files
(text/env/json/yaml/landofile) through one pure module that both `ManagedFileService` and
the §6.4 mount materializer consume, so structured encode and the Landofile round-trip
exist exactly once.

**Acceptance Criteria:**

- [ ] `core/src/managed-file/codecs.ts` exports `encode(format, value, opts)`,
  `decode(format, text)`, and a `mergeManaged(format, existing, ownedSubtree, marker)`
  stub for `file`, `env`, `json`, `yaml`, and `landofile`; `toml`/`ini` are declared but
  may throw `ManagedFileError reason:"format"` until 4.x, and `keys`-mode `mergeManaged`
  for structured formats is stubbed to fail with a clear "deferred to 4.x" remediation.
- [ ] The `landofile` and `yaml` codecs delegate emit/parse to the `@lando/sdk/landofile`
  serializer (ALPHA4-04 §7.8.1); `emitLandofileYaml` is no longer called directly from the
  codec module (one Landofile round-trip implementation).
- [ ] The codec module is pure and dependency-light (no `effect` runtime service, no
  `@oclif/core`); an import-boundary assertion proves it constructs no `LandoRuntime`.
- [ ] The §6.4 mount materializer (`type: template`/`inline`) obtains its rendered/encoded
  bytes through the codec module + `TemplateRenderer` rather than a private encode path;
  existing mount-materializer tests stay green (behavior-preserving).
- [ ] Atomic writes performed by the codec consumers go through the ALPHA4-16 shared
  streaming-hash/atomic-write helper (temp → fsync → rename, temp removed on
  interrupt/failure); no direct `writeFileAtomicViaRename` call is added.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-351: Implement `ManagedFileServiceLive` (`file`/`block` modes, marker, ledger, decision algorithm) at level `minimal`

**Description:** As the runtime, I can render+write a managed project file idempotently,
respecting the user's ownership marker and never clobbering an in-place edit, through one
service available from bootstrap `minimal`.

**Acceptance Criteria:**

- [ ] `core/src/managed-file/service.ts` implements `ManagedFileServiceLive`, emitted
  eagerly-but-`Layer.suspend`-wrapped into the generated `minimal` bootstrap layer by
  editing `scripts/build-bootstrap-layers.ts` and regenerating
  `core/src/runtime/generated/layers/minimal.ts` (never editing the generated file
  directly); `git diff --exit-code` is clean after regeneration. It is host/test-
  overridable but NOT a §4.2 plugin contribution surface.
- [ ] `plan(files)` computes a side-effect-free `ManagedFilePlan` (per-file `create` |
  `update` | `skip-unchanged` | `skip-adopted` | `conflict` | `adopt-detected`); `apply`
  honors the plan and returns what it actually did; `plan` and `apply` agree for the same
  inputs.
- [ ] `mode: "file"` writes the whole file with a first-line ownership marker (per-format
  comment syntax; JSON falls back to the ledger + optional `x-lando-generated` key);
  `mode: "block"` replaces only the content between `# >>> lando:<id> >>>` … `# <<< lando:<id>
  <<<` fences in a user-owned file and is idempotent across re-apply.
- [ ] The decision algorithm matches §10.13.3: not-exists → create; exists w/o marker &
  not in ledger → `skip-adopted` (record adopted); marker present & ledger checksum matches
  current bytes → `skip-unchanged` (or `update` when the rendered `sourceHash` changed);
  marker present & ledger checksum ≠ current bytes → `conflict` (default `onConflict:
  "skip"` warns + skips, `overwrite`/`--force` backs up then updates, `fail` errors);
  ledger state `adopted` → `skip-adopted`.
- [ ] The ledger is a `StateStore` bucket (`root: "userData"`, `namespace:
  managed-files/<app-id>`, `key: ledger.json`, `codec: "json"`, `lock: "advisory"`,
  `onCorrupt: "quarantine"`, `version: 1`) resolved through `PathsService` (US-353); the
  ledger inherits the §12.7 atomic write + version header + corruption quarantine + lock
  and is rebuildable by scanning markers (the marked files are the committed source of
  truth).
- [ ] `remove(selector)` deletes only files/blocks the ledger records as Lando-owned (for
  the 4.x `destroy --purge`/`uninstall` consumers); `adopt(path)`/`release(path)` flip the
  ledger ownership state and (for `adopt`) strip the marker.
- [ ] A managed-file `path` whose realpath escapes its resolved `base` (app root by
  default) is rejected with `ManagedFileError reason:"path"` via the ALPHA4-16 realpath-
  containment helper; symlink escape is rejected.
- [ ] All writes are `Scope`-bound; `Effect.interrupt` leaves no torn file (atomic rename)
  and no orphan temp; `@lando/core/testing` ships an in-memory `TestManagedFileStore` so
  unit tests need no real disk.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-352: Emit redacted `ManagedFile` lifecycle events and join the `RedactionService` consumer list

**Description:** As an embedding host, `lando doctor`, or a guide assertion, I can observe
managed-file activity through redacted lifecycle events that never leak the secret-laden
file content.

**Acceptance Criteria:**

- [ ] `ManagedFileService` publishes the `ManagedFile` lifecycle scope (§3.5) —
  `pre-managed-file-write`, `post-managed-file-write`, `managed-file-conflict-detected`,
  `managed-file-skipped` — with payloads carrying `path`, `owner`, `action`, and a redacted
  summary, and **never** file content.
- [ ] Every payload is routed through the canonical `RedactionService` (§3.7) before it is
  published or buffered; `ManagedFileService` is added to the `RedactionService` consumer
  list (§3.7/§4.2) and the §13.4 redaction lint gate covers it.
- [ ] Events feed the ALPHA4-14 bounded redacted `EventService` history so a host/doctor can
  `query`/`waitFor` them; a test proves a known secret value (e.g. a DB password written
  into a `settings.php` block) never appears in any emitted event, the history buffer, or a
  transcript.
- [ ] The ledger `backup` (when `onConflict: "overwrite"` backs up prior content) is stored
  `0600`, redaction-aware, and excluded from transcripts.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-353: Resolve the ledger root through `PathsService`, migrate recipe `files:`, and add the boundary gate

**Description:** As a maintainer, managed-file paths resolve through the one Paths primitive,
recipe scaffolding goes through the one managed-file writer, and a gate stops a parallel
host-project-file writer from re-growing.

**Acceptance Criteria:**

- [ ] `PathsService` / `@lando/core/paths` gain a `managedFileLedger(appId)` derived path
  (default `<userDataRoot>/managed-files/<app-id>/ledger.json`), with the §7.5.1 derived-
  path tests extended; nothing re-derives `<userDataRoot>/managed-files/` by hand.
- [ ] The recipe `files:` scaffold writer (§8.8.3) is re-platformed onto
  `ManagedFileService.apply` (whole-file mode, `owner` = recipe id), so scaffolded files
  carry the ownership marker and become updatable + adoptable instead of one-shot; the
  existing recipe/init scenario tests stay green (behavior-preserving for first-init).
- [ ] A `check:managed-file-boundary` gate (test or lint, §13.4-style) fails on any host-
  project-file write with overwrite/marker logic outside `core/src/managed-file/**` and its
  named consumers; the recipe writer and the mount materializer delegate, and the gate is
  wired into CI static checks.
- [ ] Source-mode and compiled `$bunfs` dispatch resolve the same ledger path and recipe
  writer (dual-dispatch parity preserved).
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-354: Expose `ManagedFileService` to plugins/hosts, ship `TestManagedFileStore`, and enforce the contract suite

**Description:** As a plugin author or embedding host, I can write ownership-aware project
files through a pre-namespaced managed-file surface and prove any implementation preserves
the §10.13 guarantees.

**Acceptance Criteria:**

- [ ] `LandoPluginContext` gains a `managedFiles` accessor pre-namespaced to the plugin's
  `owner` id (a plugin's managed files are recorded with `owner: <plugin-id>` and cannot be
  removed/adopted on behalf of another owner); a plugin-context test proves the ownership
  scoping.
- [ ] `makeLandoRuntime` exposes `ManagedFileService` on the runtime so embedding hosts can
  `plan`/`apply`/`status` under an isolated `base`; a library-API test applies a managed
  file under an isolated app root and re-reads its `status`.
- [ ] `@lando/core/testing` exports the in-memory `TestManagedFileStore` (no disk;
  inspectable) that satisfies the contract suite.
- [ ] `@lando/sdk/test` exports a `ManagedFileService` contract suite (StateStore-style,
  since this is an integrity invariant not a §4.2 abstraction) that runs against
  `ManagedFileServiceLive`, `TestManagedFileStore`, and any host/test override, asserting:
  create/update/skip-unchanged/skip-adopted/conflict/adopt/release/remove; `plan` matches
  `apply`; atomic replace with no torn write under `Effect.interrupt`; path-escape
  rejection; marker round-trip per format; `block` idempotency; and that a known secret
  never appears in an emitted event.
- [ ] The §13.1 test-layer table gains the managed-file contract-suite row, and the
  `@lando/sdk/test` exports gate lists the new suite export.
- [ ] The repo `AGENTS.md` managed-file note and the §10.13 / §3.4 / §3.5 / §4.2 / §9.8
  spec surfaces are present and consistent.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

## Functional Requirements

- FR-1: All Lando-owned writes into the user's working tree (project files the user may
  adopt) MUST flow through `ManagedFileService`; hand-rolling ownership-marker/overwrite
  logic for host project files outside `core/src/managed-file/**` and its named consumers
  is forbidden and gated by `check:managed-file-boundary`.
- FR-2: `ManagedFileService` MUST be available at bootstrap `minimal` (`Layer.suspend`),
  MUST NOT depend on `ConfigService`/the provider/the network/any plugin module, and MUST
  resolve roots through `PathsService` (§7.5.1).
- FR-3: `ManagedFileService` is host/test-overridable but MUST NOT be a §4.2 plugin
  contribution surface; there is no `provides.managedFiles` manifest key. Plugins write
  managed files only through the pre-namespaced `LandoPluginContext.managedFiles`.
- FR-4: A present ownership marker whose ledger checksum no longer matches the on-disk bytes
  MUST be treated as a `conflict` and, under the default `onConflict: "skip"`, MUST NOT be
  overwritten; the conflict surfaces to `lando doctor` (4.x). Deleting the marker (or
  `adopt`) MUST permanently stop Lando from touching the file.
- FR-5: Every `apply`/`remove` write MUST be atomic via the ALPHA4-16 shared streaming-hash/
  atomic-write helper; a crash MUST never leave a partially written live file or an orphan
  temp.
- FR-6: A managed-file path MUST be realpath-contained under its resolved `base`; an escape
  fails `ManagedFileError reason:"path"` (shared containment helper).
- FR-7: The ledger MUST be realized through a `StateStore` bucket (§12.7) — no bespoke
  registry/lock/quarantine — and MUST be rebuildable from on-disk markers.
- FR-8: Every `ManagedFile` event and transcript MUST be routed through `RedactionService`
  (§3.7); file content MUST NOT appear in any event, the history buffer, or a transcript.
- FR-9: Recipe `files:` (§8.8.3) MUST be realized through `ManagedFileService`; the mount
  materializer (§6.4) MUST obtain bytes through the shared codec module.
- FR-10: Every SDK surface addition MUST update `sdk/API_COMPATIBILITY.md`, the SDK export
  fixtures, the schema registry / `SDK_SCHEMA_NAMES`, and the §13.2 snapshot in the same
  change, additively.

## Non-Goals

- Shipping the consumer features: CMS settings-management `AppFeature`s, `lando add
  <service>`, devcontainer generation, the user-facing `files:` Landofile key, the `lando
  files list/diff/apply/adopt/release` command surface, and the `keys`-mode structural
  merge are **4.x** and out of scope here. This PRD ships the substrate (and the `file`/
  `block` modes only).
- Making `ManagedFileService` a plugin-replaceable `Context.Tag` abstraction or adding a
  `provides.managedFiles` surface; it is a working-tree-integrity invariant like
  `StateStore` / `DataMover` / `RedactionService` / `EmbeddedAssetService`.
- A comment/formatting-preserving CST merge for structured formats; `keys` mode (4.x) starts
  with a canonical re-emit of the owned subtree and adds CST fidelity later.
- `toml`/`ini` codecs at full fidelity; they are declared but deferred to 4.x.
- A general migration of every Lando-owned on-disk write onto this primitive; only writes
  into the *user's working tree* are in scope. `StateStore` (durable Lando state),
  `DataMover` (volume/service bytes), and the §12.5 hot-path caches keep their own seams.
- An `--undo`/backup-restore command surface; the ledger `backup` is captured but the
  user-facing restore is 4.x.

## Technical Considerations

- The codec module MUST be factored **before or with** `ManagedFileServiceLive` and reused
  by the mount materializer in the same change, so the Landofile round-trip and structured
  encode exist once; retrofitting the materializer afterward is the expensive ordering.
- The ledger is **local and rebuildable**: the committed marked files are the source of
  truth, so the ledger lives under `userData` (not the repo) and a missing/quarantined
  ledger degrades to a marker scan, never a failure. This mirrors the scratch-registry/
  include-lockfile split (one committed, one local) the §12.7 work established.
- `ManagedFileServiceLive` joins the §3.7 / §4.2 `RedactionService` consumer list exactly
  as `DataMover` (PRD-16) did; it composes the canonical redactor and never ships a local
  copy. The §13.4 redaction lint gate covers it.
- Content `vars` that need app-plan data (service creds for a `settings.php` block) are
  resolved by the *caller* at the level it runs (a 4.x framework `AppFeature` at level
  `app`); the service itself only writes, so it stays at `minimal`. Keep plan-data
  resolution out of the service.
- `block` mode's fence markers MUST be format-aware (comment syntax per `FileFormat`) and
  MUST survive re-emit by a reformatter via the ledger checksum — a marker the user's
  formatter moved is a checksum drift, i.e. a `conflict`, not a silent clobber.
- The boundary gate follows the branch's accumulating §13.4 gate family
  (`check:renderer-boundary`, `check:machine-output`, the no-hand-rolled-`Schedule` and
  no-hand-rolled-atomic-write gates); add `check:managed-file-boundary` alongside them.

## Success Metrics

- Grepping the codebase shows one managed-file implementation under `core/src/managed-file/`;
  the recipe `files:` writer and the mount materializer delegate to it, and no parallel
  ownership-marker/overwrite host-project-file writer remains.
- The §13.1 managed-file contract suite runs against `ManagedFileServiceLive` and
  `TestManagedFileStore` and covers create/update/skip/conflict/adopt/release/remove,
  atomicity, containment, marker round-trip, `block` idempotency, and secret redaction.
- An in-place user edit under a present marker is preserved (conflict, not overwritten);
  deleting the marker permanently stops management — both asserted under test.
- The ledger is a `StateStore` bucket resolved through `PathsService.managedFileLedger`; no
  bespoke ledger file/lock remains.
- The schema snapshot and SDK backward-compat fixtures stay green (additive only) after the
  managed-file schemas, service tag, and error land.

## Guide Coverage

**None — internal/infra PRD.**

This PRD publishes the `ManagedFileService` working-tree write primitive and the shared
file-format codec module. It does not directly own user-facing guide surface; the guides
for the features built on it (CMS settings management, `lando add`, devcontainer
generation, the `files:` key) are owned by the 4.x PRDs that ship those consumers.

## Open Questions

- Default conflict policy: `onConflict: "skip"` + `lando doctor` (safe, recommended) vs
  DDEV's overwrite-marked-files behavior, with `--force`? Default: `skip` for Alpha 4 — a
  detected in-place edit is never silently clobbered; revisit only if field data shows the
  skip is surprising.
- Ledger location: `userData` local + rebuildable-from-markers (recommended, this PRD) vs a
  committed `.lando/managed-files.json` for team-visible drift? Default: `userData` —
  the committed marked files already carry the team-visible source of truth.
- Should the `LandoPluginContext.managedFiles` accessor allow a `base` outside the app root
  (e.g. a plugin managing a file under `userConfRoot`)? Default: app-root `base` only in
  Alpha 4; add an explicit opt-in if a plugin demand appears.
- Should `keys` mode land any structured merge in Alpha 4 (json only) or stay fully 4.x?
  Default: fully 4.x — `file`/`block` cover the Alpha 4 substrate need and avoid shipping a
  half-fidelity structural merge.
