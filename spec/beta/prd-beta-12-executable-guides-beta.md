# PRD: BETA-12 — Executable guides (Beta expansion)

## Introduction

Alpha2 shipped the executable-guide scenario engine: MDX-authored guides under `docs/guides/**` parse into TypeScript scenario tests against `TestRuntimeProvider`, with source-mapped failures. Beta expands the component vocabulary (`<Inspect>`, `<Tabs>`, `<Tab>`, `<Inline>`, `<Skip>`), turns `<Hidden>` into a real code-emitting component, adds multi-axis variants (`tabs:` / `axes:` / per-cell `variants:`), grows the lint depth to the full §19.10 set, schema-publishes the full vocabulary, and finishes the conditional recipe README strip/flatten (§19.13) so canonical recipes can use MDX READMEs.

Depends on: **Alpha2 (all)** (parser, codegen, source-mapper, lint).

## Source References

- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) §19 entire part.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.2 schema snapshot gate.
- [`spec/alpha2/`](../alpha2/) the Alpha2 PRDs that established the baseline.

## Goals

- Make every Beta-bound §19.3 component shippable and round-tripping through the schema gate.
- Land multi-axis variants so a guide can express a matrix of scenarios.
- Replace Alpha2's `ScenarioContext.runCli` fake with the real CLI seam.
- Land the recipe README strip/flatten path (§19.13) so canonical recipes can co-host their MDX docs.

## User Stories

### US-175: `<Inspect>` component (read-only state assertions inside a step)

**Description:** As a guide author, I can place `<Inspect>` between `<Run>` and `<Verify>` to expose intermediate state (config, env, file contents) without affecting scenario behavior.

**Acceptance Criteria:**
- [ ] `InspectProps` schema published in `@lando/sdk/docs/components`; round-trips through §13.2.
- [ ] Generator emits `ctx.inspect(…)` calls; output is captured in the transcript but not asserted.
- [ ] Tests cover schema validation and a sample guide using `<Inspect>` against a fake state.
- [ ] Tests pass; typecheck passes; lint passes.

### US-176: replace `ScenarioContext.runCli` fake with real CLI seam

**Description:** As the scenario engine, `ctx.runCli(args)` invokes the real Lando CLI via `@lando/core/cli` (or compiled binary in e2e mode) instead of Alpha2's fake.

**Acceptance Criteria:**
- [ ] `runCli` uses `@lando/core/cli` for `layer: "scenario"`; the e2e layer uses the compiled binary.
- [ ] Fake path remains available behind `ScenarioContextFactory.testOnlyFake` for unit tests within the engine itself.
- [ ] Existing Alpha2 generated tests still pass without changes.
- [ ] Tests pass; typecheck passes; lint passes.

### US-177: `<Tabs>` + `<Tab>` for axis selection

**Description:** As a guide author, I can declare `<Tabs>` with multiple `<Tab>` children to express axis selection (e.g. service framework, OS, language version) and the renderer shows tabs while the codegen produces a scenario per tab.

**Acceptance Criteria:**
- [ ] `TabsProps` + `TabProps` schemas published; round-trip through §13.2.
- [ ] `tabs:` frontmatter declares axis names; per-tab content emits its own scenario variant.
- [ ] Lint catches missing axis declarations and duplicate tab ids.
- [ ] Tests pass; typecheck passes; lint passes.

### US-178: multi-axis variants (`axes:` frontmatter + per-cell `variants:`)

**Description:** As a guide author, I can declare multiple `axes:` and have the codegen emit one scenario per cartesian-product cell, optionally overriding per-cell `variants:`.

**Acceptance Criteria:**
- [ ] `axes:` frontmatter accepts an array of axis declarations; codegen produces scenario variants accordingly.
- [ ] Per-cell `variants:` overrides apply through a documented merge order.
- [ ] Generated test files carry `// @variant: <key>=<value>` headers (replaces the empty placeholder from Alpha2 progress).
- [ ] Tests pass; typecheck passes; lint passes.

### US-179: `<Hidden>` becomes code-emitting

**Description:** As a guide author, `<Hidden>` blocks emit code into the generated scenario but are not rendered in the reader-visible transcript.

**Acceptance Criteria:**
- [ ] Codegen treats `<Hidden>` as a non-rendered emitter; Alpha2's `NotImplementedError` remediation is removed.
- [ ] Lint requires a `reason` attribute on `<Hidden>` (≥ 8 chars) for maintainability.
- [ ] Tests cover round-trip through schema and a representative use (e.g. seeding test fixtures invisibly).
- [ ] Tests pass; typecheck passes; lint passes.

### US-180: `<Inline>` + `<Skip>` components

**Description:** As a guide author, I can use `<Inline>` for inline-rendered code samples that do not execute, and `<Skip>` to mark a scenario as skipped with a reason.

**Acceptance Criteria:**
- [ ] `InlineProps` + `SkipProps` schemas published; round-trip through §13.2.
- [ ] `<Inline>` does not emit any execution code; output appears verbatim in transcripts.
- [ ] `<Skip>` requires a `reason` (≥ 8 chars); generated test calls `test.skip(...)`.
- [ ] Tests pass; typecheck passes; lint passes.

### US-181: fuller §19.10 lint depth

**Description:** As CI, `bun run lint:guides` runs the full §19.10 lint set: matcher-shape validation, fixture-immutability checks, axis-id uniqueness, reason-required gates, and unused-fixture detection.

**Acceptance Criteria:**
- [ ] Every §19.10 lint rule documented in `scripts/lint-guides.ts` (or equivalent).
- [ ] Each rule has at least one failing fixture and one passing fixture under `test/fixtures/guides/lint/`.
- [ ] Lint gate from PRD-A2-04 extends to the new rules in Beta.
- [ ] Tests pass; typecheck passes; lint passes.

### US-182: recipe README strip/flatten (§19.13)

**Description:** As a recipe author, my canonical recipe's MDX README can be authored with executable-guide components, and the build pipeline strips them into plain README for npm publishing while keeping the original for the docs site.

**Acceptance Criteria:**
- [ ] `scripts/build-recipe-readmes.ts` (Alpha2 stub) is now active; emits per-recipe `README.md` (stripped, plain Markdown) from the MDX source.
- [ ] At least one canonical Alpha recipe ships an MDX-authored README that passes through the pipeline.
- [ ] Generated stripped READMEs do not contain executable-component artifacts and validate as plain Markdown.
- [ ] Tests pass; typecheck passes; lint passes.

### US-196: `bun run dev:guides` watch mode (executable guides as TDD driver)

> Numeric note: US-196–US-199 live outside this PRD's normal 175–182 range because they were added during the paradigm review that resolved the "guides as dev-time test driver" question. Story IDs elsewhere were preserved by appending rather than renumbering.

**Description:** As a developer using executable guides as the dev-time test driver, I can run `bun run dev:guides` (or `bun run dev:guides <path>` for a single guide) and the codegen + typecheck + scenario test loop re-runs on every change to MDX, generated TS, or production code the scenarios exercise.

**Acceptance Criteria:**
- [ ] `bun run dev:guides` watches `docs/guides/**/*.mdx`, `core/src/**`, `sdk/src/**`, `plugins/*/src/**`, and `scripts/build-guide-scenarios.ts`.
- [ ] On any change: re-runs `build-guide-scenarios` for the affected guide(s), re-runs `tsc --noEmit` on the generated path, re-runs the scenario tests for the affected guide(s) only (not the full workspace).
- [ ] Single-guide mode: `bun run dev:guides docs/guides/<path>.mdx` constrains the loop to that one guide for focused TDD.
- [ ] Source-mapped failures from PRD-A2-03 are surfaced in the watch output unchanged.
- [ ] Watch mode exits cleanly on SIGINT and produces no leftover `dist/` artifacts beyond a normal run.
- [ ] Tests cover: a fixture guide, the script invocation, a deliberately failing guide, the single-guide path.
- [ ] Tests pass; typecheck passes; lint passes.

### US-197: Beta feature coverage matrix (`docs/guides/INDEX.md`)

**Description:** As a maintainer, I can see at a glance which Beta features are covered by guides via an authored `docs/guides/INDEX.md` matrix that maps each user-facing PRD feature to the guide(s) that exercise it.

**Acceptance Criteria:**
- [ ] `docs/guides/INDEX.md` exists with a table: PRD | User Story | Feature | Guide Path | Status.
- [ ] At Beta cutover, every user-facing Beta PRD (01, 02, 03, 04, 05, 06, 07, 08, 10, 11) has at least one row in the matrix.
- [ ] `scripts/check-guide-coverage.ts` validates that every guide path in `INDEX.md` exists on disk, every PRD declared via §Guide Coverage section has its rows present in `INDEX.md`, and every `INDEX.md` row references a real `docs/guides/<path>.mdx` file.
- [ ] `bun run check:guide-coverage` is wired into the per-PR CI gate from Alpha2-04 US-070 between `lint:guides` and the test run.
- [ ] Tests cover: a green `INDEX.md`, a missing-guide-file failure, a missing-PRD-row failure, an INDEX row pointing at a non-existent guide.
- [ ] Tests pass; typecheck passes; lint passes.

### US-198: per-PRD `## Guide Coverage` section convention

**Description:** As a maintainer, every user-facing Beta PRD declares a `## Guide Coverage` section listing the guide paths that PRD owns, so the coverage matrix from US-197 is the union of those declarations.

**Acceptance Criteria:**
- [ ] Every user-facing Beta PRD (01, 02, 03, 04, 05, 06, 07, 08, 10, 11) has a `## Guide Coverage` section listing the guide paths owned by that PRD with a table mapping user stories to guide paths.
- [ ] PRDs not in scope for guides (09, 13) explicitly state `## Guide Coverage: None — internal/infra PRD.`
- [ ] `scripts/check-guide-coverage.ts` parses the §Guide Coverage section from each PRD and asserts every declared path exists in `docs/guides/` and appears in `INDEX.md`.
- [ ] A user-facing PRD that lacks the section, or declares a non-existent guide path, fails the gate.
- [ ] Tests cover: a PRD with a valid section, a PRD missing it, a PRD declaring a non-existent guide path, an internal PRD's "None" declaration.
- [ ] Tests pass; typecheck passes; lint passes.

### US-199: guide-drift CI gate

**Description:** As CI, when a PR touches files under a CLI/source surface declared in any PRD's §Guide Coverage section, the PR MUST also touch one of the listed guide files (or explicitly declare in the PR body why no guide change is needed).

**Acceptance Criteria:**
- [ ] `scripts/check-guide-drift.ts` reads §Guide Coverage sections from every PRD and identifies which CLI/source paths each set of guides covers.
- [ ] On a PR, the script diffs the PR's changed files against the declared CLI surface paths; if the PR touches any covered surface but doesn't touch the corresponding guide(s), the gate fails with a remediation message pointing at the PRD's §Guide Coverage section.
- [ ] Escape hatch: a PR body line `Guide-Coverage-Skip: <reason ≥ 24 chars>` bypasses the gate; the reason is recorded in the CI log and surfaced in the PR check summary.
- [ ] Wired as **blocking** into the per-PR CI gate from Alpha2-04 US-070, after `check-guide-coverage`.
- [ ] Tests cover: a touch-surface-without-guide PR (failure), a touch-both PR (pass), a guide-only PR (pass), a skip-tag PR (pass with logged reason), a too-short skip reason (failure).
- [ ] Tests pass; typecheck passes; lint passes.

## Functional Requirements

- FR-1: Beta executable-guide vocabulary covers `<Inspect>`, `<Tabs>`, `<Tab>`, `<Inline>`, `<Skip>`, plus code-emitting `<Hidden>`.
- FR-2: `axes:` + per-cell `variants:` express multi-axis matrices; codegen produces one test per cell.
- FR-3: `ScenarioContext.runCli` invokes the real CLI for scenario layer; e2e uses the compiled binary.
- FR-4: Full §19.10 lint set runs per-PR.
- FR-5: Recipe README strip/flatten pipeline emits stripped Markdown for at least one canonical recipe.
- FR-6: All new component schemas round-trip through the §13.2 snapshot gate.
- FR-7: `bun run dev:guides` provides a watch-mode TDD loop (full-workspace and single-guide modes) that re-runs codegen, typecheck, and scenario tests on change.
- FR-8: Every user-facing Beta PRD declares a `## Guide Coverage` section; the union forms `docs/guides/INDEX.md`. Internal/infra PRDs explicitly declare `None`.
- FR-9: The per-PR CI gate (Alpha2-04 US-070) is extended with two blocking steps: `check-guide-coverage` (asserts §Guide Coverage declarations match `INDEX.md` and on-disk files) and `check-guide-drift` (asserts PRs touching declared CLI surfaces also touch the listed guides, modulo the `Guide-Coverage-Skip` escape hatch).

## Non-Goals

- Public transcript rendering / Starlight docs site (RC).
- `layer: "e2e"` per-PR gate (Beta keeps it nightly Linux-x64 `@smoke` only).
- Custom matcher schemas beyond §19.3 (post-GA).
- Per-variant CI fan-out beyond a single static `@smoke` tag (RC).
- Library-mode guides (`<Run runtime="…" />`) — RC.
- Recipe README rendering at the docs site — RC (the docs site itself is RC+).

## Technical Considerations

- The MDX → JSX → typed-TS codegen pipeline from Alpha2 must remain deterministic across all new components; snapshot tests cover that.
- Multi-axis variant cartesian product can explode quickly — a sanity-cap (default: 64 cells per guide) prevents accidental matrix blow-up.
- The recipe README strip pipeline must handle frontmatter, `<Hidden>` blocks (removed entirely), and code blocks with `executable` markers (rendered as plain code).
- `ctx.runCli` swap from fake to real touches the existing Alpha2 generated tests — Beta must keep them green without regenerating from scratch.

## Success Metrics

- At least three guides ship using `<Tabs>` + axes; each generates the expected matrix without lint warnings.
- All Beta vocabulary schemas round-trip cleanly through the schema gate.
- At least one canonical recipe (e.g. Drupal) uses MDX README that strips successfully.
- `docs/guides/INDEX.md` has at least one row per user-facing Beta PRD at cutover; `bun run check:guide-coverage` exits 0 on every per-PR run.
- `bun run dev:guides` is the documented dev-time test driver in `AGENTS.md` and `core/AGENTS.md`; at least one Beta user story (any PRD) has its TDD demo recorded as a guide that landed before its implementation.

## Open Questions

- Should `<Tabs>` and `axes:` be redundant, or should `<Tabs>` simply be syntactic sugar over `axes:` with a single axis named `tab`? Default: sugar — same generator path, with the docs site picking up the tab-rendering hint.
- Should the variant cartesian cap (64 cells) be configurable per guide? Default: no — guides hitting the cap should split into multiple guides.
- Should `<Hidden>` be allowed inside `<Tab>`? Default: yes — but each `<Tab>` gets its own hidden scope.
