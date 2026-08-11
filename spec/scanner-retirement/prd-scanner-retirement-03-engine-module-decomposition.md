# PRD: SR-03 — Engine module decomposition

## Introduction

Split the two largest remaining god-modules **inside** `@lando/engine` without new workspace packages: the self-update operation and the app planner. Export surfaces stay stable so CLI consumers and generated runtime layers do not churn. Pure moves only — zero logic change.

## Source References

- `spec/03-architecture.md` §3.3–§3.4 (`AppPlanner`, operations)
- `spec/15-binary-build-and-release.md` (self-update behavior unchanged)
- `engine/src/operations/update.ts`, `engine/src/services/planner.ts`
- `.omo/plans/finish-scanner-retirement.md` todos 7–8, 12–14

## Goals

- `engine/src/update/` owns errors, manifest, verify, and operation entry; `operations/update.ts` is a re-export barrel.
- `engine/src/planner/` owns per-concern modules **including assemble/`planApp`**; `services/planner.ts` is `AppPlannerLive` + the stable re-export surface (≤ 500 LOC).
- No consumer import path changes for update or planner.

## User Stories

### US-556: Split the update operation into `engine/src/update/`

**Description:** As a maintainer, self-update code is organized by concern under `engine/src/update/` with a stable re-export at `engine/src/operations/update.ts`.

**Acceptance Criteria:**

- [ ] New modules: at minimum `errors.ts` (the nine `Schema.TaggedError` classes), `manifest.ts` (result schema, channel/version/platform/URL helpers, manifest state path), `verify.ts` (cosign identity + signature/checksum verification), `operation.ts` (entry flow + launch probe + remainder).
- [ ] `operations/update.ts` re-exports exactly the pre-move export set (`export type` where `verbatimModuleSyntax` requires); `wc -l` ≤ 90.
- [ ] Each new file ≤ 600 LOC with a concern header.
- [ ] **`runLaunchProbe` preserved exactly:** single `ProcessRunner.run({ args: ["--version"], timeoutMs: 15_000 })` with existing output capture and error mapping. Do **not** introduce retries; do **not** migrate to `runProbe` in this story.
- [ ] Consumers unchanged: `core/src/cli/command-specs/meta/update.ts`, `core/src/cli/operations.ts`, `core/src/cli/dispatch-meta.ts` keep importing `@lando/engine/operations/update`.
- [ ] `bun test core/test/cli/update-manifest.test.ts core/test/cli/update-telemetry.test.ts` pass with positive counts; typecheck + import-cycle green.
- [ ] Tests pass; typecheck passes; lint passes

### US-557: Decompose the planner into `engine/src/planner/`

**Description:** As a maintainer, `AppPlannerLive` sits on thin orchestrator surface over per-concern planner modules, including an assemble module that owns `planApp`.

**Acceptance Criteria:**

- [ ] `engine/src/planner/` modules by **symbol name** (regenerate outline; do not trust stale line numbers), including at least: service-types, compose-capabilities, file-sync, storage, authored, endpoints, extensions, naming, **assemble** (`planApp` and pure phase helpers — `planApp` alone is ~772 LOC pre-move and MUST leave `services/planner.ts`).
- [ ] Additional concern modules MAY be created if needed to hit the orchestrator size limit, under the same zero-logic-change rule.
- [ ] Each planner module ≤ 600 LOC; **no** `engine/src/planner/*` file imports `../services/planner.ts` (shared types live in `service-types.ts` with no reverse edge).
- [ ] `services/planner.ts` contains AppPlannerLive construction (same dependency provision pattern) + re-exports of the known surface: `AppPlanner`, `FILE_SYNC_DEFAULT_EXCLUDES`, `DEFAULT_PROXY_DOMAIN`, `mergeDefaultExcludes`, `applyAuthoredAppMount`, `applyAuthoredHealthcheck`, `applyAuthoredDependencies`, `AppPlannerLive`. Target `wc -l` ≤ 500.
- [ ] Generated runtime layers (`@lando/engine/services/planner`) and `app-config-translate` consumers unchanged; `git diff` on `core/src/runtime/generated` empty for this story.
- [ ] Typecheck + import-cycle green; full **`bun test`** lock vs baseline (planner behavior is primarily covered by core + generated guide scenarios).
- [ ] Tests pass; typecheck passes; lint passes

## Functional Requirements

- Behavior-preserving: no plan shape, capability error, update channel, or signature-verification change.
- Export stability is part of the contract, not a nice-to-have.

## Non-Goals

- New `@lando/planner` or `@lando/update` workspace packages.
- Decomposing data-mover or scratch-app.
- Improving update security posture or planner algorithms while moving code.

## Technical Considerations

- `planApp` size makes an assemble module mandatory — a "helpers only" split leaves the orchestrator over the 500 LOC bar.
- Effect layer sibling note still applies: provide dependencies directly to the layer that needs them.

## Success Metrics

- Two god-modules replaced by named module trees with thin stable façades.
- No consumer file changes for import paths.

## Guide Coverage

**None — internal/infra PRD.**

## Open Questions

- None blocking.
