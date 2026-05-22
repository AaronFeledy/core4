# PRD: ALPHA2-01 — Guide schema and ScenarioContext

## Introduction

This PRD covers Phase 2.5 Alpha 2 work for **Guide frontmatter, the Alpha 2 component vocabulary, and the `ScenarioContext` testing seam**. It defines the contracts every later Alpha 2 PRD depends on: the `GuideFrontmatter` schema, the prop schemas for the nine Alpha 2 components, the `ScenarioContext` shape that generated scenarios receive at runtime, and the fixture-copy discipline.

Nothing in this PRD compiles MDX, runs tests, or touches CI. It only fixes the shapes.

Depends on: **Alpha PRD-06** (the `@lando/core/testing` surface and `TestRuntimeProvider` must already exist).

## Source References

- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) — §19.2 (frontmatter), §19.3 (component vocabulary), §19.4 (`ScenarioContext`), §19.9 (hidden/fixture discipline).
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) — §13.1 test layers; §13.2 schema gate.
- [`spec/16-deprecation-and-surface-evolution.md`](../16-deprecation-and-surface-evolution.md) — `DeprecationNotice` shape referenced by `GuideFrontmatter.deprecated` (schema-only in Alpha 2).
- `core/test/library/**` and `@lando/core/testing` — existing testing surface produced by Alpha PRD-06.

## Goals

- Publish the `GuideFrontmatter` schema in `@lando/sdk` covering only the keys Alpha 2 needs.
- Publish prop schemas for the nine Alpha 2 components in `@lando/sdk/docs/components` and re-export them from `@lando/core/docs/components`.
- Define `ScenarioContext` and ship its construction helper in `@lando/core/testing` so generated scenarios have one stable shape to import.
- Codify fixture-copy semantics so fixtures stay immutable and per-scenario temp directories are deterministic.
- Reject Beta-only frontmatter keys and Beta-only components at schema time with remediation pointing at the deferred-features list in PRD-A2-00.

## User Stories

### US-057: Publish Alpha 2 `GuideFrontmatter` schema

**Description:** As a guide author, I can validate my MDX frontmatter against `GuideFrontmatter` and receive a typed remediation when I use a Beta-only key.

**Acceptance Criteria:**
- [ ] `GuideFrontmatter` Effect Schema lives in `sdk/src/docs/guide-frontmatter.ts` and is re-exported by `@lando/sdk/docs/components` and `@lando/core/schema`.
- [ ] Accepted keys: `id` (kebab-case, required), `defaultLayer` (only `"scenario"` accepted in Alpha 2; `"e2e"` is schema-rejected with a Beta remediation referencing §19.11), `provider` (only `"test"` accepted in Alpha 2), `timeout` (positive integer ms, default 60000), `platforms`, `tags`, `skip` (`{ reason, until? }`), and `deprecated` (`DeprecationNotice`, schema-only — no runtime propagation in Alpha 2).
- [ ] Schema-rejected keys with explicit remediation: `tabs`, `axes`, `variants`. Each rejection includes a tagged `NotImplementedError` payload citing §19.16 and the Beta phase per the PRD-A2-00 deferred list.
- [ ] Round-trips through the §13.2 schema gate (Alpha PRD-07 gate) — encode/decode/JSON Schema all stable.
- [ ] Tests cover happy-path acceptance, each Beta-only key rejection, and the `id` kebab-case rule.
- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass.

### US-058: Publish Alpha 2 component prop schemas

**Description:** As a guide author, every Alpha 2 component has a published prop schema that round-trips through encode/decode and a `MatcherSchema` subset suitable for `<Verify>` in Alpha 2.

**Acceptance Criteria:**
- [ ] Prop schemas exist for `<Guide>`, `<Scenario>`, `<Step>`, `<Run>`, `<Verify>`, `<Cleanup>`, `<Variable>`, `<Hidden>`, `<UseFixture>` in `sdk/src/docs/components/*.ts` and are re-exported from `@lando/sdk/docs/components` and `@lando/core/docs/components`.
- [ ] `ScenarioProps` accepts `id` (required), `render` (default `true`), `reason` (required when `render === false`, ≥ 8 chars), `tags`, `layer` (Alpha 2 accepts `"scenario"` only; `"e2e"` rejected with Beta remediation).
- [ ] `RunProps` accepts exactly one of `command` (CLI) or `shell` (Bun Shell). `runtime` and `tooling` variants are schema-rejected with §19.14 / Beta remediation.
- [ ] `VerifyProps` accepts exactly one of `event`, `command`, `file`, `errorTag`. `tooling` and `runtime` variants are schema-rejected with Beta remediation. The `expect` value validates against an Alpha 2 `MatcherSchema` subset: scalar deep-equal, partial-object match, plus `regex`, `schema`, `anyOf`, `not` operators. `exact`, `allOf`, `oneOf` are Beta+.
- [ ] `HiddenProps` parses (so MDX with `<Hidden reason="…">` does not crash the schema) but every generator path treats it as a typed `NotImplementedError(commandId: "guide.component.hidden", specSection: "§19.3")` with remediation pointing at `<Scenario render={false}>` per the PRD-A2-00 deferred list.
- [ ] `VariableProps` requires `name` and `value`; `display` is optional. Display-vs-execute divergence is permitted at schema level; the 25% lint cap (§19.5) is deferred to PRD-A2-04 lint scope review.
- [ ] `UseFixtureProps` requires `name`; the resolved fixture path is resolved by `ScenarioContext.fixtures` at runtime, not at schema time.
- [ ] Every schema round-trips through the §13.2 schema gate.
- [ ] Tests cover each schema's accept set and at least one rejection path with remediation text assertion.
- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass.

### US-059: Ship `ScenarioContext` and Alpha 2 testing helpers

**Description:** As a generated scenario, I can `import { withScenarioContext } from "@lando/core/testing"` and receive a stable `ScenarioContext` with the Alpha 2 field set.

**Acceptance Criteria:**
- [ ] `ScenarioContext` interface and its Effect tag live in `core/src/testing/scenario-context.ts` and are re-exported from `@lando/core/testing`.
- [ ] Alpha 2 fields: `guideId`, `scenarioId`, `testDir` (created under `os.tmpdir()` at scope acquire, removed at finalize unless `KEEP_SCENARIO_DIRS=1`), `runtime` (a `TestRuntime` from Alpha PRD-06), `vars` (`Map<string, { value: string; display?: string }>`), `runCli`, `events`, `transcript` (write-only stub — full transcript surface is in PRD-A2-04), `fixtures`.
- [ ] Deferred fields (declared in the type for forward-compat but throwing `NotImplementedError` at use): `variant` (returns `{}` Alpha 2 always), `shell` (`<Run shell="…">` is schema-accepted but the runtime helper throws Alpha 2 remediation).
- [ ] `withScenarioContext({ guideId, scenarioId }, body)` is a `scoped` Effect that creates `testDir`, builds the rest of the context, runs `body`, and runs all `Cleanup` finalizers before tearing down.
- [ ] `runCli` invokes the CLI via the existing Alpha PRD-06 in-process runner (not a subprocess). Captured `stdout`, `stderr`, `exitCode`, and the published `events` stream are recorded in the active transcript stub.
- [ ] Tests exercise `withScenarioContext` end-to-end with a fake `Run` that calls a no-op CLI and verify `testDir` is removed on success and preserved when `KEEP_SCENARIO_DIRS=1` is set.
- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass.

### US-060: Codify fixture-copy discipline

**Description:** As a guide author using `<UseFixture name="…">`, the named fixture directory is copied into `ScenarioContext.testDir` before any mutation and is treated as immutable in its source location.

**Acceptance Criteria:**
- [ ] `ScenarioContext.fixtures.use(name)` resolves to `<testDir>/<name>` after deep-copying the immutable source directory at `docs/guides/<guideId>/fixtures/<name>` or `docs/guides/fixtures/<name>` (per-guide fixtures override shared fixtures).
- [ ] Tests cover: copy happens before first mutation; mutating the copy does not mutate the source; missing fixture surfaces a tagged `GuideFixtureNotFoundError` with the resolved candidate paths.
- [ ] Tests cover: when two `<UseFixture name="…">` calls in the same scenario reference the same name, the second call is a no-op (already copied) — not a re-copy and not a silent overwrite.
- [ ] Fixture sources are gitignored only if they contain generated artifacts; otherwise they are committed. The Alpha 2 set commits fixtures verbatim.
- [ ] Symbolic links inside fixtures are rejected at copy time with a tagged `GuideFixtureSymlinkError` (security guardrail for later sandboxing work).
- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass.

### US-061: Reject `<Hidden>` at SDK boundary with remediation

**Description:** As a guide author who writes `<Hidden reason="…">` in Alpha 2, I get a typed, source-mapped error directing me at `<Scenario render={false}>` rather than a silent ignore.

**Acceptance Criteria:**
- [ ] A central `assertAlpha2Component(componentName, hostPath)` helper in `@lando/sdk/docs/components` throws `NotImplementedError(commandId: "guide.component.hidden", specSection: "§19.3")` whose remediation reads (verbatim, including the phase name): "Move this coverage into a colocated `<Scenario render={false}>` per §19.9. `<Hidden>` ships in Phase 3 Beta — see `spec/ROADMAP.md`."
- [ ] The helper is also wired to reject any non-Alpha-2 component name (`<Inspect>`, `<Tabs>`, `<Tab>`, `<Inline>`, `<Skip>`) with a one-line remediation citing the same phase + roadmap reference.
- [ ] Tests cover each rejected component name and exact remediation text.
- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass.

## Functional Requirements

- Implement only the Alpha 2 schema and testing-helper surface assigned to this PRD; no MDX parsing, no codegen, no CLI changes.
- Every Effect Schema added here MUST be re-exported through both `@lando/sdk/docs/components` and `@lando/core/docs/components` so MDX tooling (later) and tests (now) can import from one place.
- Every tagged error MUST follow the existing `NotImplementedError` payload contract (`commandId`, `specSection`, `remediation`) so the same renderer paths used by the rest of the CLI light up unchanged.
- `ScenarioContext` MUST be importable from `@lando/core/testing` only — never from the default `@lando/core` entry — to preserve the §16.2 import-boundary discipline.
- All new schema files MUST be schema-gated by Alpha PRD-07's snapshot diff.

## Non-Goals

- No MDX parsing, no AST walker, no generator. Those are PRD-A2-02.
- No author command, no source-mapper reporter. Those are PRD-A2-03.
- No lint, no CI gate, no transcript persistence beyond the stub writer. Those are PRD-A2-04.
- No multi-axis support (`tabs:`/`axes:`/`<Tabs>`), no library-mode `<Run runtime="…">`, no `<Inspect>` snapshots, no `<Inline>` injection, no `<Skip>` propagation. These are Beta+.
- No `<Hidden>` codegen. The component is recognized and explicitly rejected with remediation.
- No public transcript shape beyond what the stub writer needs. Public transcripts and recipe README strip/flatten are scoped per PRD-A2-04 conditional rules.
- No `DeprecationNotice` runtime propagation. The schema field exists; the runtime path lands at RC.

## Technical Considerations

- The on-disk file path is `spec/17-executable-tutorials.md`; the spec body numbers the section as **§19** because the doc title is "Part 17 — Executable Guides and Scenarios". References in code, errors, and tests SHOULD use the body-numbered `§19.*` form for user-facing text and the on-disk `spec/17-…` form for repo paths. PRDs MAY use either; do not bikeshed.
- `core/src/testing/` MUST NOT pull anything from `core/src/cli/oclif/**`. The import-boundary test from Alpha PRD-06 should already catch this.
- Fixture directory walking SHOULD use the existing `FileSystem` service rather than `node:fs/promises` directly so the same hooks the rest of the runtime uses cover fixture I/O.
- `withScenarioContext` MUST be an Effect with a `Scope` finalizer, not a plain `try/finally`, so generated tests can compose multiple `<Cleanup>` blocks without manual ordering.
- Keep the `MatcherSchema` Alpha 2 subset narrow on purpose. Adding `exact`/`allOf`/`oneOf` later is an additive change; removing them is a breaking change to `@lando/sdk`.

## Success Metrics

- Every user story in this PRD is accepted with its tests merged.
- `bun run typecheck`, `bun run lint`, and `bun test` pass for the whole workspace.
- The schema-snapshot gate (Alpha PRD-07) accepts the new Alpha 2 schemas without manual fixture edits beyond the snapshot diff.
- No story in this PRD increases the public API surface of `@lando/core` outside `/docs/components`, `/testing`, and `/schema`.

## Open Questions

- Final decision on whether shared fixtures live at `docs/guides/fixtures/` or are forbidden in Alpha 2 (forcing each guide to own its fixtures). Default in US-060 is "per-guide overrides shared", revisit if any Alpha guide needs a shared one.
- Whether `runCli` should default to the in-process runner from Alpha PRD-06 unconditionally, or accept a `subprocess: true` option for guides that explicitly want to exercise the compiled binary. Alpha 2 default is in-process only; subprocess form deferred unless a guide needs it.
