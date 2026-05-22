# PRD: ALPHA2-03 — Author command and source-mapper reporter

## Introduction

This PRD covers Phase 2.5 Alpha 2 work for the **`bun run docs:scenario <guideId>` author/debug command and the `scripts/test-reporters/scenario-source-mapper.ts` reporter**. Together they close the author loop: a guide author can run one scenario without running every guide test, see failures mapped back to MDX coordinates rather than generated `.ts` paths, and copy-paste a re-run command from any failure line.

Depends on: **PRD-A2-02** (generated TypeScript with `// @source` headers exists).

## Source References

- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) — §19.8 source-location preservation, §19.12 author commands.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) — `bun test` runner conventions.
- [PRD-A2-02 US-063](./prd-alpha2-02-mdx-codegen-pipeline.md) — the generated-file header format this PRD consumes.

## Goals

- Ship `bun run docs:scenario <guideId>` with the Alpha 2 flag subset from the roadmap (`--scenario`, `--keep`, `--debug`, `--explain`).
- Ship `scripts/test-reporters/scenario-source-mapper.ts` and wire it into `bun test` for any test path under `test/scenarios/generated/guides/**`.
- Every failure from a generated guide test prints a primary frame pointing at the MDX source (file + line + scenario id), with the generated `.ts` line preserved as a secondary annotation.
- Failure output includes a copy-pasteable re-run command for the specific scenario.

## User Stories

### US-067: Implement `bun run docs:scenario <guideId>` command

**Description:** As a guide author, I can run one guide's scenarios from the repo root in one command without re-running the whole `bun test` suite.

**Acceptance Criteria:**
- [ ] `scripts/docs-scenario.ts` is the entry point and is wired into `package.json#scripts` as `"docs:scenario": "bun run scripts/docs-scenario.ts"`.
- [ ] Invoked as `bun run docs:scenario <guideId>`, it runs `build-guide-scenarios` for that guide only (a `--only <guideId>` flag is added to the generator from PRD-A2-02 in this PR), then invokes `bun test test/scenarios/generated/guides/<guideId>/`.
- [ ] `--scenario <id>` narrows to one scenario by routing to the matching generated file.
- [ ] `--keep` exports `KEEP_SCENARIO_DIRS=1` for the inner `bun test` invocation and prints, on completion, the temp directory path (read back from the transcript stub from PRD-A2-01 US-059).
- [ ] `--debug` prints the generated test path, the resolved MDX→TS source map, the resolved `<Variable>` `value`/`display` map, and the fixture copy map (which fixture name resolved to which absolute path under `testDir`).
- [ ] `--explain` prints the MDX → scenario plan (steps, fixture uses, finalizers) without running the test; exits 0.
- [ ] Unknown flags and Beta-only flags (`--variant`, `--step`, `--fixture`, `--update-transcript`) fail with a `NotImplementedError` whose remediation names Phase 3 Beta and references `spec/ROADMAP.md`.
- [ ] Tests cover: success exit on a green guide, non-zero exit on a red guide, `--explain` output snapshot, `--debug` output snapshot, unknown-flag rejection.
- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass.

### US-068: Implement the scenario source-mapper reporter

**Description:** As a guide author seeing a failure from a generated guide test, the reporter rewrites the failure's primary stack frame to point at the MDX line for the failing assertion.

**Acceptance Criteria:**
- [ ] `scripts/test-reporters/scenario-source-mapper.ts` is registered as a `bun test` reporter for any test path matching `test/scenarios/generated/guides/**/*.test.ts`.
- [ ] For every failing assertion, the reporter walks the failure's stack frames; for each frame in a generated guide test file, it scans backward from that line for the nearest `// @source`, `// @scenario`, and (Alpha 2 always-empty) `// @variant` headers.
- [ ] The reporter rewrites the primary frame to `<source-relative-mdx-path>:<line>` and prefixes the failure description with `[<guideId>:<scenarioId>] `.
- [ ] The generated `.ts:line` frame is preserved as a secondary "Generated:" annotation below the rewritten primary.
- [ ] If the failure's frame is not inside a generated guide test file, the reporter leaves the output untouched.
- [ ] Reporter is test-covered by fixture pairs under `core/test/scenarios/reporter/`: each pair is `(input.txt, expected.txt)` where `input.txt` is a seeded Bun-test failure output and `expected.txt` is the rewritten form.
- [ ] Tests cover: a single-frame failure, a multi-frame failure with intervening node-modules frames, and a no-match failure (raw Bun-test path that is not under generated guides).
- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass.

### US-069: Print copy-pasteable re-run command on failure

**Description:** As a guide author looking at a CI failure log, I can copy the last line of the failure block and re-run that exact scenario locally.

**Acceptance Criteria:**
- [ ] On every failed generated guide test, the source-mapper reporter appends (after the rewritten frames) a single line: `Re-run: bun run docs:scenario <guideId> --scenario <scenarioId>`.
- [ ] The reporter resolves `<guideId>` and `<scenarioId>` from the same headers it used for the rewrite — it MUST NOT regex the file path, because path layout may change in Beta when variants land.
- [ ] If the reporter cannot determine either id (corrupt headers, missing `@scenario`), it falls back to `Re-run: bun run docs:scenario <guideId>` (whole-guide form) and emits a tagged warning frame so generator bugs surface.
- [ ] Tests cover: happy path, missing-`@scenario` fallback, missing-`@source` fallback (whole-guide form), and a sanity check that the re-run line is the **last** line of the failure block — so terminals that truncate from the top still keep it visible.
- [ ] `bun run typecheck`, `bun run lint`, `bun test` pass.

## Functional Requirements

- The author command MUST exit non-zero whenever any selected scenario fails. No "best effort" green when one scenario errors and others pass.
- The reporter MUST be a pure additive layer over the existing `bun test` output — disabling it (by setting `LANDO_DISABLE_GUIDE_SOURCE_MAPPER=1`) MUST restore the raw `bun test` output unchanged, so the reporter's correctness can be falsified in CI by toggling it.
- The author command and the reporter MUST NOT introduce a runtime dependency on anything inside `core/src/cli/oclif/**`. They are dev/test surface only.
- The author command MUST work from any CWD inside the workspace (use `Bun.resolveSync` or workspace-root discovery; do not require a fixed CWD).
- All flag names MUST match §19.12 exactly to keep author muscle memory portable across the Alpha 2 → Beta transition even when Beta unblocks `--variant`/`--step`/`--fixture`.

## Non-Goals

- No `--variant`, `--step`, `--fixture`, or `--update-transcript` flag behavior. They are recognized only to print a Beta-deferred remediation.
- No transcript embedding in the docs site. Transcripts are still test-side only (PRD-A2-04 owns the internal-transcript persistence).
- No interactive picker if `<guideId>` is omitted — the command prints `lando docs:scenario <guideId> [--scenario <id>]` usage and exits 2. An interactive picker is Beta+.
- No coverage for non-generated tests. The reporter is a no-op outside `test/scenarios/generated/guides/**`.
- No alias for the older `mdx-source-mapper` reporter name. Spec-owned name only.
- No watch mode in Alpha 2. `bun run dev:guides` is Beta+ unless a story explicitly pulls it forward.

## Technical Considerations

- The reporter MUST be resilient to multi-line stack frames from Effect (`FiberFailure`, `Cause.pretty`). It walks frames, not lines.
- The author command's `--debug` output IS user-facing API in practice — pinning it under a snapshot test is the cheapest way to keep it stable across PRs.
- `KEEP_SCENARIO_DIRS=1` already controls per-scenario temp dir retention from PRD-A2-01 US-059; the author command's `--keep` only sets that variable for the spawned `bun test`. The author command MUST NOT shadow or rename the env var.
- The reporter MUST tolerate the always-empty `// @variant:` header without misclassifying it as missing. Bug surface is high here because the placeholder will only have content starting in Beta.

## Success Metrics

- Every user story in this PRD is accepted with its tests merged.
- `bun run typecheck`, `bun run lint`, and `bun test` pass for the whole workspace.
- On a deliberately broken guide from US-066, both `bun run docs:scenario node-postgres` and a normal `bun test` invocation produce failure output whose primary frame points at the MDX file and whose last line is the copy-pasteable re-run command.

## Open Questions

- Whether the source-mapper reporter is on by default for the entire `bun test` invocation or only for the author command. Default in US-068 is "on by default for any matching path" — revisit only if it noticeably slows other test paths in CI (the reporter is a pure post-processor so this should be cheap).
- Whether the re-run command from US-069 should include the path to the project root for users running CI logs out of subdirectories. Alpha 2 prints the workspace-relative form; CI runners that cd before running `bun run docs:scenario` will need the same CWD.
