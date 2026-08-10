# PRD: SR-04 — Gate surface and wave closure

## Introduction

Finish the contributor-facing half of architecture-by-scanner debt: make `codegen:check` a true pure-drift gate (US-505 target, finally landed), collapse fourteen per-rule package.json boundary aliases into one `check:boundaries` entry while **keeping** the per-rule scripts as programmatic test APIs, regenerate CI + update every PR-tier lock that hard-codes the old surface, and close the wave.

## Source References

- `spec/13-testing-and-distribution.md` §13.4, §13.8
- `spec/architecture-simplicity/prd-architecture-simplicity-04-codegen-drift-gate.md` (US-505)
- `spec/core-seams/prd-core-seams-04-gate-thinning-and-closure.md` (inventory / ratchet bar)
- `scripts/check-boundaries.ts`, `scripts/build-ci-workflow.ts`, `package.json` scripts
- `.omo/plans/finish-scanner-retirement.md` todos 9–11, 14, F1–F4

## Goals

- `codegen:check` === `bun run codegen && bun run check:codegen-drift`.
- package.json boundary surface === `check:boundaries` → `scripts/check-boundaries.ts --all`.
- Rule IDs stable; shim scripts retained; portable static matrix still has no typecheck step.
- All PR-tier and NIGHTLY locks that name old aliases or the four-stage codegen pipeline are rewritten.

## User Stories

### US-558: Make `codegen:check` pure drift

**Description:** As CI, a failing `codegen:check` means generated output drifted — not that typecheck or deprecations failed.

**Acceptance Criteria:**

- [ ] package.json `codegen:check` equals exactly `bun run codegen && bun run check:codegen-drift`.
- [ ] `check:deprecations` remains inside `lint`; typecheck remains a separate CI job outside the portable `static-checks-platform` matrix.
- [ ] **Do not** add `run: bun run typecheck` to `static-checks-platform` (locks at `core/test/build/ci-workflow.test.ts` and `core/test/scripts/codegen-ci.test.ts` stay green and unedited for that assertion).
- [ ] Tests that hard-lock the old four-stage pipeline are rewritten: `core/test/scripts/check-codegen-drift.test.ts`, `core/test/scripts/check-deprecations.test.ts` (assert deprecations stays in lint and is absent from codegen:check), `core/test/build/gate-classification-matrix.test.ts` ordered steps exactly `["codegen", "check:codegen-drift"]`.
- [ ] AGENTS.md US-505 / codegen:check paragraph and docs/ci-runbook.md (if present) state drift-only.
- [ ] Focused tests above pass with positive counts; evidence records ≥1 existing out-of-matrix typecheck job in ci.yml.
- [ ] Tests pass; typecheck passes; lint passes

### US-559: Collapse boundary package.json aliases into `check:boundaries`

**Description:** As a maintainer, one package.json gate runs all boundary rules; per-rule scripts remain as test-support APIs; CI and docs match — in a single commit with the alias deletion.

**Acceptance Criteria:**

- [ ] package.json: delete the fourteen per-rule aliases (`check:managed-file-boundary`, `check:renderer-boundary`, `check:paths-boundary`, `check:state-store-boundary`, `check:probe-boundary`, `check:network-boundary`, `check:redaction-boundary`, `check:spec-reference`, `check:libpod-prefix`, `check:machine-output`, `check:import-cycle`, `check:generated-output`, `check:env-helper-boundary`, `check:package-dag`) and `check:core-layering-boundary`; add `"check:boundaries": "bun run scripts/check-boundaries.ts --all"`.
- [ ] **Do not delete** any `scripts/check-*.ts` file. They export typed APIs used by dedicated tests (including `scripts/check-network-boundary.test.ts`, `scripts/check-libpod-prefix.test.ts`, package-dag fixture, etc.).
- [ ] `scripts/build-ci-workflow.ts` replaces per-rule static-checks steps with one Boundary gates / `check:boundaries` step; preserve non-boundary steps (`check:compose-coverage`, `check:telemetry-inventory`, `check:runtime-bundle-manifest`, lint, single codegen:check). Run `bun run codegen` — never hand-edit workflows.
- [ ] PR-tier / alias-facing tests rewritten: `core/test/build/ci-workflow.test.ts`, `core/test/build/ci-runbook.test.ts`, `core/test/build/branch-protection.test.ts` (if needed), `core/test/build/gate-classification-matrix.test.ts` semantic map, `core/test/scripts/codegen-ci.test.ts` (per-rule steps → single boundaries step; keep no-Typecheck assertion), `core/test/scripts/check-core-layering-boundary.test.ts` (alias absent; package-dag still invocable via rule id or shim), `core/test/scripts/boundary/inventory.test.ts` retired-alias docs.
- [ ] Docs: AGENTS.md, core/AGENTS.md, scripts/boundary/README.md, docs/ci-runbook.md, README.md renderer-boundary table row; guide MDX that embeds old aliases (e.g. compiled-binary-setup-parity) repointed to `bun run scripts/check-boundaries.ts <rule-id>` — if MDX touched, run lint:guides + check:guide-drift.
- [ ] Alias collapse + CI regen + test/doc updates land in **one commit**.
- [ ] Focused test list above passes with positive counts; `bun run check:boundaries` green; `bun run check:managed-file-boundary` fails as unknown package script; stale-alias sweep over AGENTS.md, core/AGENTS.md, docs/, .github/workflows/, scripts/boundary/README.md, package.json, README.md, core/test/ using explicit full removed-alias names finds zero live package.json keys.
- [ ] Tests pass; typecheck passes; lint passes

### US-560: Wave closure

**Description:** As the wave owner, every story's verification contract is re-run green from a clean worktree and the closure is recorded.

**Acceptance Criteria:**

- [ ] All US-551..US-559 `passes: true`.
- [ ] Full verification contract from the index PRD green: drift-only `codegen:check`, typecheck, lint/deprecations, `check:boundaries`, package-dag, **`bun test`** full suite with positive counts, guide coverage (None), library/schema unchanged.
- [ ] Progress notes record: scanner alias count delta, managed-file rule verdict, planner/update LOC before/after façades, confirmation that engine has no managed-file package edge, confirmation that static-checks-platform still has no typecheck step.
- [ ] Final verification wave (plan F1–F4): plan compliance, code quality (no new `as any`/ts-ignore), real manual QA of the new gates/package, scope fidelity.
- [ ] Tests pass; typecheck passes; lint passes

## Functional Requirements

- Rule IDs and residual behavioral bans are unchanged by alias collapse.
- `scripts/check-boundaries.ts <rule-id>|--all|--list` remains the single-pass runner.
- CI workflow files are generated; never hand-edited.

## Non-Goals

- Deleting the boundary substrate or residual behavioral rules.
- Weakening semantic gates (guide-coverage, schema-compatibility, public-transcripts, machine-output).
- Collapsing non-boundary check scripts (`check-codegen-drift`, `check-deprecations`, `check-guide-*`, etc.).

## Technical Considerations

- NIGHTLY_TIER_TESTS still excludes some generator suites from PR shards — but `ci-workflow.test.ts` is PR-tier and **must** be updated in US-559 or the first PR goes red.
- Mid-wave commit that deletes aliases without regenerating CI breaks main; one-commit rule is load-bearing.

## Success Metrics

- Contributors discover one boundary gate and one drift gate.
- `codegen:check` red ⇒ drift; lint red ⇒ style/deprecations; typecheck red ⇒ types.

## Guide Coverage

**None — internal/infra PRD.** CI/maintainer surface only. Guide MDX touched only to repoint stale gate Variable strings.

## Open Questions

- None blocking.
