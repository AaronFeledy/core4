# PRD: SEAMS-01 — Contract and workspace DAG

## Introduction

Land the normative contract for the wave: spec text that un-defers the Landofile and engine extractions (kept deferred by architecture-simplicity US-521 and ROADMAP Phase 5), and a `check:package-dag` that grows from plugin-edge checks plus a seam allowlist into a **full workspace DAG contract** — every workspace package's dependency edges are declared, and any undeclared edge fails CI. This is the structural gate the later PRDs land behind; it must exist first so the extractions are born enforced.

## Source References

- `spec/02-toolchain.md` §2.7 (package surface; private workspace packages allowed, public split rejected)
- `spec/03-architecture.md` §3.1 (four layers), §3.3 (source layout)
- `spec/13-testing-and-distribution.md` §13.8 (package-dag primary for seam ownership)
- `spec/ROADMAP.md` Phase 5 concurrent-wave note ("Further extractions … remain deferred")
- `spec/architecture-simplicity/prd-architecture-simplicity-03-package-seams.md` (US-516..US-521, the reference pattern)

## Goals

- The spec names `@lando/landofile` and `@lando/engine` as approved private seam packages and updates §3.3 source layout accordingly.
- `check:package-dag` validates the entire workspace DAG from one declared edge table; runtime plugins→core stays forbidden; seam packages never import `@lando/core`.
- The layering rule "runtime and library API must not import `core/src/cli/**`" is stated normatively so PRD-02/03 have a contract to satisfy.

## User Stories

### US-535: Spec contract for the core-seams wave

**Description:** As a maintainer, the spec authorizes the Landofile and engine seam extractions as private workspace packages and supersedes the deferred-extraction notes, without reopening the §2.7 public-split rejection.

**Acceptance Criteria:**

- [ ] §2.7 lists `@lando/landofile` and `@lando/engine` in the private-seam allowance alongside `@lando/paths` and `@lando/state-store`, and restates that public `@lando/core` remains the single publishable runtime+CLI package.
- [ ] §3.3 source layout describes the post-wave tree (engine-owned runtime modules, core-owned shell/composition), and §3.1 gains a sentence stating the shell (CLI, MCP) MUST NOT own business logic and the runtime layers MUST NOT import the shell.
- [ ] §13.8 states the workspace DAG contract: every workspace package edge is declared; undeclared edges fail `check:package-dag`.
- [ ] ROADMAP Phase 5 concurrent-wave note marks the planner/Landofile extraction deferral as superseded by `spec/core-seams/` (historical text preserved, architecture-simplicity style).
- [ ] Tests pass; typecheck passes; lint passes

### US-536: check:package-dag governs the full workspace DAG

**Description:** As CI, `check:package-dag` validates every workspace package (core, sdk, paths, state-store, container-runtime, landofile, engine, plugins/*) against one declared allowed-edge table instead of plugin-only rules plus an allowlist.

**Acceptance Criteria:**

- [ ] The rule loads the workspace member list from the root `package.json` and fails on any package whose workspace-member edges (`dependencies` and `devDependencies`) are not in the declared edge table.
- [ ] The edge table distinguishes runtime edges from dev/test edges so today's real graph stays legal: plugin→plugin runtime edges exist (`@lando/provider-podman` → `@lando/provider-lando`) and `@lando/provider-lando`/`@lando/service-lando` carry `devDependencies` on `@lando/core` for their test harnesses, while runtime `dependencies` on `@lando/core` from plugins or seam packages remain forbidden.
- [ ] Declared runtime contract at minimum: plugins → {sdk, paths, state-store, container-runtime, landofile, declared plugin peers}; engine → {sdk, paths, state-store, container-runtime, landofile}; landofile → {sdk, paths, state-store}; core → any workspace package; nothing has a runtime dependency on engine except core.
- [ ] Rule has focused tests covering an undeclared edge, a forbidden runtime plugins→core edge, and a seam-package→core edge, each producing a tagged, remediation-bearing failure.
- [ ] `check:import-cycle` still passes and its module scan picks up the new package roots.
- [ ] Tests pass; typecheck passes; lint passes

## Functional Requirements

- The edge table is data (one declaration site in the rule or a sibling module), not logic scattered across per-package checks.
- Edge-table changes require touching the declaration in the same change as the `package.json` edit — drift between the two is exactly what the rule fails on.
- Placeholder entries for `@lando/landofile` and `@lando/engine` MAY land before the packages exist (US-537/US-540 scaffold against them) provided the rule tolerates declared-but-absent members.

## Non-Goals

- Changing what plugins are allowed to do at runtime.
- Retiring any behavioral boundary rule (PRD-04 owns keep/thin/delete).
- Publishing any new package.

## Technical Considerations

- Root `package.json` `workspaces` currently lists `core`, `sdk`, `container-runtime`, `paths`, `state-store`, `plugins/*`; the new packages must be added there and to the root `tsconfig.json` project references, followed by `bun install` from the repo root.
- Keep `scripts/boundary/rules/package-dag.ts` as the single implementation; `check:package-dag` stays a thin shim per the package-seams-first policy.

## Success Metrics

- One declared edge table describes the whole workspace; a reviewer can answer "who may import whom" from a single file.
- A forbidden edge fails CI at package resolution shape, not via a source-scan approximation.

## Guide Coverage

**None — internal/infra PRD.** Maintainer/CI architecture only; no end-user CLI surface changes.

## Open Questions

- None blocking.
