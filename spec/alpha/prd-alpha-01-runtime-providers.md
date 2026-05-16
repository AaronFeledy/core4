# PRD: ALPHA-01 — Runtime providers

## Introduction

This PRD covers Phase 2 Alpha work for **Runtime providers**. It translates the Alpha section of [`spec/ROADMAP.md`](../ROADMAP.md) into implementation-sized stories while preserving the MVP rule that the detailed spec parts remain source of truth.

Depends on: **—**.


## Source References

- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) — RuntimeProvider contract and managed/runtime provider behavior.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) — `meta:setup`, `meta:doctor`, command behavior.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) — persisted provider/cache state rules.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) — `lando setup` install-dir resolution and `shellenv` parity in the compiled binary (§17.1 stage 7).

## Goals

- Make provider-lando usable as the default managed runtime on Linux and macOS.
- Make provider-docker a feature-complete alternative path for Linux and macOS.
- Persist enough provider state for lifecycle commands to work across fresh CLI processes.
- Expose provider diagnostics useful to alpha testers.

## User Stories

### US-001: Automate provider-lando setup on Linux

**Description:** As a Linux alpha tester, I can run `lando setup` and get the managed runtime bundle downloaded, verified, and recorded without manually wiring sockets.

**Acceptance Criteria:**
- [ ] Failing test covers `meta:setup` invoking provider-lando setup with a fake bundle downloader and fake Podman API client
- [ ] Checksum verification follows §5.8.1 and fails closed with a tagged remediation error
- [ ] Setup stores provider state in the configured cache/state directory, not process memory
- [ ] Compiled `$bunfs` path and source OCLIF path produce equivalent setup output
- [ ] `lando setup` and `lando shellenv` derive `LANDO_INSTALL_DIR` from `process.execPath` in the compiled binary per §17.1 stage 7; tests assert agreement between the two commands
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-002: Add provider-lando macOS machine lifecycle

**Description:** As a macOS alpha tester, I can create/start/stop/teardown the managed Podman machine through provider-lando.

**Acceptance Criteria:**
- [ ] Fake-client unit tests cover create, start, stop, upgrade, and teardown transitions
- [ ] ProviderCapabilities declares macOS support with `bindMountPerformance: "slow"`
- [ ] `lando setup` reports actionable remediation when host virtualization prerequisites are missing
- [ ] Live test is gated behind an explicit macOS provider env var and skipped by default
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-003: Complete provider-lando capability matrix

**Description:** As the planner, I can choose provider-lando based on a complete capability matrix instead of MVP assumptions.

**Acceptance Criteria:**
- [ ] Schema test asserts every Alpha capability field has a provider-lando value for Linux and macOS
- [ ] Planner rejects unsupported Alpha features with a tagged error before apply
- [ ] Capability output is surfaced by `meta:doctor` diagnostics: every `ProviderCapabilities` field from §5.4 appears in the selected-provider check, and missing-capability failures include service, feature, capability, provider id, and suggested fix per §5.4
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-004: Make provider-docker feature-complete on Linux and macOS

**Description:** As a user with Docker Desktop or system Docker, I can use provider-docker as an Alpha alternative path.

**Acceptance Criteria:**
- [ ] Docker Engine HTTP API fake-client tests cover apply, inspect, exec, logs, and destroy
- [ ] Linux socket and macOS Docker Desktop paths are supported through config/env discovery
- [ ] Provider declares `bindMountPerformance: "slow"` for Docker Desktop or VM-mediated paths and `"native"` for Linux native Docker sockets per §5.4
- [ ] Live Docker tests are gated by `LANDO_TEST_DOCKER_SOCKET` or `DOCKER_HOST`
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-005: Persist cross-process provider state needed for lifecycle commands

**Description:** As a user, I can run `start`, `info`, `stop`, and `destroy` from separate CLI processes without relying on in-memory provider caches.

**Acceptance Criteria:**
- [ ] Scenario test starts an app, launches a fresh runtime, then runs info/stop/destroy using persisted plan/state
- [ ] Destroy receives the planned `AppPlan` and preserves app-scoped volumes unless explicitly requested
- [ ] Provider-specific transient state is stored under the provider state directory with cache encoding rules from §12.2
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-006: Harden provider cleanup and failure recovery

**Description:** As an alpha tester, failed start/stop operations leave containers, networks, and volumes in documented states.

**Acceptance Criteria:**
- [ ] Fake provider tests cover partial apply failure after network creation and after one service start
- [ ] Cleanup removes app-scoped containers/networks and preserves volumes by default
- [ ] Errors include remediation plus `providerId`, operation name, redacted details, and original cause fields required by §5.7 so manual cleanup identifies the affected provider operation
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-007: Expose provider diagnostics in `meta:doctor`

**Description:** As a tester filing bugs, I can run `lando doctor` and include provider/runtime diagnostics.

**Acceptance Criteria:**
- [ ] `meta:doctor` reports selected provider, version, socket/machine status, the §5.4 capability summary, and §10.9 solution records with `automatic` or `manual` remediation
- [ ] Doctor never requires app bootstrap unless app-specific diagnostics are requested
- [ ] JSON renderer output is covered by the named snapshot fixture `meta-doctor.provider-status.ndjson`, asserting event order, provider fields, capability fields, severity, context, and solution records per §10.9
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-008: Keep provider contract suite authoritative

**Description:** As a provider author, I can run one contract suite against TestRuntimeProvider, provider-lando, and provider-docker.

**Acceptance Criteria:**
- [ ] `@lando/sdk/test` exposes the provider contract suite drafted in MVP with Alpha lifecycle coverage
- [ ] TestRuntimeProvider and provider-docker pass in default CI
- [ ] provider-lando live cases remain env-gated where host runtime is required
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- Implement only the Phase 2 Alpha surface assigned to this PRD.
- Preserve all accepted MVP behavior and regression coverage.
- Match existing Bun workspace conventions: `bun run typecheck`, `bun run lint`, `bun test`, and generated-file updates through `bun run codegen` where applicable.
- Source CLI behavior and compiled binary behavior must stay aligned for user-visible commands touched by this PRD.

## Non-Goals

- Do not implement features listed in the Alpha index cross-cutting non-goals.
- Do not stabilize non-SDK library APIs beyond the `unstable`/dev-channel promise.
- Do not add new external dependencies unless the relevant spec part already requires them or a separate architecture decision approves them.

## Technical Considerations

- Use the spec part referenced by each story as the source of truth when details conflict with this PRD.
- Prefer fake-client/unit coverage for provider and CLI behavior; live runtime tests must be env-gated.
- Keep tagged errors and remediation text consistent across source OCLIF and compiled `$bunfs` paths.
- Avoid broad refactors while implementing a story; each story should be reviewable independently.

## Success Metrics

- Every user story in this PRD is accepted with its tests merged.
- `bun run typecheck`, `bun run lint`, and `bun test` pass for the whole workspace.
- Alpha roadmap exit criteria remain achievable without adding unplanned Beta/RC scope.

## Open Questions

- None blocking; resolve story-level ambiguities by updating this PRD and the authoritative spec part together.
