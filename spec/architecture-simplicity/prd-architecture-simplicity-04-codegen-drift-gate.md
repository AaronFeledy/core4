# PRD: ARCH-04 — Single codegen drift gate

## Introduction

Make `bun run codegen:check` the **one pure-drift gate**: run the full generator catalog, then fail if catalog outputs differ from the expected tree state (`git diff --exit-code` on catalog paths). Today `codegen:check` is effectively codegen + deprecations + typecheck and does not assert drift. Keep semantic gates separate.

## Source References

- `spec/15-binary-build-and-release.md` §17.2
- `spec/13-testing-and-distribution.md` §13.2, §13.4
- root `package.json` scripts

## Goals

- One command catches generated drift.
- Retire redundant per-domain regen-and-compare implementations.
- Document semantic-vs-drift matrix for agents.

## User Stories

### US-505: Strengthen codegen:check to assert zero drift

**Description:** As CI, bun run codegen:check regenerates the full catalog and fails if any catalog output path is dirty vs git.

**Acceptance Criteria:**
- [ ] package.json codegen:check runs full codegen then fails on git diff for catalog outputs (documented path set).
- [ ] Non-catalog dirty files do not false-fail the drift half (or are documented as require-clean-tree).
- [ ] Unit/script test covers dirty-generated detection.
- [ ] Tests pass; typecheck passes; lint passes

### US-506: Inventory generators into single catalog ownership

**Description:** As a maintainer, scripts/codegen.ts order and §17.2 table name the same generators with no orphan drift checkers.

**Acceptance Criteria:**
- [ ] §17.2 table matches scripts/codegen.ts dependency order.
- [ ] Every generator has exactly one ownership row (committed pin vs untracked derived).
- [ ] Tests pass; typecheck passes; lint passes

### US-507: Retire redundant per-domain regen-and-compare scripts

**Description:** As a maintainer, duplicate regenerate-and-compare checkers are removed or become thin aliases of codegen:check.

**Acceptance Criteria:**
- [ ] No second full-catalog drift implementation remains under scripts/check-*.ts beyond documented aliases.
- [ ] Public script names kept only if referenced by CI/docs, implemented as wrappers.
- [ ] Tests pass; typecheck passes; lint passes

### US-508: CI: one drift job

**Description:** As CI, static-checks invoke the strengthened codegen:check once per PR matrix entry that needs it.

**Acceptance Criteria:**
- [ ] Generated CI workflow calls codegen:check once for drift; no parallel duplicate full regen jobs for the same catalog.
- [ ] codegen:ci workflows regenerated via existing generator.
- [ ] Tests pass; typecheck passes; lint passes

### US-509: Document semantic-vs-drift gate matrix

**Description:** As an agent, AGENTS.md and §13.4 list which gates are pure drift vs semantic correctness.

**Acceptance Criteria:**
- [ ] Root AGENTS.md matrix: codegen:check = drift; guide-coverage, schema-compatibility, public-transcripts, package-dag, behavioral boundaries = semantic.
- [ ] Tests pass; typecheck passes; lint passes

## Functional Requirements

- Deterministic codegen (byte-identical on identical inputs) remains mandatory.
- `check:schema-compatibility` stays semantic and runs on regenerated working-tree artifacts.

## Non-Goals

- Folding guide-coverage matrix checks into git diff.
- Removing boundary gates.

## Technical Considerations

- Untracked derived outputs: drift check may compare against empty index + ignore rules, or require codegen into a temp tree and diff to working tree — pick one implementation in US-505 and document it.
- Existing unrelated dirty working trees must not make local codegen:check unusable without a documented escape.

## Success Metrics

- One CI job name for pure generated drift.
- Fewer `check:*` scripts that only wrap regenerate+diff.

## Guide Coverage

**None — internal/infra PRD.** This wave changes maintainer/CI architecture only; no new end-user CLI feature requires an executable guide.

## Open Questions

- Exact ignore strategy for non-catalog dirt during local runs (document in US-505).
