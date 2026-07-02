# PRD: BETA1-01 — Durability & probe-consumer remediation

## Introduction

Two Alpha 4 foundational PRDs shipped their contracts but not their consumers. PRD-ALPHA4-13 published the `StateStore` durable-write primitive and PRD-ALPHA4-14 published the `@lando/sdk/probe` retry/verdict primitive — both with acceptance criteria that named the concrete migration targets. The 2026-07-02 gap audit found:

1. **No write path fsyncs.** `writeFileAtomicScoped` (`core/src/state-store/atomic.ts`) and `writeFileAtomicViaRename` (`core/src/cache/atomic.ts`) do temp + rename only. PRD-ALPHA4-13 FR-3: "Every `set`/`update` MUST be atomic (temp + fsync + rename); a crash MUST never leave a partially written live file." A crash between rename and page-cache flush can still surface a zero-length or partially written live file on some filesystems.
2. **Two durable stores.** `core/src/state-store/json-bucket.ts` still carries its own versioned-envelope + advisory-lock + quarantine implementation, and `core/src/managed-file/service.ts` uses it for the managed-file ledger. PRD-ALPHA4-13's success metric is exactly one durable-store implementation under `core/src/state/`.
3. **Zero `runProbe` consumers.** PRD-ALPHA4-14 US-317 requires the default `HealthcheckRunner`, the default `UrlScanner`, `DoctorService` shell checks, the `Downloader` retry path, and `lando setup` readiness waits to consume `runProbe`. There are no `runProbe` call sites in `core/src`; `core/src/subsystems/healthcheck/api.ts` and `core/src/subsystems/scanner/api.ts` are "Unavailable" stubs, and `lando doctor` wires `HealthcheckRunnerUnavailableLive` / `UrlScannerUnavailableLive` (`core/src/cli/commands/doctor-subsystems.ts`).
4. **Test-surface hole.** `@lando/core/testing`'s `waitForEvent` is asserted only as an exported function; no runtime test proves it delegates to `EventService.waitFor` and honors the timeout contract (PRD-ALPHA4-14 FR-9).
5. **Working-tree residue.** `plugins/file-sync-mutagen/src/download.ts` and `plugins/file-sync-mutagen/test/download.test.ts` are untracked, referenced only by each other, superseded by the shipped `provisionMutagen` path in `plugins/file-sync-mutagen/src/provision.ts`, and have already blocked one push.

This PRD closes all five. It adds no new public surface beyond what PRD-ALPHA4-13/-14 already specified.

## Source References

- [`spec/alpha-4/prd-alpha-4-13-paths-and-state-store.md`](../alpha-4/prd-alpha-4-13-paths-and-state-store.md) FR-1, FR-3, success metrics.
- [`spec/alpha-4/prd-alpha-4-14-probe-events-contract-kit.md`](../alpha-4/prd-alpha-4-14-probe-events-contract-kit.md) US-316..US-317, FR-9.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.5 / §10.5.1 healthcheck, scanner, and probe behaviors.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) durable-write and cache-persistence requirements.
- [`spec/03-architecture.md`](../03-architecture.md) §3.7 consumer-owned redaction of `ProbeResult.lastError`; §11.1 `EventService.waitFor`.
- Root [`AGENTS.md`](../../AGENTS.md) StateStore boundary, probe boundary, and working-tree discipline.

## Goals

- Make every durable/atomic write path crash-safe with an fsync before rename (file) and, where cheaply possible, on the containing directory.
- Collapse `json-bucket.ts` into `StateStore` so exactly one durable-store implementation ships, and update the `check:state-store-boundary` allowlist accordingly.
- Ship real `runProbe`-backed built-ins for `HealthcheckRunner` and `UrlScanner`, and migrate doctor shell checks, the downloader retry path, and setup readiness waits onto `runProbe`.
- Extend `check:probe-boundary` so a regression back to hand-rolled loops in the migrated consumers fails CI.
- Close the `waitForEvent` runtime-test hole.
- Resolve the orphaned Mutagen downloader files.

## User Stories

### US-372: Durable atomic writes fsync before rename

**Description:** As a user whose machine loses power mid-write, no Lando-owned durable file (state store, cache, cwd-app map) is ever left partially written, because every atomic write path flushes to disk before the rename.

**Acceptance Criteria:**

- [ ] `writeFileAtomicScoped` (`core/src/state-store/atomic.ts`) fsyncs the temp file before rename; the rename only happens after a successful flush.
- [ ] `writeFileAtomicViaRename` (`core/src/cache/atomic.ts`) gains the same fsync-before-rename behavior.
- [ ] `core/src/cache/cwd-app-map.ts` no longer writes with raw `writeFile`; it routes through the atomic helper.
- [ ] A unit test proves the temp file is flushed before rename (e.g. by asserting the helper's syscall ordering through an injected fs seam or by verifying the helper rejects when the flush fails).
- [ ] `check:state-store-boundary` still passes; no new hand-rolled temp+rename paths are introduced.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-373: One durable-store implementation — retire `json-bucket.ts`

**Description:** As a maintainer, all durable, versioned, lockable Lando-owned writes flow through `StateStore`, so envelope/lock/quarantine semantics exist in exactly one place.

**Acceptance Criteria:**

- [ ] The managed-file ledger (`core/src/managed-file/service.ts`) persists through `StateStore` (or a `StateStore`-backed bucket adapter) instead of `openJsonBucket`.
- [ ] `core/src/state-store/json-bucket.ts`'s independent versioned-envelope + advisory-lock + quarantine implementation is removed or reduced to a thin delegating shim over `core/src/state/**` with no duplicated envelope/lock logic.
- [ ] Existing ledger data written by the old bucket format is still readable (migration or format-compatibility test), or the PRD-ALPHA4-18 ledger format is explicitly versioned forward with a documented migration.
- [ ] The `check:state-store-boundary` allowlist entry for `core/src/state-store/json-bucket.ts` is removed or narrowed to the shim.
- [ ] The advisory-lock retry loops allowlisted in `check:probe-boundary` are re-audited; entries that no longer exist are removed.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-374: Ship the `runProbe`-backed default `HealthcheckRunner`

**Description:** As a service author, healthchecks declared in a Landofile run through a real `HealthcheckRunner` built on `runProbe`, with `retry`/`delay`/`timeout` mapped onto a `RetryPolicy` and verdicts mapped onto `ProbeOutcome`.

**Acceptance Criteria:**

- [ ] A live `HealthcheckRunner` implementation replaces `HealthcheckRunnerUnavailableLive` as the default wiring; the stub remains only as an explicit test/degraded-mode layer if still needed.
- [ ] The implementation builds on `@lando/sdk/probe`'s `runProbe` — no hand-rolled `Effect.retry`/`Schedule` loop — and passes `check:probe-boundary`.
- [ ] Healthcheck `retry`, `delay`, and `timeout` config map onto `RetryPolicy` fields per §10.5; the runner's verdict maps onto `ProbeOutcome` (green/yellow/red).
- [ ] `ProbeResult.lastError` is redacted through `RedactionService` before it reaches any event, transcript, or readiness summary.
- [ ] Behavior is asserted deterministically under `TestClock` (attempt counts, backoff, timeout) with no wall-clock flake.
- [ ] `lando doctor` (see US-376) reports the real runner, not the unavailable stub.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-375: Ship the `runProbe`-backed default `UrlScanner`

**Description:** As a user running `lando start`, URL scanning ("is this route responding yet?") runs through a real `UrlScanner` built on `runProbe`.

**Acceptance Criteria:**

- [ ] A live `UrlScanner` implementation replaces `UrlScannerUnavailableLive` as the default wiring.
- [ ] The implementation builds on `runProbe`, maps scanner config onto `RetryPolicy`, and returns `ProbeOutcome`-shaped verdicts per §10.5.
- [ ] Outbound requests go through the `HttpClient` egress chokepoint (no ad-hoc `fetch`), honoring `network.proxy` / `network.ca`.
- [ ] `ProbeResult.lastError` is redacted through `RedactionService` before leaving the scanner.
- [ ] Deterministic `TestClock` coverage for attempts/backoff/timeout.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-376: Migrate doctor, downloader, and setup readiness onto `runProbe`

**Description:** As a maintainer, the remaining PRD-ALPHA4-14 US-317 consumers — `DoctorService` shell checks, the `Downloader` retry path, and `lando setup` readiness waits — run their retry/timeout-to-verdict loops through `runProbe`, and `lando doctor` wires the real subsystems from US-374/US-375.

**Acceptance Criteria:**

- [ ] `DoctorService` shell checks with retry/timeout semantics run through `runProbe`.
- [ ] The `Downloader` retry path maps its retry policy onto `RetryPolicy` and executes attempts through `runProbe` (or documents, in the probe-boundary allowlist with justification, any loop that genuinely cannot map).
- [ ] `lando setup` readiness waits (socket probe, provider readiness) consume `runProbe`.
- [ ] `core/src/cli/commands/doctor-subsystems.ts` wires the real `HealthcheckRunner`/`UrlScanner` layers; the "Unavailable" stubs no longer appear in any default bootstrap path.
- [ ] `check:probe-boundary` allowlist shrinks to only the documented state-lock loops; a hand-rolled retry loop reintroduced in any migrated consumer fails the gate.
- [ ] Existing setup/doctor/downloader behavior tests stay green; migrated behavior is asserted under `TestClock` where timing-sensitive.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-377: Runtime behavior test for `waitForEvent`

**Description:** As a plugin author relying on `@lando/core/testing`, `waitForEvent` is proven at runtime to delegate to `EventService.waitFor` and honor the timeout contract, not just to exist as an export.

**Acceptance Criteria:**

- [ ] A runtime test in `core/test/testing/` proves `waitForEvent` resolves when a matching event is published.
- [ ] A runtime test proves `waitForEvent` fails with the `EventError` `reason: "timeout"` contract when the deadline elapses, driven deterministically through `TestClock`.
- [ ] The test asserts the returned event is the typed, redacted payload (parity with `EventService.waitFor` semantics).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-378: Resolve the orphaned Mutagen downloader files

**Description:** As a maintainer, the working tree carries no orphaned product files: the untracked `plugins/file-sync-mutagen/src/download.ts` and `plugins/file-sync-mutagen/test/download.test.ts` are either deleted (the shipped path is `provisionMutagen` in `plugins/file-sync-mutagen/src/provision.ts`) or deliberately wired and committed.

**Acceptance Criteria:**

- [ ] A decision is recorded (in this story's notes): the bespoke downloader is redundant with the tool-provisioning path, or it serves a purpose `provision.ts` does not.
- [ ] If redundant: both files are deleted; no production or test code references them.
- [ ] If kept: `download.ts` is imported by the plugin's production path, its test runs in CI, and both files are committed.
- [ ] `git status` is clean of these paths after the change (no untracked product files).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1:** All durable/atomic write helpers flush file contents to disk before the atomic rename; failures to flush abort the write with a tagged error.
- **FR-2:** Exactly one durable-store implementation (envelope + lock + quarantine) exists under `core/src/state/**`; all consumers, including the managed-file ledger, route through it.
- **FR-3:** Every host/provider-shaped retry/backoff/timeout-to-verdict loop in `core/src/**` and `plugins/**` builds on `runProbe`; the boundary-gate allowlist contains only the documented state-lock loops.
- **FR-4:** The default bootstrap wires real healthcheck/scanner implementations; "Unavailable" layers appear only in explicit degraded/test wiring.
- **FR-5:** `ProbeResult.lastError` never reaches an event, transcript, or summary unredacted.

## Non-Goals

- No changes to the `@lando/sdk/probe` public surface (schemas, helpers) — it shipped correctly in Alpha 4.
- No new healthcheck/scanner Landofile syntax; only the runtime implementations behind the existing contracts.
- No StateStore API changes; only consumer unification and fsync semantics.

## Technical Considerations

- Bun exposes `fsync` via `node:fs` (`fsyncSync` / `FileHandle.sync()`); the helper should flush the temp file handle before rename. Directory-level fsync is best-effort on platforms where opening a directory for sync is unsupported (Windows) — document the platform behavior in the helper.
- The json-bucket retirement interacts with the managed-file ledger format from PRD-ALPHA4-18; prefer keeping the on-disk JSON envelope byte-compatible and swapping only the write/lock machinery, so no data migration is needed.
- `UrlScanner` must go through `HttpClientLive` to inherit trust, proxy, redaction, and offline fail-fast semantics from PRD-ALPHA4-09/US-331.
- Migrating the downloader retry path must not regress the checksum/verification semantics; `runProbe` wraps the attempt, it does not replace verification.

## Success Metrics

- `grep -r "runProbe(" core/src` returns call sites in healthcheck, scanner, doctor, downloader, and setup readiness paths.
- Exactly one durable-store implementation under `core/src/state/**`; `check:state-store-boundary` allowlist has no json-bucket entry.
- A kill-during-write crash test (or syscall-order unit test) demonstrates no partially written live file.
- `git status --short` shows no untracked product files.

## Guide Coverage

**None — internal/infra PRD.**

This PRD completes runtime plumbing behind already-guided surfaces (`lando doctor`, `lando setup`). Existing guides remain owned by their Alpha 4 PRDs; if doctor output changes observably, the doctor walkthrough guide must be re-run through the guide drift gate.

## Open Questions

- Should directory fsync be required on POSIX (stronger crash safety) or best-effort everywhere (simpler, matches Bun portability)? Default assumption: file fsync required, directory fsync best-effort.
- Does any external tooling read the managed-file ledger's current bucket layout directly? Assumed no (substrate-only per PRD-ALPHA4-18).
