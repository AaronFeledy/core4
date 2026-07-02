# PRD: ALPHA4-07 — Executable guides & scenarios (full)

## Introduction

Executable guides and scenarios (§19 / `spec/17-executable-tutorials.md`, plus §13 CI gates) are the contract that keeps user docs and generated scenario tests in sync. Alpha 2 and Alpha 3 already shipped the engine: `GuideFrontmatter`, singleton scenario generation, `ScenarioContext`, MDX-to-generated-scenario TypeScript, source mapping, minimal guide lint, internal transcripts, fixture-copy discipline, the full component vocabulary, real `<Hidden>`, multi-axis variants, real `runCli`, `dev:guides`, guide coverage and drift gates, and recipe README strip-and-flatten.

Alpha 4 is the final increment. It ships public reader transcripts for visible frames, docs-site consumption of those frames, library-mode guides through `<Run runtime="...">`, per-PR scenario variants on every supported platform, an `@smoke` e2e guide-scenario subset on linux-x64, hardened lint gates, public transcript redaction and determinism, and one canonical guide that proves the full path.

Depends on: **Alpha 3 PRD-12** (the executable guide engine and guide coverage/drift gates).

## Source References

- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) §19 entire part.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1, §13.4, and §13.6 executable guide test layers and CI gates.
- [`spec/09-embedding.md`](../09-embedding.md) §16 library and embedding API.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17.2 guide and recipe README codegen entries.

## Goals

- Publish public reader-scenario transcript frames while keeping hidden blocks, test-only scenarios, fixtures, and internal event traces private.
- Let the Starlight docs site render public transcript frames from the same scenario output used by tests.
- Support library-mode guide scenarios that target `@lando/core` APIs, not only CLI commands.
- Run every scenario-layer variant on every supported platform in PR CI, plus a linux-x64 `@smoke` e2e subset against a real provider.
- Harden guide lint, source mapping, redaction, determinism, and final acceptance for supported platforms.

## User Stories

### US-243: Public reader-scenario transcript emission

**Description:** As a docs author, I need generated guide scenarios to emit public transcript frames that match what readers should see while excluding hidden and test-only execution details.

**Acceptance Criteria:**

- [ ] Scenario generation emits a public transcript artifact for visible `<Step>`, `<Run>`, `<Verify>`, `<Inspect>`, `<Cleanup>`, `<Inline>`, `<Tabs>`, and `<Tab>` reader frames.
- [ ] `<Hidden>`, test-only scenarios, fixtures, fixture-copy paths, raw temp dirs, internal event traces, and cleanup-only internals are excluded from public frames.
- [ ] Public frames preserve guide id, scenario id, variant, runtime, source file, source line, display text, command display text, and visible result summary.
- [ ] Internal transcripts continue to capture full execution data for tests without leaking into public docs output.
- [ ] Source headers and source-mapper reporter still attribute failures to the authoring MDX file and line.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-244: Starlight consumption of public transcript frames

**Description:** As a reader, I want the docs site to show verified guide outputs from public transcript frames instead of static examples that can drift from tests.

**Acceptance Criteria:**

- [ ] The Starlight docs pipeline consumes public transcript artifacts and renders them in the matching guide scenario blocks.
- [ ] Missing public transcript artifacts fail docs build or guide lint for shipped guides that require transcripts.
- [ ] Hidden blocks, test-only scenarios, fixtures, and internal traces remain absent from rendered docs HTML.
- [ ] Variant-aware transcript rendering selects the correct frame set for tabs and axes.
- [ ] Docs output links transcript frames back to the guide source section where the scenario is authored.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-245: Library-mode guides through `<Run runtime="...">`

**Description:** As an embedding user, I need executable guides that can exercise `@lando/core` library APIs through `<Run runtime="...">`, not just shell CLI commands.

**Acceptance Criteria:**

- [ ] `<Run runtime="library">` or the exact §19 runtime-target spelling generates scenario code that imports and executes `@lando/core` library APIs.
- [ ] Library-mode guide runs receive a complete `ScenarioContext` with `guideId`, `scenarioId`, `variant`, `testDir`, `runtime`, `vars`, `shell`, `events`, `transcript`, and `fixtures`.
- [ ] Library-mode guide runs can use `@lando/core/testing` helpers without routing through `runCli`.
- [ ] Display-vs-execute binding stays explicit; author-visible prose is never inferred from library code.
- [ ] Library-mode failures preserve MDX file and line ownership through source headers and the source-mapper reporter.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-246: `layer: "e2e"` `@smoke` guide-scenario subset

**Description:** As a release maintainer, I need a small e2e guide-scenario subset that runs against a real provider on linux-x64 so executable guides prove the provider path too.

**Acceptance Criteria:**

- [ ] Guide frontmatter or scenario props support `layer: "e2e"` and an `@smoke` marker for the e2e subset.
- [ ] The linux-x64 CI job runs the `@smoke` e2e guide-scenario subset against a real provider with credentials and provider availability explicitly gated.
- [ ] Local runs skip e2e guide scenarios with a clear message when the provider gate is absent.
- [ ] E2e guide scenarios still use generated TypeScript from MDX and still emit internal transcripts and public transcript frames where visible.
- [ ] Provider failures are reported as scenario failures with source-mapped MDX ownership.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-247: Per-PR CI scenario variants on every supported platform

**Description:** As a maintainer, I need every scenario-layer guide variant to run on every supported platform in PR CI so platform-specific docs drift is caught before merge.

**Acceptance Criteria:**

- [ ] The per-PR CI matrix runs scenario-layer executable guide variants on `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `windows-x64`.
- [ ] Multi-axis variants generate distinct test cases or files that CI can shard and report by guide id, scenario id, and variant.
- [ ] Platform-specific skips must be explicit in guide metadata and visible in CI output.
- [ ] Generated scenario tests remain gitignored and reproducible from the MDX source.
- [ ] CI failure annotations point at the source MDX file and line, not only the generated TypeScript file.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-248: Full `lint:guides` quality gates

**Description:** As a docs maintainer, I need `bun run lint:guides` to block guide patterns that make public docs and executable scenarios drift apart.

**Acceptance Criteria:**

- [ ] Raw fenced shell blocks are forbidden inside `<Guide>` content unless wrapped in the approved display-only component form from §19.
- [ ] Display-vs-execute binding is required for every executable `<Run>`, with no inferred command rewriting.
- [ ] Hidden blocks, test-only scenarios, fixtures, and internal traces are excluded from public transcript output by linted rule, not convention.
- [ ] Source mapping metadata is required for every generated scenario block and fails lint when missing.
- [ ] `bun run lint:guides` remains the merge-blocking gate for guide content, fixtures, component props, transcript references, and source-map coverage.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-249: Public transcript redaction and determinism

**Description:** As a reader and reviewer, I need public transcript frames to be stable across machines and free of local paths, secrets, hostnames, and other machine-specific data.

**Acceptance Criteria:**

- [ ] Public transcript redaction removes or normalizes temp dirs, home dirs, app roots, fixture roots, hostnames, usernames, tokens, secrets, random ports, generated container ids, and provider-specific ids.
- [ ] Transcript snapshots are deterministic across supported platforms for the same guide variant.
- [ ] Redaction runs before docs-site consumption and before public transcript artifacts are written.
- [ ] Internal transcripts may keep richer diagnostic detail, but public transcript tests prove the public artifact excludes private fields.
- [ ] A fixture suite covers POSIX, Windows, provider-specific, and library-mode transcript redaction.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-250: Canonical guide acceptance path

**Description:** As a Alpha 4 release owner, I need one canonical recipe guide to prove public transcripts, library-mode scenarios, and e2e `@smoke` variants all work together.

**Acceptance Criteria:**

- [ ] At least one canonical recipe guide ships a public transcript rendered in the docs site.
- [ ] The same guide or a paired canonical guide ships a library-mode scenario that targets `@lando/core` APIs through `<Run runtime="...">`.
- [ ] The same guide or a paired canonical guide ships an `@smoke` `layer: "e2e"` variant that runs against a real provider on linux-x64.
- [ ] Guide coverage index entries mark the accepted guide or guides as shipped rather than planned.
- [ ] The accepted path is green in guide lint, generated scenario tests, docs build, and the linux-x64 e2e smoke job.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

## Functional Requirements

- FR-1: Public transcript artifacts MUST include only visible reader frames and MUST exclude `<Hidden>`, test-only scenarios, fixtures, cleanup internals, and internal event traces.
- FR-2: The docs site MUST consume public transcript frames from generated scenario output rather than hand-maintained static output.
- FR-3: `<Run runtime="...">` MUST support library-mode scenarios that target `@lando/core` APIs and `@lando/core/testing` helpers.
- FR-4: Display-vs-execute binding MUST be explicit; the generator MUST NOT infer shell commands or library calls from prose.
- FR-5: Source headers and the source-mapper reporter MUST preserve MDX file and line ownership for generated scenario failures.
- FR-6: Every scenario-layer variant MUST run on every supported platform in PR CI unless an explicit metadata skip applies.
- FR-7: An `@smoke` e2e guide-scenario subset MUST run against a real provider on linux-x64.
- FR-8: `bun run lint:guides` MUST block raw shell fences, missing display-vs-execute bindings, public hidden leakage, and missing source-map metadata.
- FR-9: Public transcript redaction MUST make frames deterministic and safe to publish.

## Non-Goals

- Re-specifying or replacing the Alpha 2 and Alpha 3 guide engine already shipped.
- Adding a new guide component vocabulary beyond §19.3 and §19.16.
- Running the e2e guide-scenario smoke subset on every platform during Alpha 4.
- Publishing internal transcripts, hidden blocks, fixture contents, or internal event traces in the docs site.
- Replacing Starlight with a different docs framework.

## Technical Considerations

- The full component vocabulary remains `<Guide>`, `<Scenario>`, `<Step>`, `<Run>`, `<Verify>`, `<Inspect>`, `<Cleanup>`, `<Variable>`, `<Hidden>`, `<UseFixture>`, `<Tabs>`, `<Tab>`, `<Inline>`, and `<Skip>`.
- `ScenarioContext` remains `guideId`, `scenarioId`, `variant`, `testDir`, `runtime`, `vars`, `runCli`, `shell`, `events`, `transcript`, and `fixtures`; library-mode runs should not require `runCli` for API calls.
- Public and internal transcripts should share a schema family but different write targets so test diagnostics can stay rich while docs output stays safe.
- The e2e smoke subset must keep provider credentials and live-provider availability behind explicit gates, matching the Alpha 4 verification contract.
- Generated guide scenario tests remain gitignored; committed files are the MDX guides, fixtures, public docs integration, lint rules, and recipe README scaffold output where applicable.

## Success Metrics

- A shipped canonical guide renders public transcript frames in the docs site from the same generated scenario output that tests execute.
- A library-mode guide scenario exercises `@lando/core` APIs without shelling out to the CLI.
- PR CI reports every scenario-layer variant by guide id, scenario id, platform, and variant, with source-mapped MDX annotations on failure.

## Guide Coverage

Per [PRD-12 US-198](../alpha-3/prd-alpha-3-12-executable-guides.md) (`## Guide Coverage` convention) and [US-199](../alpha-3/prd-alpha-3-12-executable-guides.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-243 | Public reader-scenario transcripts | `docs/guides/authoring/public-transcripts.mdx` | Required at story acceptance |
| US-245 | Library-mode guides | `docs/guides/embedding/library-mode-guide-scenarios.mdx` | Required at story acceptance |
| US-246 | E2e guide-scenario smoke layer | `docs/guides/authoring/e2e-smoke-scenarios.mdx` | Required at story acceptance |
| US-250 | Canonical recipe guide acceptance path | `docs/guides/recipes/canonical-public-transcript.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `scripts/build-guide-scenarios.ts`
- `scripts/build-recipe-readmes.ts`
- `scripts/dev-guides.ts`
- `scripts/lint-guides.ts`
- `scripts/check-guide-coverage.ts`
- `scripts/check-guide-drift.ts`
- `sdk/src/docs/**`
- `core/src/docs/**`
- `core/src/runtime/**`
- `core/src/testing/**`
- `docs/guides/**`
- `docs/src/**`
- `recipes/*/README.mdx`
- `.github/workflows/**`

## Open Questions

- Should public transcript artifacts be committed or generated during docs build? Default: generated during docs build, with committed source MDX and fixtures as the source of truth.
- What exact runtime string should library-mode guides use in `<Run runtime="...">`? Default: `library`, matching the runtime concept in §16.
- Which canonical recipe guide should carry the full acceptance path? Default: the smallest bundled recipe that already has stable fixtures and runs quickly on linux-x64.
- Should the e2e `@smoke` guide subset be required on linux-arm64 during Alpha 4? Default: no, linux-x64 only for Alpha 4; all-platform e2e expansion is an RC gate.
