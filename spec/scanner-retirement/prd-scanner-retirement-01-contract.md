# PRD: SR-01 — Contract for the scanner-retirement wave

## Introduction

Land the normative contract: authorize `@lando/managed-file` as a private workspace seam, authorize in-package decomposition of the engine planner and update modules, supersede the ROADMAP / architecture-simplicity deferral of managed-file extraction, and redefine the contributor-facing gate surface (`check:boundaries` + drift-only `codegen:check`) without weakening rule IDs or residual behavioral bans.

## Source References

- `spec/02-toolchain.md` §2.7
- `spec/03-architecture.md` §3.1–§3.4
- `spec/13-testing-and-distribution.md` §13.4, §13.8
- `spec/architecture-simplicity/` (US-505 target; US-521 deferral)
- `spec/core-seams/` (ratchet bar; engine seam)
- `.omo/plans/finish-scanner-retirement.md` (execution checklist)

## Goals

- Spec text matches the intended post-wave tree and gate surface.
- Deferred-extraction notes for managed-file are superseded with historical text preserved.
- No public API or ManagedFile semantics change is authorized.

## User Stories

### US-551: Spec contract for the scanner-retirement wave

**Description:** As a maintainer, the spec authorizes the managed-file package seam, engine module decomposition, and gate-surface cleanup, and supersedes prior deferrals without reopening the §2.7 public-split rejection.

**Acceptance Criteria:**

- [ ] §2.7 private-seam allowance lists `@lando/managed-file` alongside the existing private seams (`@lando/paths`, `@lando/state-store`, `@lando/landofile`, `@lando/engine`, and any other already-shipped private packages such as `@lando/redaction` / `@lando/http-client` when present in the tree). Public `@lando/core` stays the single publishable runtime + CLI package.
- [ ] §3.3 source layout shows a top-level `managed-file/` package; engine layout shows `planner/` and `update/` (or equivalent) as first-class module trees under `engine/src/`, with `services/planner` and `operations/update` described as orchestrator/re-export surfaces — not god-modules.
- [ ] §3.4 `ManagedFileService` Live Layer home is `@lando/managed-file` (composed at core bootstrap), not `engine/src/managed-file/`. Semantics still point at §10.13 unchanged.
- [ ] §13.8 / §13.4 state: (a) `codegen:check` is pure drift (`codegen` + `check:codegen-drift` only); typecheck and deprecations live in their own CI steps / `lint`; (b) the package.json boundary surface is the single `check:boundaries` gate; rule IDs remain stable and invocable via `bun run scripts/check-boundaries.ts <rule-id>`; per-rule `scripts/check-*.ts` files MAY remain as programmatic test APIs; (c) the portable static-checks matrix MUST NOT gain a typecheck step.
- [ ] ROADMAP Phase 5 concurrent-meta note marks managed-file extraction **superseded** by `spec/scanner-retirement/` (historical deferral text preserved). Architecture-simplicity US-521 / Non-Goals language that deferred managed-file is marked superseded the same way.
- [ ] Tests pass; typecheck passes; lint passes

## Functional Requirements

- Contract text is behavior-preserving for product semantics.
- Scanner-retirement ratchet remains in force: every new private seam deletes or shrinks at least one boundary rule.

## Non-Goals

- Implementing the package or refactors (US-552+).
- Changing ManagedFile marker/ledger/event contracts.

## Technical Considerations

- Only files under `spec/**` (and this wave's PRD set) are edited for US-551; product code is later stories.
- `check:spec-reference` continues to forbid non-spec durable files from citing the spec tree.

## Success Metrics

- A new contributor reading §2.7 / §3.3 / §13.8 can name the post-wave package and gate surface without reading the work plan.

## Guide Coverage

**None — internal/infra PRD.**

## Open Questions

- None blocking.
