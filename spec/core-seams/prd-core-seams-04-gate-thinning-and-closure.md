# PRD: SEAMS-04 — Gate thinning and closure

## Introduction

With the Landofile and engine seams behind real package edges, most of what the behavioral scanner suite polices is either carried by `check:package-dag` or has shrunk to a genuinely behavioral residue. This PRD runs the keep/thin/delete inventory across every boundary rule, retires the halves that package edges now own, sets the bar that future gates must clear before being written as scanners, and closes the wave against the index verification contract. The target state is the root policy sentence made true in practice: package seams first, AST second.

## Source References

- `spec/13-testing-and-distribution.md` §13.4 (PR merge requirements), §13.8 (package-dag primacy)
- `spec/core-seams/prd-core-seams-00-index.md` (verification contract)
- `spec/architecture-simplicity/prd-architecture-simplicity-03-package-seams.md` US-519/US-520 (the first thinning pass this one completes)
- `scripts/boundary/` (rule substrate)

## Goals

- Every surviving `check:*` scanner has a written justification for why a package seam cannot carry it.
- Rules whose seam-ownership half is now structural are thinned to their behavioral residue or deleted.
- A documented bar prevents the scanner suite from regrowing.

## User Stories

### US-545: Boundary-rule inventory v2

**Description:** As a maintainer, every registered boundary rule is classified keep/thin/delete against the post-seam workspace, with the classification recorded where the rules live.

**Acceptance Criteria:**

- [ ] An inventory document (or structured header per rule under `scripts/boundary/rules/`) records for each rule: what it bans, which package edge (if any) now carries the ownership half, and the keep/thin/delete verdict with one-line justification.
- [ ] Behavioral bans that survive regardless of seams are explicitly marked (`console.*`/renderer fast-path carve-outs, hand-rolled retry vs `runProbe`, ad-hoc redaction, managed-file write patterns, libpod prefix, network egress).
- [ ] The inventory names the residual layering check from US-539 and records whether the engine seam made it deletable.
- [ ] Tests pass; typecheck passes; lint passes

### US-546: Thin or retire seam-owned rules

**Description:** As CI, rules whose ownership constraint is now unrepresentable in the workspace DAG stop scanning for it; only behavioral residue remains.

**Acceptance Criteria:**

- [ ] Each rule with a `delete` or `thin` verdict from US-545 is executed: deleted rules leave an alias note in the script catalog (architecture-simplicity style), thinned rules drop their seam-ownership scans and keep behavioral bans.
- [ ] Scanned-root tier lists are consistent: every surviving scanner covers `core/src/**`, `engine/src/**`, `landofile/src/**`, `paths/src/**`, `state-store/src/**`, and `plugins/**` per its residual purpose, with owning-package exclusions preserved.
- [ ] Net scanner LOC under `scripts/` decreases; before/after counts are recorded in progress notes.
- [ ] `bun run scripts/check-boundaries.ts --all` passes; no gate name consumers (CI workflows, docs/ci-runbook.md) reference a deleted gate without the alias note.
- [ ] Tests pass; typecheck passes; lint passes

### US-547: New-gate bar

**Description:** As a future maintainer, adding a new `check:*-boundary` scanner requires a recorded justification that a package seam cannot carry the constraint.

**Acceptance Criteria:**

- [ ] Root AGENTS.md and §13.8 state the bar: propose the package seam first; a new scanner rule must document why the seam is impossible or premature.
- [ ] The boundary rule registration shape carries a required justification field (or equivalent enforced convention) so the bar is checkable in review, and existing rules satisfy it via the US-545 inventory.
- [ ] Tests pass; typecheck passes; lint passes

### US-548: Wave closure

**Description:** As the wave owner, every story's verification contract is re-run green from a clean worktree and the closure is recorded.

**Acceptance Criteria:**

- [ ] All US-535..US-547 `passes: true`; full verification contract from the index PRD green: `codegen:check`, typecheck, lint/deprecations, full boundary suite, workspace package-dag, guide coverage, library API + plugin-abstraction contract suites, cold-start and hot-path benchmarks, compiled-binary + relocated smoke.
- [ ] Focused test spot-checks use path filters with positive test counts (never inferred passes).
- [ ] Progress notes record the wave's measured outcomes: scanner-LOC delta, core-LOC delta, and the import-edge assertions (no engine→shell, no app/services→cli).
- [ ] Tests pass; typecheck passes; lint passes

## Functional Requirements

- Gate names consumed by CI stay stable or leave alias notes; `scripts/check-boundaries.ts --all` remains the one-pass runner.
- Thinning never widens a carve-out: fast-path exceptions keep their current shape.

## Non-Goals

- Deleting the boundary substrate engine.
- Weakening semantic gates (`check:guide-coverage`, `check:schema-compatibility`, `check:public-transcripts`, `check:machine-output`).
- Retiring `check:spec-reference` (the spec tree remains deletable planning material).

## Technical Considerations

- Re-run workspace-sensitive gates from a clean worktree before treating local planning artifacts as regressions (recorded learning from the architecture-simplicity closure).
- CI workflow files are generated; gate list changes go through the workflow generators and `codegen:check`, never hand edits.

## Success Metrics

- Scanner count and scanner LOC materially reduced; every survivor justified in writing.
- The next boundary need after this wave is answered with a package proposal first.

## Guide Coverage

**None — internal/infra PRD.** CI/maintainer surface only.

## Open Questions

- None blocking.
