# PRD Beta 1 — 19 — Service base + feature composition (the §6.11 model made real)

> **Top-priority remediation PRD.** This PRD precedes all other in-flight Beta 1 work (US-355..US-362 carry the lowest priority indices). It corrects a structural omission: the v4 service model (§6.1, §6.11) was never implemented — service types hand-build `ServicePlan`s instead of composing a `base` with priority-ordered `features`. Land this before any further service-type or feature work.

## Introduction

Beta 1 is the last feature-surface phase, so the canonical service composition model lands now rather than being deferred past feature freeze. The spec has always defined a v4 service as a **base** (`l337` or `lando`) plus a sequence of composable **features** (§6.1, §6.11): a `ServiceType` resolves `type: <name>` into a `ServiceTypeResolution` (`{ base, normalizedConfig, features }`), and core's planner composes the named base with the priority-ordered feature list to produce the `ServicePlan`. The two bundled bases — `l337` (artifact/build plumbing only, no env layer) and `lando` (the opinionated dev service with the `lando.*` feature stack) — are the foundation every other service type is meant to build on.

None of that was implemented. The shipped contract is monolithic: `ServiceTypeShape` is `{ id, toServicePlan(input) => ServicePlan }` (`sdk/src/services/plugins.ts`), and every catalog service type (`plugins/service-lando/src/services/*.ts`) hand-builds a complete `ServicePlan`, copy-pasting a shared `buildLandoEnv()` helper to fake the env layer. `core/src/services/base/{l337,lando}.ts` and `core/src/services/feature.ts` exist only as stubs (ID constants + a priority map + a TODO context) wired to nothing. There is no base, no `resolve()`, no `ServiceTypeResolution`, no `ServiceFeature`/`AppFeature` runtime, no `extends:`, no `artifacts:` pinning, and no `appFeatures:` manifest slot. The omission is invisible per-service (each type "works" in isolation) but loses the entire architecture: the `l337`/`lando` distinction (§6.9 — `compose`, the only `l337` type, currently injects the lando env layer in violation of the spec), `AppFeature` cross-service injection (§6.11.4 — the canonical mailpit-into-php flow cannot exist), single-inheritance reuse (§6.11.1), and the per-feature/per-type conformance surface.

The repo is private and nothing is published, so this PRD **guts the monolithic path** rather than preserving it behind an adapter. `ServiceTypeShape.toServicePlan` is replaced by the normative `ServiceType` contract; the in-core composition pipeline (§6.11.0) becomes the only way a `ServicePlan` is produced; the bundled catalog is migrated onto `base + features`; and the missing machinery (`ServiceFeature`, `AppFeature`, `extends:`, `artifacts:`) lands with contract suites and boundary gates so the omission cannot recur.

This PRD implements the normative pipeline and conformance requirements from §6.11.0 / §6.11.0.1, the base/feature contracts from §6.11 / §6.11.4, and the §13.1 service-composition/service-feature/app-feature contract suites plus the §13.4 env-helper boundary gate. The accompanying spec edits (§6.1 composition-is-normative note, §6.11.0 planning algorithm, §6.11.0.1 conformance requirements, §6.12.1 per-type checklist, §13 contract-suite rows, §6.11.4 manifest-slot note) are the source of truth; this PRD and those sections must stay in lockstep.

Depends on: **BETA1-04** (SDK surface discipline, schema snapshot, `sdk/API_COMPATIBILITY.md` lockstep — the `ServiceType`/`ServiceFeature`/`AppFeature` contracts are SDK surface) and **BETA1-11** (SDK/library acceptance + import-boundary contracts). It otherwise stands alone and blocks any later PRD that adds a service type or feature.

## Source References

- [`spec/06-services.md`](../06-services.md) §6.1 composition-is-normative model + the two-base table; §6.11.0 the normative planning algorithm; §6.11.0.1 service-type conformance requirements; §6.11 `ServiceType`/`ServiceTypeResolution`/`ServiceFeatureDefinition` contracts and the built-in `lando.*` feature priority list; §6.11.1 `extends:` inheritance; §6.11.2 `artifacts:` version pinning; §6.11.3 service-type-shipped tooling; §6.11.4 `AppFeature` (selectors, activation, cycle detection, `requires.globalServices`); §6.9 the `l337` vs `lando` env-layer split; §6.12.1 catalog "Default base" column + the per-type implementation checklist; §6.12.4 the `creds:` schema.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1 the service-composition / service-feature / app-feature shared contract-suite rows; §13.2 the schema-snapshot gate; §13.4 the env-helper boundary gate.
- [`spec/04-pluggability.md`](../04-pluggability.md) §4.2 the service-type / service-feature / app-feature contribution surfaces and the `serviceFeatures:` / `appFeatures:` manifest slots.
- [`spec/10-plugins.md`](../10-plugins.md) §9.5 manifest contribution shape; plugin loader consumption of `serviceTypes:` / `serviceFeatures:` / `appFeatures:`.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) §12.1 the app-plan cache key (must include the resolved base + ordered `FeatureRef` list + `AppFeature` contributions).
- [`spec/18-global-app.md`](../18-global-app.md) §20.6.3 `AppFeature.requires.globalServices` aggregation into the user app's `pre-start` ensure-running pass.
- [`spec/beta-1/prd-beta-1-00-index.md`](./prd-beta-1-00-index.md) verification contract, SDK/schema lockstep, and dual-dispatch rules.

## Goals

- Replace `ServiceTypeShape.toServicePlan` with the normative `ServiceType` (`base`, `versions?`, `extends?`, `artifacts?`, `schema`, `resolve() => ServiceTypeResolution`) as the only service-type contract; nothing hand-builds a `ServicePlan`.
- Make the §6.11.0 pipeline (resolve → seed base → service features by priority → app features → draft → single core finalization) the one path that produces service plans, owned by the `AppPlanner`.
- Implement the two bundled bases — `l337` (artifact/build plumbing only, no env layer) and `lando` (default `lando.*` feature stack) — and the built-in feature modules, with `buildLandoEnv` reachable only through `lando.env`.
- Ship `ServiceFeature` and `AppFeature` as published SDK contracts with `serviceFeatures:` and `appFeatures:` manifest slots consumed by the loader, including selector evaluation, cycle detection, and `requires.globalServices` aggregation.
- Land `extends:` single inheritance (depth ≤ 4, no cycles) and declarative `artifacts:` version pinning, both folded into the app-plan cache key.
- Migrate the entire canonical catalog onto `base + features` and prove the `l337`/`lando` split (especially `compose` carrying no injected `LANDO_*` env).
- Encode the model as `@lando/sdk/test` contract suites (`runServiceCompositionContract`, `runServiceFeatureContract`, `runAppFeatureContract`) wired into §13.1, plus the §13.4 boundary gate forbidding direct env-helper imports, so the omission cannot regrow.

## User Stories

### US-355: Replace `ServiceTypeShape` with the normative `ServiceType` + `ServiceTypeResolution` contract

**Description:** As a service-type author, I declare a `base` and return a resolved `{ normalizedConfig, features }` instead of hand-building a `ServicePlan`.

**Acceptance Criteria:**

- [ ] `@lando/sdk/services` replaces `ServiceTypeShape` with the §6.11 `ServiceType` shape: `id`/`name`, `base: "l337" | "lando"`, optional `versions`/`extends`/`artifacts`, `schema`, and `resolve: (input: ServiceTypeInput) => Effect<ServiceTypeResolution, ServiceTypeError>`; and publishes `ServiceTypeResolution` (`{ base, normalizedConfig, features, tooling?, metadata? }`), `FeatureRef`, and `ServiceTypeInput`.
- [ ] The old `toServicePlan` member and `ServiceTypePlanInput` are removed from the SDK surface (private repo — no adapter, no deprecation shim).
- [ ] `PluginRegistry.loadServiceType` returns the new `ServiceType`; its error union is unchanged.
- [ ] `sdk/test/contract/service.test.ts` and `TestServiceType` are rewritten against the new contract; the legacy `toServicePlan` assertions are deleted.
- [ ] `sdk/API_COMPATIBILITY.md`, the SDK export/compat fixtures, and the §13.2 schema snapshot are updated in the same change; `bun run codegen:schema-snapshot` then `git diff --exit-code` is clean on generated/snapshot paths.
- [ ] Tests pass. Typecheck passes. Lint passes.

### US-356: Publish the `ServiceFeature` contract and the in-core priority-ordered composition engine

**Description:** As the planner, I compose a service by seeding a base draft and applying service features in priority order, each mutating only the draft.

**Acceptance Criteria:**

- [ ] `@lando/sdk/services` publishes `ServiceFeatureDefinition` (`id`, `schema?`, `priority`, `requires?`, `apply`) and the mutable `ServiceFeatureContext` draft surface (`addEnv`, `addMount`, `addBuildStep`, `addStorage`, `addEndpoint`, `addHealthcheck`, `setEntrypoint`, `setUser`, `setWorkingDirectory`, … per §6.11) backed by a draft, not a finished `ServicePlan`.
- [ ] A core composition engine (`core/src/services/compose.ts` or equivalent, replacing the `feature.ts` stub) seeds a draft from a base, merges the base default feature list with the resolution's `features`, runs each `apply` in ascending `priority`, and emits a provider-neutral `ServicePlan` draft.
- [ ] Features are proven idempotent and replay-safe: composing twice yields a byte-identical draft.
- [ ] The plugin manifest `serviceFeatures:` slot is consumed by the loader (a `loadServiceFeature(id)` registry path), replacing the dead-slot state.
- [ ] A feature that performs a provider-capability check or bind/realization decision fails `runServiceFeatureContract` (features emit intent only).
- [ ] Tests pass. Typecheck passes. Lint passes.

### US-357: Publish the `AppFeature` contract, `appFeatures:` manifest slot, and selector/cycle engine

**Description:** As a plugin, I mutate selected sibling services across the app plan when a triggering service is present (e.g. inject SMTP env into PHP services).

**Acceptance Criteria:**

- [ ] `@lando/sdk/services` publishes `AppFeatureDefinition`, `AppFeatureActivation`, `AppFeatureSelectors`, `AppFeatureContext`, and `AppFeatureError` (the `SelectorMatchedNothing` / `MutationConflict` / `CycleDetected` tagged union) per §6.11.4, plus `AppFeatureCycleError`.
- [ ] `PluginContribution` gains an `appFeatures:` slot (additive to the manifest schema) consumed by the loader; the §13.2 snapshot + `sdk/API_COMPATIBILITY.md` are updated in lockstep.
- [ ] The app-feature pass runs after every service draft exists, evaluates `activatedBy` (no match → no `apply`, no plan-cache entry), resolves selectors (`types`/`framework`/`hasFeature`/`names`/`fromConfig`) against the resolved drafts, and applies mutators idempotently to each selected service.
- [ ] A cyclic A↔B mutation is rejected with `AppFeatureCycleError`; `requires.globalServices` aggregates into the user app's `pre-start` ensure-running pass (§20.6.3) and a missing global service fails with `GlobalServiceMissingError` + remediation.
- [ ] A negative test proves a no-match `AppFeature` is a true no-op (no mutation, no cache entry).
- [ ] Tests pass. Typecheck passes. Lint passes.

### US-358: Implement the `l337` and `lando` bases and the built-in `lando.*` feature modules

**Description:** As a service author, a `lando`-base service gets the full opinionated stack and an `l337`-base service gets only artifact/build plumbing.

**Acceptance Criteria:**

- [ ] `core/src/services/base/lando.ts` seeds the default `lando.*` feature stack (the §6.11 priority list) and the `lando.env` env baseline; `core/src/services/base/l337.ts` seeds only artifact/build fields + Compose/user-authored environment and **no** `lando.*` feature, env layer, app mount, or `/etc/lando` scaffolding.
- [ ] `@lando/service-lando` ships the built-in feature modules required by the migrated catalog — at minimum `lando.env`, `lando.app-mount`, `lando.healthcheck`, `lando.storage`, `lando.user-id`, and `lando.user` — each a `ServiceFeatureDefinition` at its §6.11 priority.
- [ ] `buildLandoEnv` (the env-layer helper) is moved into the `lando.env` feature body and is no longer exported for direct use by service types; the `lando` base obtains `LANDO_*` identity env only via `lando.env`.
- [ ] A `lando`-base composition carries the §6.9 `LANDO_*` identity env; an `l337`-base composition carries only Compose-level / user-authored env (asserted by a focused unit test for each base).
- [ ] Tests pass. Typecheck passes. Lint passes.

### US-359: Wire the composition pipeline into `planApp` and fold base/features into the cache key

**Description:** As the runtime, every service plan is produced by the one §6.11.0 pipeline, and feature changes invalidate cached plans.

**Acceptance Criteria:**

- [ ] `core/src/services/planner.ts` `planApp` replaces the direct `serviceType.toServicePlan(...)` call with: `resolve()` → seed base draft → apply service features by priority → run the app-feature pass over all drafts → emit `ServicePlan` drafts → the existing finalization (capability checks, bind realization, shadow expansion, file-sync sessions, route/networking aggregation, default-exclude merge, `AppPlan` decode) runs exactly once, unchanged in ownership.
- [ ] No provider realization happens inside a feature; the finalization stage remains the single owner of capability/realization decisions (asserted by the feature contract + a planner test).
- [ ] The app-plan cache key (§12.1) incorporates the resolved `base`, the ordered `FeatureRef` list, and the activated `AppFeature` contributions; a feature/base change rolls the key (test: same Landofile, different feature set → cache miss).
- [ ] `core/src/services/feature.ts` and the base stubs no longer contain TODO-only bodies; orphaned monolithic-path code is deleted.
- [ ] Tests pass. Typecheck passes. Lint passes.

### US-360: Service-type inheritance (`extends:`) and declarative `artifacts:` version pinning

**Description:** As a service-type author, I extend a parent type and pin versions to image tags declaratively.

**Acceptance Criteria:**

- [ ] `resolve()` honors `extends: <parent-id>`: the parent resolves first, then the child resolves against the parent's `ServiceTypeResolution` and may overlay/replace per §7.2 merge rules; inheritance is single, depth ≤ 4, cycles rejected at load with `ServiceTypeCollisionError`.
- [ ] `artifacts:` (`{ "<version>": "<image-tag>" }`) resolves a user's `type: <name>:<version>` to a concrete tag at plan-compile time; exact match wins, a `versions:` entry without an `artifacts:` entry resolves to `<name>:<version>` by convention, and the resolved tag is recorded in the app-plan cache key.
- [ ] A representative inheritance case (e.g. a test `child extends parent` fixture) and a representative pin case are covered by tests, including a depth-limit and a cycle-rejection test.
- [ ] Tests pass. Typecheck passes. Lint passes.

### US-361: Migrate the canonical catalog onto `base + features` and prove the `l337`/`lando` split

**Description:** As a maintainer, every bundled service type composes from a base and a feature list, and `compose` is a true `l337` service.

**Acceptance Criteria:**

- [ ] Every `plugins/service-lando/src/services/*.ts` type is rewritten to declare a `base` and return a `ServiceTypeResolution`; no `toServicePlan` and no direct `buildLandoEnv` import remains.
- [ ] `compose` declares `base: "l337"` and a negative test asserts its composed environment contains **no** injected `LANDO_*` keys unless the user authored them (fixing the current §6.9 violation).
- [ ] The `lando`-base catalog types (php, node, postgres, mariadb, mysql, mongodb, redis, nginx, apache, …) declare `base: "lando"` and pass `runServiceCompositionContract`, including the `lando.env`/`LANDO_*` assertions and their `tooling:`/`creds:`/`framework:` presets flowing through the resolution.
- [ ] Per-family parity tests confirm the composed `ServicePlan` (pre-finalization) matches the previously-asserted plan shape for each migrated type, or the diff is intentional and documented in the test.
- [ ] The whole-workspace `bun test` is green with no service test skipped or deleted to pass.
- [ ] Tests pass. Typecheck passes. Lint passes.

### US-362: Ship the §13.1 contract suites and the §13.4 env-helper boundary gate

**Description:** As a reviewer, the base/feature model is enforced by contract suites and a lint gate so a future service type cannot silently skip it.

**Acceptance Criteria:**

- [ ] `@lando/sdk/test` exports `runServiceCompositionContract`, `runServiceFeatureContract`, and `runAppFeatureContract` with the assertions enumerated in the §13 contract-suite rows (base declared; `resolve()` not hand-building a plan; `lando`→`lando.env`/`LANDO_*`; `l337`→no injected env layer; env-helper reachable only via `lando.env`; `extends:` depth/cycles; priority stability; cache-key participation; feature idempotency/intent-only; app-feature activation/selector/cycle/`requires.globalServices`).
- [ ] The bundled catalog tests run `runServiceCompositionContract` per type (and `runAppFeatureContract` for the mailpit-style feature), wired as the §13.1 layer-coverage mandate.
- [ ] A §13.4 boundary gate (`scripts/check-*.ts`, wired into CI static checks via a `bun run check:*` script) fails on any direct import of the env-layer helper from `plugins/service-lando/src/services/**` (only the `lando.env` feature may import it); a negative fixture proves the gate fires.
- [ ] `sdk/API_COMPATIBILITY.md` records the additive `@lando/sdk/test` exports; the §6.12.1 per-type checklist is referenced by the catalog tests.
- [ ] Tests pass. Typecheck passes. Lint passes.

## Functional Requirements

- The `ServiceType` contract is the only service-type surface: `{ id, name, base, versions?, extends?, artifacts?, schema, resolve }`. `resolve()` returns a `ServiceTypeResolution` and is an `Effect` (may be async); it normalizes config and chooses base/features/tooling and MUST NOT build a `ServicePlan`.
- Composition is owned by core's `AppPlanner` and follows §6.11.0 exactly. Features emit provider-neutral intent only; provider realization stays in the single finalization stage.
- The `l337` base seeds artifact/build plumbing + Compose/user env only; the `lando` base seeds the default `lando.*` feature stack including `lando.env`. The env-layer helper is reachable only through `lando.env`.
- `ServiceFeature` and `AppFeature` are published SDK contracts with `serviceFeatures:` and `appFeatures:` manifest slots the loader consumes. `AppFeature` supports activation gating, selector evaluation against resolved drafts, idempotent per-service mutation, cycle rejection, and `requires.globalServices` aggregation.
- `extends:` is single inheritance (depth ≤ 4, no cycles); `artifacts:` is exact-match version pinning. Both, plus the resolved base and ordered `FeatureRef` list, participate in the app-plan cache key.
- The model is enforced by the three §13.1 contract suites and the §13.4 boundary gate; the §6.12.1 per-type checklist is the human review gate.

## Non-Goals

- No new service types or framework presets beyond what the migration of the existing catalog requires; the catalog membership (§6.12.3) is unchanged.
- No new provider capabilities or realization behavior; the finalization stage is moved-behind, not rewritten.
- No `AppFeature` consumers beyond the model + its contract suite; the actual mailpit-into-php product wiring rides its own service plugin and is not in scope here (this PRD ships the contract and a representative test feature).
- No range/wildcard `artifacts:` matching (§6.11.2 explicitly defers it); exact-match only.
- No change to the §6.13 build orchestration, `BuildPlan` DAG, or the artifact group-weighted instruction model (§6.3) beyond what features need to register build steps.

## Technical Considerations

- This is a gut-and-replace, not an additive migration: the repo is private and unpublished, so `toServicePlan` is deleted rather than adapted. Land US-355..US-359 (contracts + engine + bases + wiring) before US-361 (catalog migration) so the catalog migrates onto a working engine.
- The `ServiceFeatureContext` must be a draft surface, not a raw mutable `ServicePlan`, so features cannot bypass finalization or bake provider-specific realization early. Model it as the pre-finalization intent shape the engine emits.
- `resolve()` becoming an `Effect` widens the planner's service path from sync (`Effect.try` around `toServicePlan`) to a proper effectful resolve; keep the surrounding `planApp` capability/realization stages exactly as they are to avoid collateral churn.
- The app-plan cache key change is load-bearing: omitting the `FeatureRef` list or `AppFeature` contributions produces stale plans when a feature changes. Add the cache-miss test in US-359 as the regression guard.
- SDK surface changes (the `ServiceType`/`ServiceFeature`/`AppFeature` contracts, the `appFeatures:` manifest slot, the `@lando/sdk/test` suites) all follow `sdk/AGENTS.md` lockstep: snapshot, `sdk/API_COMPATIBILITY.md`, fixtures, test doubles in the same change.
- Bundled-plugin count/list fixtures and the schema snapshot may shift when feature modules and the manifest slot land; regenerate via the relevant `bun run codegen:*` and confirm `git diff --exit-code` on generated paths.

## Success Metrics

- Zero service types call `toServicePlan`; zero service types import the env-layer helper directly (enforced by the §13.4 gate).
- `compose` (and any `l337` type) carries no injected `LANDO_*` env layer; every `lando`-base type carries the §6.9 identity env via `lando.env`.
- Every bundled service type passes `runServiceCompositionContract`; the mailpit-style `AppFeature` passes `runAppFeatureContract`.
- A feature/base/`extends`/`artifacts` change rolls the app-plan cache key (cache-miss test green).
- Whole-workspace `bun test`, `bun run typecheck`, and `bun run lint` are green with no service test skipped or deleted.

## Guide Coverage

**None — internal/infra PRD.** This PRD is an architectural refactor of the service-composition substrate; it ships no new user-facing CLI surface. The existing service guides (php, node, postgres, etc.) continue to pass unchanged through the migrated engine and are covered by their owning PRDs.

## Open Questions

- Does the migrated `ServiceFeatureContext` draft need to expose every mutator the §6.11 built-in features use in Beta 1, or only the subset the migrated catalog exercises, with the rest landing as their consuming features arrive (host-proxy, bun-self, ssh-agent sidecar)? Default: ship the subset the catalog needs plus the documented mutator names, and gate the unimplemented ones with a typed error.
- Should `extends:` and `artifacts:` ship in US-360 as specified, or is the minimum viable migration just base + features (US-355..US-359, US-361..US-362) with `extends:`/`artifacts:` as a fast-follow? Default: keep US-360 in this PRD since the contracts already reference them and the catalog's version aliases depend on `artifacts:` resolution.
