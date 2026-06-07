# PRD: ALPHA2-04 — Lint, CI gate, and conditional recipe README

## Introduction

This PRD covers the Phase 2.5 Alpha 2 **merge gates and conditional recipe README integration**. It ties the codegen (PRD-A2-02) and the author command (PRD-A2-03) into the per-PR CI pipeline established by Alpha 1 PRD-07, adds the minimal `bun run lint:guides` set the roadmap calls for, persists an internal transcript artifact per scenario run, and ships the recipe-README strip/flatten generator **only if** a canonical Alpha 1 recipe actually ships its README as MDX during Alpha 2.

Depends on: **PRD-A2-02, PRD-A2-03**.

## Source References

- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) — §19.6 transcripts, §19.10 lint and quality gates (Alpha 2 takes a minimal subset), §19.13 recipe README integration (conditional).
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) — §13.1 test layers, §13.4 merge gates.
- [`spec/alpha-1/prd-alpha-1-07-ci-distribution-and-release-channel.md`](../alpha/prd-alpha-1-07-ci-distribution-and-release-channel.md) — the CI baseline this PRD extends.

## Goals

- Add a focused per-PR CI gate that runs the new generator, the type check over generated paths, and the scenario tests.
- Add `bun run lint:guides` with the minimal Alpha 2 rule set (unique scenario ids, required `reason` on test-only scenarios, no rendered executable components in non-`tutorial`/`how-to` buckets).
- Persist an internal transcript JSON file per scenario run; do not render public transcripts.
- Ship `scripts/build-recipe-readmes.ts` strip/flatten **only if** an Alpha 1 recipe README under `recipes/<id>/README.mdx` contains executable components by the time this PRD lands. Otherwise the strip/flatten generator is deferred to Alpha 3.

## User Stories

### US-070: Add per-PR CI gate for guide scenarios

**Description:** As a maintainer, every PR runs the new generator + type check + scenario tests gate, and any drift between MDX and generated outputs fails the build.

**Acceptance Criteria:**
- [ ] `scripts/build-ci-workflow.ts` adds a new job (`guide-scenarios-linux-x64`) that runs after `static-checks` and in parallel with `provider-integration-linux-x64`.
- [ ] The job runs, in order: `bun install` → `bun run codegen` (which transitively runs `build-guide-scenarios`) → `bun run typecheck` → `bun run lint:guides` → `bun test test/scenarios/generated/guides/**`.
- [ ] The job is required for merge to `main`; the same rule is encoded in `.github/CODEOWNERS` or the repo's branch protection equivalent that PRD-Alpha 1-07 set up.
- [ ] The job runs only on `ubuntu-24.04` per the Alpha 1 CI pinning rule in `spec/ROADMAP.md` cross-cutting risks.
- [ ] The job uploads any failing scenario's internal transcript JSON (US-071) as a CI artifact with 7-day retention named `guide-scenario-transcripts-<run-id>.zip`.
- [ ] Tests cover the workflow generator: codegen regenerates `.github/workflows/ci.yml` with the new job; the existing `git diff --exit-code` drift gate from Alpha 1 PRD-07 passes.
- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass.

### US-071: Persist internal transcripts per scenario run

**Description:** As a CI consumer, every scenario run produces a deterministic JSON transcript I can attach to a failing PR for debugging.

**Acceptance Criteria:**
- [ ] The transcript stub from PRD-A2-01 US-059 becomes a real write to `dist/transcripts/guides/<guideId>/<scenarioId>.json` at scenario teardown.
- [ ] Schema (Effect Schema, lives in `sdk/src/docs/transcript.ts`, round-trips through the §13.2 schema gate): `{ guideId, scenarioId, render: boolean, startedAt: ISO8601, finishedAt: ISO8601, durationMs, exitStatus: "pass" | "fail", frames: TranscriptFrame[] }`.
- [ ] `TranscriptFrame` is one of `{ kind: "run", command, stdout, stderr, exit, durationMs }`, `{ kind: "verify", target: "event" | "file" | "errorTag", matched: true | false, expected, actual }`, `{ kind: "fixture", name, copiedTo }`, or `{ kind: "cleanup", command, exit }`.
- [ ] Transcripts apply the §19.6 redaction rules: the existing `pre-shell-exec` policy is reused; absolute `testDir` paths are rewritten to a stable placeholder (e.g. `<testDir>`); timestamps in stdout/stderr are masked.
- [ ] Transcripts are gitignored (`dist/` is already gitignored — verify the path lands under there).
- [ ] Tests cover: a green scenario produces a well-formed transcript that schema-validates; a red scenario writes a transcript whose `exitStatus === "fail"` and whose failing frame matches the assertion that failed; redaction strips a fixture stdout containing each redaction class.
- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass.

### US-072: Implement minimal `bun run lint:guides`

**Description:** As a maintainer, `bun run lint:guides` checks the Alpha 2 hard rules and fails the build if any guide violates them.

**Acceptance Criteria:**
- [ ] `scripts/lint-guides.ts` is the entry point, registered as `"lint:guides"` in `package.json#scripts`.
- [ ] Rules enforced in Alpha 2 (every violation is a non-zero exit with a source-mapped error frame): (1) frontmatter validates against `GuideFrontmatter`; (2) every `<Scenario id>` is unique within a guide; (3) every test-only `<Scenario render={false}>` declares `reason` (≥ 8 chars); (4) every `<Step name>` is unique within its containing scenario; (5) no Alpha-3-only component appears anywhere; (6) `diataxis:` (when present) is `tutorial` or `how-to` for any guide containing a rendered scenario.
- [ ] Rules NOT enforced in Alpha 2 (deferred to Alpha 3 with a comment in `lint-guides.ts` linking back to this PRD): display:execute divergence cap (§19.5), `<Verify>` matcher-schema deep validation (the schema validation happens at codegen time in PRD-A2-02 US-063; lint defers the standalone-pass coverage), event-name registry membership (no registry exists in Alpha 2), `<Inline>` density caps, `<Hidden>` content shape (since `<Hidden>` is uniformly schema-rejected per PRD-A2-01 US-061).
- [ ] Lint runs in the CI gate from US-070 between `bun run typecheck` and the test run.
- [ ] Tests cover one fixture per rule under `core/test/lint/guides/`: a green guide that satisfies all rules, plus one deliberately-broken guide per rule with the expected error frame.
- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass.

### US-073 (conditional): Implement recipe README strip/flatten

**Description:** As a recipe author shipping a `recipes/<id>/README.mdx`, the scaffold step copies a prose-only Markdown version into the user's project, while the MDX still generates scenario tests.

**Status:** **Conditionally in scope.** Required only if any Alpha 1 recipe (PRD-04 deliverables) ships its README as MDX containing executable components by the time this PRD lands. If no Alpha 1 recipe README is MDX, this story is closed as "Not applicable in Alpha 2; deferred to Alpha 3 per §19.13" and the strip/flatten generator is not implemented.

**Acceptance Criteria (when in scope):**
- [ ] `scripts/build-recipe-readmes.ts` is registered in the codegen catalog after `build-guide-scenarios`.
- [ ] For each `recipes/<id>/README.mdx` that contains a `<Guide>`, the script writes `recipes/<id>/.scaffold/README.md` (Alpha 2 emits a single prose-only output; the per-axis-value cell-product output from §19.13 is Alpha 3+ because Alpha 2 has no axes).
- [ ] Strip rules per §19.13: `<Guide>` unwraps; rendered `<Scenario>` unwraps; `<Step>` becomes a numbered heading; `<Run command>` becomes a fenced bash block of the displayed command; `<Verify>`, `<Hidden>`, and test-only scenarios are omitted; `<Variable>` is replaced by `display` (falling back to `value`); `<Cleanup>` becomes a final "Cleanup" Markdown section.
- [ ] The recipe scaffold path (PRD-04 US-031 in Alpha 1) reads `.scaffold/README.md` if present, falling back to `README.md` otherwise.
- [ ] Tests cover: a fixture recipe with one reader scenario and one hidden scenario produces a `.scaffold/README.md` containing only the reader steps; no `<` JSX leaks; no unresolved `{{variable}}` placeholders; the corresponding MDX still generates scenario tests via the PRD-A2-02 generator.
- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass.

**Decision-tree:** This story's status is decided in the PR series that opens Alpha 2. If at PR-open time no `recipes/*/README.mdx` exists with executable components, the maintainer marks the story closed in the PR description and updates `progress.txt` (mirroring `spec/alpha-1/progress.txt`) to reflect deferral.

## Functional Requirements

- The CI gate MUST fail the build if any of: codegen exits non-zero, `tsc --noEmit` over generated paths reports any error, `bun run lint:guides` reports any violation, any generated scenario test fails.
- Internal transcripts MUST be redaction-clean before they are written to disk; redacting on read is not acceptable because transcripts are CI artifacts.
- The lint rules implemented in US-072 are an explicit allow-list; adding any new rule is a Alpha-3-or-later change that requires a new PRD story.
- The conditional recipe README story (US-073) MUST NOT block the rest of Alpha 2 from merging — if it is closed as "not applicable", the Alpha 2 set still exits.

## Non-Goals

- No render of public transcripts. The internal transcript artifact is the only Alpha 2 transcript surface.
- No Starlight integration, no `<Inspect>` snapshots, no `<Tabs>`/axis fan-out, no per-variant CI matrix.
- No watch mode beyond the inner author command from PRD-A2-03 (`bun run dev:guides` is Alpha 3+).
- No nightly cron, no multi-platform matrix, no provider matrix change. Alpha 2's CI gate runs only on `ubuntu-24.04` per-PR.
- No `lint:guides` rules beyond the six enumerated in US-072.
- No alias for `bun run lint:tutorials`. Spec-owned name only.
- No public docs site rendering of guides or transcripts.

## Technical Considerations

- The CI workflow file `.github/workflows/ci.yml` is generated from `scripts/build-ci-workflow.ts` — hand edits are forbidden. The drift gate from Alpha 1 PRD-07 still applies.
- Transcripts under `dist/transcripts/guides/` MUST land under the existing `dist/` gitignore rule. Adding a separate path is unnecessary and risks shadowing the rule.
- Reuse the Alpha 1 PRD-05 redaction module rather than introducing a parallel one. If divergence is needed, surface it as a separate PR with an explicit decision rather than copy-pasting.
- Lint rule (6) (`diataxis:` value) only fires when the frontmatter sets `diataxis:`. Alpha 2 guides MAY omit it; the rule applies only when present.
- US-073's conditional gate is decided **once** at PR-open time. Do not re-evaluate mid-series — that creates a moving merge target.

## Success Metrics

- Every (in-scope) user story in this PRD is accepted with its tests merged.
- `bun run typecheck`, `bun run lint`, and `bun test` pass for the whole workspace.
- The Alpha 2 CI gate is green on the merge of the canonical fixture guide from PRD-A2-02 US-066, and a deliberate seeded failure produces a transcript artifact under the workflow run.
- If US-073 is in scope, at least one recipe ships an MDX README and its `.scaffold/README.md` passes a "no JSX leak" assertion.

## Open Questions

- The decision threshold for promoting a recipe README from `.md` to `.mdx` is owned by Alpha 1 PRD-04. Alpha 2 only reacts to that choice — it does not push for one.
- Whether internal transcripts should later feed the perf-budget suite from §13.1. Out of scope for Alpha 2; mention only because the transcript schema already records `durationMs` for forward compat.
- Whether to add a `--bail` flag to the author command from PRD-A2-03 to short-circuit the lint+test pair locally. Not opened as a story until at least one author requests it.
