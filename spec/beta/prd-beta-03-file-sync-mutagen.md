# PRD: BETA-03 — File sync (Mutagen)

## Introduction

Alpha declared `bindMountPerformance: "slow"` for the providers that route file I/O through a VM (provider-lando on macOS, provider-docker on macOS, Docker Desktop). Beta wires the actual fix: `@lando/file-sync-mutagen` becomes a bundled plugin, the planner auto-selects it for slow providers, and the Mutagen host CLI + per-platform agent are downloaded by `lando setup` (not embedded in the binary per §17.9).

Depends on: **BETA-01** (file sync activates per-provider `bindMountPerformance`).

## Source References

- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) `bindMountPerformance` capability.
- [`spec/11-subsystems.md`](../11-subsystems.md) file sync subsystem and `FileSyncEngine` contract.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.9 (Mutagen binaries are NOT embedded).
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) per-app file-sync state.

## Goals

- Make slow-bind-mount providers feel native to the user without manual configuration.
- Keep the file-sync engine pluggable so future engines (e.g., Mutagen alternative, FileSync-as-port-forward) can replace it.
- Keep Mutagen binaries out of the compiled Lando binary; `lando setup` is responsible for fetching them.

## User Stories

### US-095: `FileSyncEngine` contract published in `@lando/sdk`

**Description:** As a future file-sync plugin author, I can implement against a stable `FileSyncEngine` Effect Service tag with a documented contract.

**Acceptance Criteria:**
- [ ] `FileSyncEngine` service tag, contract, and tagged errors (`FileSyncStartError`, `FileSyncDriftError`, `FileSyncStopError`) exported from `@lando/sdk`.
- [ ] Contract suite stub in `@lando/sdk/test` covers start / pause / resume / stop / status, error semantics, and idempotency.
- [ ] Schema round-trips through the §13.2 snapshot gate.
- [ ] Tests pass; typecheck passes; lint passes.

### US-096: `@lando/file-sync-mutagen` plugin Live Layer

**Description:** As a user on a slow-bind-mount provider, the bundled `@lando/file-sync-mutagen` plugin provides a `FileSyncEngine` Live Layer that drives the Mutagen host CLI against the planned app-root mount.

**Acceptance Criteria:**
- [ ] Plugin `Layer` declared in `plugins/file-sync-mutagen/src/index.ts`, registered in `BUNDLED_PLUGINS`, contributed to bundled.ts codegen.
- [ ] Fake-client unit tests cover create / pause / resume / terminate session and status polling.
- [ ] Mutagen sessions named by `${appId}-${serviceId}-${mountId}`; session names are deterministic.
- [ ] Tests pass; typecheck passes; lint passes.

### US-097: Mutagen host CLI + agent download via `lando setup`

**Description:** As a user, `lando setup` downloads the platform-appropriate Mutagen host CLI plus the per-target agent and stores them under the user data root.

**Acceptance Criteria:**
- [ ] Download manifest pinned per §17.9 (host + agent variants); SHA-256 verified per §5.8.1 semantics.
- [ ] Failure modes (network, checksum mismatch) reported with tagged remediation.
- [ ] Re-runs are idempotent (existing valid binaries reused).
- [ ] `lando doctor` reports the resolved Mutagen version per platform.
- [ ] Tests pass; typecheck passes; lint passes.

### US-098: planner auto-selects file sync for slow-bind-mount providers

**Description:** As a user, I do not configure file sync — the planner auto-selects `@lando/file-sync-mutagen` when the selected provider declares `bindMountPerformance: "slow"`, and skips file sync otherwise.

**Acceptance Criteria:**
- [ ] `AppPlanner` consults `ProviderCapabilities.bindMountPerformance`; produces a `FileSyncPlan` per slow service mount.
- [ ] `BuildOrchestrator` starts file sync after the provider applies and before `post-app-start` lifecycle event publishes.
- [ ] Scenario test on Linux x64 (with a fake "slow" provider) verifies that `FileSyncPlan` is included and that `lando stop` terminates the sync session.
- [ ] Tests pass; typecheck passes; lint passes.

### US-099: excludes patterns (volume-shadow + Mutagen ignores)

**Description:** As a user, `excludes:` patterns from §6 are honored by file sync — node_modules, vendor, etc. — using both the existing volume-shadow approach (Alpha) and Mutagen ignore rules.

**Acceptance Criteria:**
- [ ] `excludes:` patterns translated into Mutagen ignore rules in addition to the volume-shadow strategy.
- [ ] Defaults include `node_modules`, `vendor`, `.git`, `tmp`, and any framework-aware presets contributed by service types.
- [ ] Scenario test confirms excluded paths are not synced (new file in excluded dir does not propagate to the container).
- [ ] Tests pass; typecheck passes; lint passes.

### US-100: file-sync engine contract suite passes

**Description:** As a maintainer, the `FileSyncEngine` contract suite is green against `@lando/file-sync-mutagen` on macOS arm64, macOS x64, and Windows x64.

**Acceptance Criteria:**
- [ ] Contract-suite runner from US-095 wired against the Mutagen Live Layer.
- [ ] Live tests gated behind `LANDO_TEST_FILE_SYNC_LIVE=1` and skipped without a real provider socket + Mutagen binary.
- [ ] Nightly CI matrix exercises the suite on all slow-provider platforms.
- [ ] Tests pass; typecheck passes; lint passes.

## Functional Requirements

- FR-1: `@lando/file-sync-mutagen` is a bundled plugin (no opt-in for slow providers).
- FR-2: Mutagen host CLI + agent are downloaded by `lando setup` and stored under the user data root; never embedded in the compiled binary.
- FR-3: Planner auto-selects file sync iff `bindMountPerformance: "slow"`.
- FR-4: `excludes:` patterns are honored via volume-shadow AND Mutagen ignore rules.
- FR-5: `FileSyncEngine` contract is stable in `@lando/sdk` from Beta onward.
- FR-6: `lando doctor` reports Mutagen version, session count, and any drift state.

## Non-Goals

- TCP/UDP forwarding via the Mutagen daemon (post-4.0 — §14.2 deferral, future `PortForwardingService`).
- Hot-reload from fork-mode scratch source (post-4.0).
- File-sync engines other than Mutagen (RC may add `none` for tests; community engines post-GA).
- User-facing Mutagen tuning knobs beyond `excludes:` (defaults only in Beta).

## Technical Considerations

- Mutagen agent installation into containers happens lazily on first session start; cache the agent binary in a per-app volume to avoid re-injection.
- Mutagen session names need to fit Mutagen's identifier rules (kebab-case, length-bounded); the deterministic naming function lives in `@lando/file-sync-mutagen`.
- The §17.9 binary acceptance criteria enforce that the compiled binary does not contain Mutagen — the import-boundary test in PRD-11 / PRD-13 has a Mutagen-specific assertion.
- File-sync state lives under the per-app cache scope (`scope: app`) per §12.

## Success Metrics

- Cold `lando start` on macOS arm64 against `provider-lando` is at least 5× faster on `vendor` reads compared with raw bind-mount.
- Zero user-visible config knobs for file sync in the default path; `excludes:` is the only one users touch.
- Mutagen drift events surface in `lando doctor` and as `task.detail` lines in the renderer (PRD-09).

## Guide Coverage

Per [PRD-12 US-198](./prd-beta-12-executable-guides-beta.md) (`## Guide Coverage` convention) and [US-199](./prd-beta-12-executable-guides-beta.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-097 | Mutagen host CLI + agent download via `lando setup` | `docs/guides/setup/file-sync-mutagen.mdx` | Required at story acceptance |
| US-099 | exclude patterns (volume-shadow + Mutagen ignores) | `docs/guides/setup/file-sync-excludes.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `plugins/file-sync-mutagen/**`
- `sdk/src/file-sync/**`
- `core/src/cli/commands/meta/setup.ts`

## Open Questions

- Should `lando setup` allow `--file-sync=none` to disable file sync entirely on slow providers (for debugging)? Default: yes, with a `meta:doctor` warning.
- Should we keep an in-tree `@lando/file-sync-none` no-op engine to make the contract suite easier to write? Default: no — `TestFileSyncEngine` in `@lando/core/testing` covers that use case.
