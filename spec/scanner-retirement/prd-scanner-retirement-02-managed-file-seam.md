# PRD: SR-02 — Managed-file package seam

## Introduction

Extract `ManagedFileService` from `@lando/engine` into a private `@lando/managed-file` workspace package modeled on `@lando/state-store` / `@lando/redaction`. Pay the scanner-retirement ratchet by converting the `managed-file` boundary rule to an owner-excluding residual ban. Core (bootstrap layers + CLI init + testing helpers) is the implementation consumer; engine keeps only the SDK `ManagedFileService` tag in plugin context — **no** engine→managed-file package edge.

## Source References

- `spec/02-toolchain.md` §2.7
- `spec/03-architecture.md` §3.3–§3.4
- `spec/11-subsystems.md` §10.13 (semantics unchanged)
- `spec/13-testing-and-distribution.md` §13.8
- `engine/src/managed-file/` (pre-move home)
- `scripts/boundary/rules/managed-file.ts`, `redaction.ts`, `network.ts` (owner-excluding pattern)
- `.omo/plans/finish-scanner-retirement.md` todos 2–6

## Goals

- `@lando/managed-file` owns the Live implementation, codecs, and markers.
- Consumers import `@lando/managed-file/*`; zero `@lando/engine/managed-file` specifiers remain.
- The `managed-file` rule excludes `managed-file/src` via `scope.roots` filter (not carveOuts).
- Package-local tests exist; CI unit shards discover them.

## User Stories

### US-552: Scaffold `@lando/managed-file` and move the source

**Description:** As a maintainer, a private `@lando/managed-file` package exists, holds the moved implementation, and is wired into the workspace without an engine package edge.

**Acceptance Criteria:**

- [ ] Package scaffolded mirroring `@lando/state-store` (private, exports `.` / `service` / `marker` / `codecs`, deps: sdk, paths, state-store, redaction, effect).
- [ ] `engine/src/managed-file/{service,marker,codecs}.ts` moved into `managed-file/src/`; `engine/src/managed-file/` gone.
- [ ] `resolveUserDataRoot` import replaced with `resolveLandoRoots().userDataRoot` from `@lando/paths` (exact existing delegation; zero behavior change).
- [ ] To keep root typecheck green at the source-move boundary, repoint the root-typechecked production seams in this story: `scripts/bootstrap-layer-renderers.ts` plus the regenerated minimal layer, `core/src/cli/commands/init.ts`, `core/src/testing/managed-file.ts`, and the core package dependency. Test-only consumer migration and the final import sweep remain US-553.
- [ ] Root workspaces + root/core tsconfig **references** updated; **no** engine/tsconfig or engine/package.json dependency on `@lando/managed-file`.
- [ ] `scripts/prepare-npm-dev-packages.ts` lists the package **before** engine; `scripts/test-shards.ts` INCLUDE_GLOBS includes `managed-file/test/**/*.test.ts`; `engine/test/engine-closure.test.ts` no longer lists `managed-file` under runtime brain directories.
- [ ] `bun install` run; package typecheck green.
- [ ] Tests pass; typecheck passes; lint passes

### US-553: Finish managed-file consumer migration and sweep

**Description:** As a maintainer, the remaining test-only `@lando/engine/managed-file/*` consumers move to `@lando/managed-file/*`, and the completed migration is proven clean.

**Acceptance Criteria:**

- [ ] Core managed-file unit, library, and contract tests updated to import `@lando/managed-file`; no phantom files invented.
- [ ] `grep` for `engine/managed-file` under core/engine/plugins/scripts returns nothing (excluding `.local/`).
- [ ] Focused managed-file tests pass with positive counts; typecheck green.
- [ ] Tests pass; typecheck passes; lint passes

### US-554: Package-dag, scan tiers, and owner-excluding ratchet payment

**Description:** As CI, the new package is on the workspace DAG and shared scan tiers, and the `managed-file` boundary rule becomes owner-excluding — paying the ratchet.

**Acceptance Criteria:**

- [ ] `WORKSPACE_EDGE_TABLE` gains `@lando/managed-file` → {sdk, paths, state-store, redaction}; engine allow-list is **not** given a managed-file edge.
- [ ] `scripts/boundary/workspace-roots.ts` adds `managed-file/src` to every tier that already lists other primitives; import-cycle roots include it if they enumerate first-party trees.
- [ ] Rule uses `scope.roots = CORE_AND_PLUGIN_SOURCE_ROOTS.filter(r => r !== "managed-file/src")` and empty carveOuts (copy redaction/network pattern); failureHeadline names `@lando/managed-file`.
- [ ] `core/test/scripts/boundary/workspace-roots.test.ts`: move `managed-file` from `CORE_AND_PLUGIN_RULE_IDS` into `OWNER_EXCLUDING_RULES` as `managed-file/src`.
- [ ] `core/test/scripts/check-managed-file-boundary.test.ts` fixtures no longer write under `engine/src/managed-file/`; they write under `managed-file/src/` (owner excluded from scan).
- [ ] Boundary README + AGENTS.md primitive lists / shared-tier enumerations updated; no remaining `engine/src/managed-file` docs paths for the owner.
- [ ] `bun run scripts/check-boundaries.ts managed-file|package-dag|import-cycle` green; workspace-roots + managed-file boundary tests pass with positive counts.
- [ ] Tests pass; typecheck passes; lint passes

### US-555: Package-local tests and managed-file seam lock

**Description:** As a maintainer, `@lando/managed-file` has in-package unit tests locking current marker/codec/service behavior, and the full suite still matches the pre-seam baseline.

**Acceptance Criteria:**

- [ ] `managed-file/test/` covers marker round-trips, codecs (incl. landofile YAML), and service decision algorithm via in-memory backend (mirror core testing helpers) — tests-after, no new semantics.
- [ ] Package `"test"` script present; `bun test managed-file/test` positive count.
- [ ] Existing core managed-file tests remain and pass.
- [ ] Full lock: typecheck, lint, `bun run scripts/check-boundaries.ts --all`, **`bun test`** (positive count). Only pre-recorded baseline failures allowed.
- [ ] Tests pass; typecheck passes; lint passes

## Functional Requirements

- No ManagedFile marker, ledger path, event, or conflict-algorithm change.
- No SDK schema/error/event changes.
- Gut-and-replace: no dual import path left behind.

## Non-Goals

- Plugin-direct dependency on `@lando/managed-file` (plugins use `LandoPluginContext.managedFiles`).
- Extracting data-mover or scratch-app.

## Technical Considerations

- Core is the Live wiring home (bootstrap layers); engine plugin context continues to `yield* ManagedFileService` from sdk.
- Adding a workspace package requires `bun install` and shard/npm-dev list updates (core-seams learning).

## Success Metrics

- Managed-file rule is owner-excluding residual only; inventory documents the ratchet payment.
- Zero `@lando/engine/managed-file` import specifiers in first-party source.

## Guide Coverage

**None — internal/infra PRD.**

## Open Questions

- None blocking.
