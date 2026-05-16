# PRD: ALPHA-06 — Persistent caches and library API

## Introduction

This PRD covers Phase 2 Alpha work for **Persistent caches and library API**. It translates the Alpha section of [`spec/ROADMAP.md`](../ROADMAP.md) into implementation-sized stories while preserving the MVP rule that the detailed spec parts remain source of truth.

Depends on: **PRD-01, PRD-02, PRD-03**.


## Source References

- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) — cache catalog and encoding.
- [`spec/09-embedding.md`](../09-embedding.md) — embedding/library API surface.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) — testing layers and library API verification.

## Goals

- Move MVP in-memory/cache assumptions to persistent Alpha caches.
- Make the internal library API usable for app bootstrap and testing.
- Protect MVP SDK shapes from accidental breaking changes.

## User Stories

### US-041: Implement persistent cwd-app-map cache

**Description:** As the CLI, I can resolve known apps across processes using a durable cwd-app map.

**Acceptance Criteria:**
- [ ] CacheService tests cover write/read/delete/list for cwd-app-map entries
- [ ] Cache encoding follows §12.2 and handles corrupt entries with remediation
- [ ] `apps:list` consumes the persistent cache
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-042: Implement persistent app plan cache

**Description:** As the planner, I can reuse app plans across CLI invocations when inputs have not changed.

**Acceptance Criteria:**
- [ ] Plan cache tests cover key derivation from Landofile/config/plugin/service inputs
- [ ] Changing relevant input invalidates the cached plan
- [ ] Cache writes use true write-temp-then-rename semantics per §12; if Bun cannot provide that directly, implementation must use an approved rename adapter or record an explicit architecture decision before this story is accepted
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-043: Implement plugin command index cache

**Description:** As command bootstrap, I can avoid recomputing plugin/tooling command indexes unnecessarily.

**Acceptance Criteria:**
- [ ] Cache tests cover plugin command index serialization/deserialization
- [ ] Command registry invalidates cache when plugin manifests or Landofile tooling change
- [ ] Cache is safe for missing bundled plugins and reports tagged errors
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-044: Make binary cache encoding rules testable

**Description:** As a maintainer, all Alpha caches use one encoding policy and compatibility checks.

**Acceptance Criteria:**
- [ ] Shared tests validate version byte/header/schema version for each binary cache type from §12.2
- [ ] Old/unknown cache versions are ignored or migrated according to documented policy
- [ ] Cache test fixtures live in repo and are updated intentionally
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-045: Make `makeLandoRuntime` work for `bootstrap: "app"`

**Description:** As an embedding host, I can construct a runtime through app bootstrap without invoking the CLI.

**Acceptance Criteria:**
- [ ] Library API tests call `makeLandoRuntime({ bootstrap: "app" })` and run a simple app operation with TestRuntimeProvider
- [ ] Smaller bootstrap levels continue to work
- [ ] Public library API remains marked unstable/dev-channel only
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-046: Publish `@lando/core/testing` with TestRuntimeProvider

**Description:** As plugin/core tests, I can use a stable test provider layer instead of ad hoc fakes.

**Acceptance Criteria:**
- [ ] Package export tests assert `@lando/core/testing` resolves in workspace and built package
- [ ] TestRuntimeProvider passes provider contract suite for Alpha features it claims
- [ ] Docs/example test demonstrate provider injection
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-047: Expose `@lando/core/cli` command invocation API

**Description:** As an embedding host, I can invoke CLI commands programmatically for the Alpha-supported surface.

**Acceptance Criteria:**
- [ ] Library API test invokes a supported command through `@lando/core/cli` without spawning a process
- [ ] Errors/renderer output are returned in a host-consumable shape
- [ ] API is documented as unstable and not semver-stable until later phase
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-048: Keep SDK additions backward-compatible

**Description:** As SDK consumers, Alpha can add schemas/tags but cannot mutate MVP shapes.

**Acceptance Criteria:**
- [ ] Snapshot tests compare MVP-exported schema names/tag method signatures against a frozen list
- [ ] New Alpha additions are additive and documented
- [ ] Breaking changes require explicit roadmap/spec update, not silent PRD drift
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
