# PRD: ALPHA2-02 — MDX codegen pipeline

## Introduction

This PRD covers Phase 2.5 Alpha 2 work for **the `scripts/build-guide-scenarios.ts` generator**: the deterministic MDX → TypeScript codegen pipeline that turns authored guides in `docs/guides/**` into generated scenario tests under `test/scenarios/generated/guides/**`.

It is the central deliverable of Alpha 2. PRD-A2-01 fixes the contracts; this PRD walks MDX ASTs and emits the tests that exercise them.

Depends on: **PRD-A2-01** (schemas and `ScenarioContext` exist).

## Source References

- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) — §19.7 codegen contract, §19.2 model and artifact, §19.5 display vs. execute.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) — §13.1 test layer rules, §13.3 type gate.
- [`scripts/codegen.ts`](../../scripts/codegen.ts) — Alpha 1 codegen pipeline this generator must register into.

## Goals

- Ship `scripts/build-guide-scenarios.ts` as a deterministic stage-1 generator that runs before type-check inside `bun run codegen`.
- Generate one TypeScript test file per scenario at `test/scenarios/generated/guides/<guideId>/<scenarioId>.test.ts`, gitignored, regenerated each run.
- Emit `// @source`, `// @scenario`, and (Alpha 2 always-empty placeholder) `// @variant` headers above every generated `test()` so the PRD-A2-03 source-mapper reporter can find them.
- Round-trip through type-check (`tsc --noEmit` over generated paths) without errors.
- Run the generated tests on the existing `bun test` harness against `TestRuntimeProvider`.

## User Stories

### US-062: Implement deterministic MDX walker

**Description:** As a maintainer, `scripts/build-guide-scenarios.ts` parses every guide MDX under `docs/guides/**` into a normalized AST that downstream codegen steps consume.

**Acceptance Criteria:**
- [ ] The generator discovers `docs/guides/**/*.mdx` and `recipes/*/README.mdx` files; missing or empty `docs/guides/` is not an error and produces zero outputs.
- [ ] MDX parsing uses `@mdx-js/mdx` (or the existing Bun-supported equivalent already pulled in by the toolchain — record the chosen dep + version in the PR description and in `package.json#dependencies`).
- [ ] Frontmatter validates against the `GuideFrontmatter` schema from PRD-A2-01. Validation failure exits 1 with a tagged `GuideFrontmatterValidationError` whose remediation lists the offending field and the rejected value.
- [ ] AST walking records `<Guide>` and every immediate `<Scenario>` child. Multi-axis (`<Tabs>`/`<Tab>`) is rejected with the schema-level Alpha 3 remediation from PRD-A2-01.
- [ ] Each scenario's component tree is flattened into an ordered list of step nodes; each step node is `(stepName, [{ kind: "Run" | "Verify" | "Cleanup" | "Variable" | "UseFixture", props }])`.
- [ ] Tests cover three fixture guides under `core/test/codegen/fixtures/guides/`: a happy-path single-scenario guide, a multi-scenario guide with one `render={false}` scenario, and a Alpha-3-only-component guide (must exit 1).
- [ ] Re-running the generator twice with identical inputs produces byte-identical AST objects (assert via JSON.stringify on a deterministic representation).
- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass.

### US-063: Emit Alpha 2 generated TypeScript

**Description:** As a generated scenario, I am valid TypeScript that imports `withScenarioContext` from `@lando/core/testing`, runs my steps in order, and registers a `Cleanup` finalizer.

**Acceptance Criteria:**
- [ ] One file per scenario emitted at `test/scenarios/generated/guides/<guideId>/<scenarioId>.test.ts`.
- [ ] Each file begins with: `// @generated`, `// @source: <relative-mdx-path>:<line>`, `// @scenario: <scenarioId>`, optional `// @variant:` placeholder (always empty in Alpha 2 — present so the source-mapper reporter does not need a different format later).
- [ ] Generated test bodies wrap `withScenarioContext({ guideId, scenarioId }, …)`; every step becomes a sequential Effect block with its own `// @source` header pointing at the MDX line of that step. `<Variable>` declarations land before any step. `<Cleanup>` blocks are added as `Effect.addFinalizer` calls registered before the first step runs.
- [ ] `<Run command="…">` becomes a `runCli(command, { answers })` call with answers resolved from `<Variable>` interpolation in source order. `<Verify event="…">` becomes an `expect(events.find(matching)).toBeDefined()` (or equivalent) assertion. `<Verify file="…">` reads the file under `testDir`. `<Verify errorTag="…">` asserts on the captured failure's `_tag`.
- [ ] `<UseFixture name="…">` lands before any mutation as `await fixtures.use(name)`.
- [ ] Variable interpolation uses `{{name}}` syntax inside `<Run command>` and `<Verify file>` values. The generator substitutes `value` (not `display`) into the generated TypeScript; `display` is preserved only as a comment for the source mapper.
- [ ] Generated output is deterministic: re-running into a temp directory and `diff`ing against the first run produces no changes (assert in a generator unit test).
- [ ] `bun run typecheck` over `test/scenarios/generated/guides/**/*.ts` passes after generation.
- [ ] Lint + workspace tests pass.

### US-064: Generate test-only scenarios without rendering

**Description:** As a maintainer, a colocated `<Scenario render={false} reason="…">` produces a generated test that runs identically to a reader scenario but is excluded from any future docs render.

**Acceptance Criteria:**
- [ ] `render: false` is preserved through the AST and emitted into the generated file header as `// @render: false`. (Used by PRD-A2-04 lint and any future docs renderer to detect this scenario.)
- [ ] The generated test runs the same `withScenarioContext` body as a reader scenario; only the render bit differs.
- [ ] If `reason` is absent or shorter than 8 chars, the generator exits 1 with a `GuideHiddenScenarioReasonError` whose remediation cites §19.9 and PRD-A2-00's hidden-coverage rule.
- [ ] Tests cover: present-reason green path, missing-reason failure, short-reason failure, and a fixture with one reader + one test-only scenario in the same guide (both files generated, both pass).
- [ ] Lint + workspace tests pass.

### US-065: Wire generator into `bun run codegen` and gitignore outputs

**Description:** As a maintainer, `bun run codegen` invokes `build-guide-scenarios` deterministically, generated outputs are gitignored, and the existing codegen catalog snapshot does not regress.

**Acceptance Criteria:**
- [ ] `scripts/codegen.ts` registers `build-guide-scenarios` as a stage-1 generator before any TypeScript-compiling stage.
- [ ] `.gitignore` is updated to ignore `test/scenarios/generated/guides/**`; the test gate (PRD-A2-04 US-070) re-creates them per-PR.
- [ ] `bun run codegen` exits 0 on a clean checkout with at least one Alpha 2 fixture guide present.
- [ ] The PR series adds the codegen drift check from Alpha 1 PRD-07 to ensure `build-guide-scenarios` is in the catalog (run codegen, assert generator listed by the catalog snapshot).
- [ ] Lint + workspace tests pass.

### US-066: Provide one canonical Alpha 2 fixture guide

**Description:** As a maintainer, a single end-to-end fixture guide lives at `docs/guides/node-postgres.mdx` that exercises every Alpha 2 component on the scenario layer.

**Acceptance Criteria:**
- [ ] `docs/guides/node-postgres.mdx` uses `<Guide>`, `<Variable>`, `<Scenario render>` (reader), `<Scenario render={false}>` (one hidden case), `<Step>`, `<Run command>`, `<Verify event>` and `<Verify errorTag>`, `<Cleanup>`, and `<UseFixture>`.
- [ ] The reader scenario walks the Phase 1 MVP scenario verbatim (`lando init --recipe node-postgres` → `lando start` → `post-start` event verify → `lando destroy -y` cleanup) but using `TestRuntimeProvider` instead of a real provider.
- [ ] The hidden `<Scenario render={false}>` exercises an invalid-Landofile regression that asserts `LandofileValidationError` with a remediation substring match.
- [ ] At least one immutable fixture lives at `docs/guides/node-postgres/fixtures/invalid-service-type/` containing a deliberately bad `.lando.yml`; the hidden scenario calls `<UseFixture name="invalid-service-type" />` before `<Run>`.
- [ ] Both generated tests pass under `bun test test/scenarios/generated/guides/node-postgres/`.
- [ ] Lint + workspace tests pass.

## Functional Requirements

- The generator MUST be deterministic. Determinism is asserted by re-running into a temp directory and comparing byte-for-byte.
- Generated files MUST NOT be committed. The single source of truth for guide tests is the MDX.
- The generator MUST exit non-zero on any malformed input. No "best effort" partial output: a broken guide fails the codegen run.
- The generator MUST NOT read or write outside `docs/guides/**`, `recipes/*/README.mdx`, `test/scenarios/generated/guides/**`, and its own temp dir.
- The generator MUST NOT shell out — it uses `Bun.file`/`Bun.write` and the MDX parser only. No `Bun.spawn`, no network.
- Generated TypeScript MUST compile under the existing `tsconfig` without changes to `compilerOptions`.

## Non-Goals

- No `<Inspect>`, `<Tabs>`, `<Tab>`, `<Inline>`, `<Skip>` codegen. PRD-A2-01 rejects these at schema time; PRD-A2-02 does not need to handle them.
- No multi-axis variant fan-out — the `// @variant` header is emitted always empty as a forward-compat marker only.
- No source-mapper reporter; that is PRD-A2-03.
- No lint or CI integration beyond `bun run codegen` registration; PRD-A2-04 owns the lint gate.
- No transcript files written by the generator. Transcripts are written at test time by the runtime helpers from PRD-A2-01 US-059 (stub) and PRD-A2-04 US-071 (real internal transcript).
- No public docs rendering, no Astro/Starlight integration.
- No alias for the older `scripts/build-doc-tests.ts` name. The Alpha 2 set ships under the spec-owned name only; the alias allowance in §19.7 is reserved for projects already shipping the older name (this repo is not).

## Technical Considerations

- The MDX parser choice (`@mdx-js/mdx` vs a Bun-native equivalent) is a one-way door. Document the choice in `AGENTS.md` under "Gotchas" alongside the codegen-formatting notes so later maintainers know which AST shape `scripts/build-guide-scenarios.ts` walks.
- The generator's output directory MUST be cleared on each run before writing new files so a deleted scenario does not leave a stale test behind.
- For determinism, sort guides by relative path and scenarios by lexicographic id before emission. No insertion-order leakage from filesystem listings.
- The codegen runs under Bun, but the emitted TypeScript MUST also run under whatever runner `bun test` uses without extra transpilation flags.
- Keep the generator small. Anything that wants to grow into a full framework (custom AST transformations, plugin hooks) should be pushed back to PRD-A2-03 or Alpha 3.

## Success Metrics

- Every user story in this PRD is accepted with its tests merged.
- `bun run codegen` exits 0; `tsc --noEmit` over generated paths passes; `bun test test/scenarios/generated/guides/**` passes.
- The canonical fixture from US-066 is the smoke-test guide for every downstream PRD-A2-03/04 story.
- Alpha 2 roadmap exit criteria become achievable without expanding scope into multi-axis or live-provider work.

## Open Questions

- Whether to add a `bun run dev:guides` watcher in Alpha 2 or defer it to PRD-A2-03's author command. Default is PRD-A2-03; revisit only if the inner loop becomes painful during US-066 implementation.
- Whether `recipes/*/README.mdx` is parsed by Alpha 2's generator at all, or only by the conditional `build-recipe-readmes.ts` in PRD-A2-04. Default: PRD-A2-02 parses them with the same vocabulary; if a recipe's README contains a runnable scenario, it generates the same kind of test as a `docs/guides/` MDX. The strip/flatten output is PRD-A2-04's conditional concern.
