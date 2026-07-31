# PRD: ARCH-03 — Package seams over architecture-by-lint

## Introduction

Promote the most important ownership boundaries from AST lint rules into real private workspace packages enforced by `check:package-dag`. Public `@lando/core` remains one publishable package (§2.7). This wave extracts `@lando/state-store` (modeled on `@lando/paths`) and thins redundant boundary rules for paths/probe/redaction/renderer where package edges already carry the constraint.

## Source References

- `spec/02-toolchain.md` §2.7
- `spec/04-pluggability.md` §4.2
- `spec/12-caches-and-persistence.md` §12.7
- `spec/13-testing-and-distribution.md` §13.8
- `paths/` package as the reference pattern

## Goals

- Private internal packages are an approved architecture tool.
- StateStore lives in `@lando/state-store`.
- Package DAG is primary for seam ownership; AST rules keep residual behavioral bans (`console.*`, hand-rolled retry, etc.).

## User Stories

### US-516: Scaffold @lando/state-store workspace package

**Description:** As a maintainer, StateStore moves behind a private @lando/state-store package modeled on @lando/paths.

**Acceptance Criteria:**
- [ ] Workspace package exists; core depends on it; plugins may depend on it; plugins still cannot depend on @lando/core.
- [ ] Public types that must stay stable remain on sdk or documented core re-exports.
- [ ] Tests pass; typecheck passes; lint passes

### US-517: package-dag allowlists private seam packages

**Description:** As CI, check:package-dag knows paths, state-store, and sdk seams; still forbids plugins→core.

**Acceptance Criteria:**
- [ ] package-dag rule updated and tested.
- [ ] Tests pass; typecheck passes; lint passes

### US-518: Migrate core/plugins imports to @lando/state-store

**Description:** As a maintainer, no deep imports into the old core/src/state ownership path remain outside the package.

**Acceptance Criteria:**
- [ ] Import graph uses @lando/state-store.
- [ ] Focused tests for lock/atomic write still green.
- [ ] Tests pass; typecheck passes; lint passes

### US-519: Retire or thin check:state-store-boundary

**Description:** As a maintainer, package edges carry seam ownership; AST rule is removed or reduced to residual forbidden patterns.

**Acceptance Criteria:**
- [ ] Boundary rule inventory documents keep vs thin vs delete.
- [ ] check:state-store-boundary either deleted with alias note or thinned.
- [ ] Tests pass; typecheck passes; lint passes

### US-520: Thin paths/probe/redaction/renderer rules to import seams

**Description:** As a maintainer, where a package already owns the API, duplicate architecture-by-lint is thinned to import-edge checks.

**Acceptance Criteria:**
- [ ] paths, probe, redaction, renderer rules reviewed; behavioral bans (console.*, hand-rolled retry) kept.
- [ ] Tests pass; typecheck passes; lint passes

### US-521: ROADMAP defer list for further extractions

**Description:** As a planner, network/managed-file and further god-package splits are explicitly deferred post-wave.

**Acceptance Criteria:**
- [ ] ROADMAP or PRD-03 Non-Goals lists deferred extractions.
- [ ] Tests pass; typecheck passes; lint passes

## Functional Requirements

- Plugins may depend on private seam packages + sdk; never `@lando/core`.
- Core may re-export seam entry points for embedding stability when required.

## Non-Goals

- Public runtime vs CLI package split.
- Extracting network, managed-file, data-mover, or planner packages in this wave.
- Deleting the boundary substrate engine.

## Technical Considerations

- Follow `@lando/paths` Effect-free vs Effect service split where applicable.
- Layer wiring may need bootstrap generator updates when StateStore moves.

## Success Metrics

- State ownership enforceable via package.json + package-dag.
- Measurable reduction in state-store AST rule complexity.

## Guide Coverage

**None — internal/infra PRD.** This wave changes maintainer/CI architecture only; no new end-user CLI feature requires an executable guide.

## Open Questions

- None blocking.
