# PRD Index — Lando v4 Phase 2.5 (Alpha 2 / "guide scenario engine")

## Introduction

Phase 2.5 of [`spec/ROADMAP.md`](../ROADMAP.md) introduces the testing half of §17/§19 Executable Guides and Scenarios. The roadmap's one-sentence goal is:

> Lando's authored guides can generate and run scenario-layer tests, including hidden guide-local edge cases, without requiring the full docs site renderer.

Alpha 2 does **not** add broad product capability. It does not change the runtime, the service catalog, the renderer, the recipe parser, or the library API. What it adds is a single mechanism: **MDX-authored guides under `docs/guides/**` can be parsed into generated TypeScript tests that run on the scenario layer against `TestRuntimeProvider`**, with source-mapped failures that point back to the MDX source.

Alpha 2 sits between Phase 2 Alpha and Phase 3 Beta. It assumes Alpha is shipped and stable: `TestRuntimeProvider`, the scenario test layer, the `unstable` library API (`@lando/core/testing`), persistent caches, and canonical Alpha recipes are all in place. It builds on those without expanding their surface.

## How to use this set of PRDs

- Each PRD is self-contained and follows the Alpha convention: introduction, source references, goals, user stories, functional requirements, non-goals, technical considerations, success metrics, and open questions.
- The dependency graph below is strict: do not start a downstream PRD until its prerequisites are accepted.
- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) is the source of truth. The roadmap references it as "§19" inside the doc body; the file name reflects part-17 in the on-disk numbering. When this set of PRDs and §17/§19 disagree, the spec part wins and both must be updated together.
- Every story follows the same TDD verification contract below.
- Alpha 2 is internal-facing: artifacts are author/CI tools, not user-visible product surface. There is no externally promised stability for any Alpha 2 deliverable until §19 acceptance lands at RC (§19.15).

## PRDs in this set

| # | PRD | Subsystem | Depends on |
|---|---|---|---|
| 01 | [Guide schema and ScenarioContext](./prd-alpha2-01-guide-schema-and-scenario-context.md) | `GuideFrontmatter`, component vocabulary, `ScenarioContext`, fixture-copy discipline | Alpha PRD-06 (library testing surface) |
| 02 | [MDX codegen pipeline](./prd-alpha2-02-mdx-codegen-pipeline.md) | `scripts/build-guide-scenarios.ts`, generated test layout, determinism | PRD-A2-01 |
| 03 | [Author command and source mapper](./prd-alpha2-03-author-command-and-source-mapper.md) | `bun run docs:scenario`, `scripts/test-reporters/scenario-source-mapper.ts` | PRD-A2-02 |
| 04 | [Lint, CI gate, and conditional recipe README](./prd-alpha2-04-lint-ci-and-recipe-readme.md) | `bun run lint:guides` (minimal), generator/test/type CI gate, conditional `build-recipe-readmes.ts` | PRD-A2-02, PRD-A2-03 |

## Dependency graph

```text
                ┌────────────────────────────────┐
                │ Alpha PRD-06 library testing   │
                │ (TestRuntimeProvider exists)   │
                └───────────────┬────────────────┘
                                │
                                ▼
                ┌────────────────────────────────┐
                │ 01 Guide schema +              │
                │    ScenarioContext             │
                └───────────────┬────────────────┘
                                │
                                ▼
                ┌────────────────────────────────┐
                │ 02 MDX codegen pipeline        │
                └───────────────┬────────────────┘
                                │
                                ▼
                ┌────────────────────────────────┐
                │ 03 Author command +            │
                │    source-mapper reporter      │
                └───────────────┬────────────────┘
                                │
                                ▼
                ┌────────────────────────────────┐
                │ 04 Lint + CI gate +            │
                │    conditional recipe README   │
                └────────────────────────────────┘
```

## Verification contract (applies to every story in every PRD)

- [ ] Failing test exists before implementation and is part of the same PR series.
- [ ] After implementation, that specific test passes locally with `bun test <path>`.
- [ ] `bun run typecheck` passes.
- [ ] `bun run lint` passes.
- [ ] Whole-workspace `bun test` passes; no test removed or skipped to make this true.
- [ ] If the story changes generated files, `bun run codegen` is run and committed; generated guide-scenario tests are gitignored per §19.7 and MUST NOT be committed.
- [ ] If the story adds or changes Effect Schemas exposed by `@lando/sdk`, the schema-snapshot gate from Alpha PRD-07 runs cleanly.
- [ ] Live-provider tests remain explicitly gated by environment variables; Alpha 2 generated scenarios default to `layer: "scenario"` against `TestRuntimeProvider` and MUST NOT require a real provider socket.

## Cross-cutting non-goals (out of scope for the entire Alpha 2 set)

The following are explicitly not part of Phase 2.5. If something below sneaks into a story, push it back to Beta/RC:

- Real-provider `layer: "e2e"` guide scenarios. Only `layer: "scenario"` runs in Alpha 2.
- Public transcript rendering, Starlight docs site, or any HTML/Astro consumer of guide artifacts.
- The full §19.3 component vocabulary beyond the ROADMAP set (`<Guide>`, `<Scenario>`, `<Step>`, `<Run>`, `<Verify>`, `<Cleanup>`, `<Variable>`, `<Hidden>`, `<UseFixture>`). `<Inspect>`, `<Tabs>`, `<Tab>`, `<Inline>`, and `<Skip>` are Beta+.
- Multi-axis variants (§19.16) — `tabs:`/`axes:` frontmatter, `<Tabs>`/`<Tab>` components, and per-cell `variants:` overrides. Alpha 2 supports the singleton variant only.
- `<Hidden>` code-emitting behavior. The component is parser- and lint-recognized as a forward-compat stub; Alpha 2 generators reject it with a remediation pointing at `<Scenario render={false}>`. The only Alpha 2 form of hidden coverage is a colocated `<Scenario render={false}>`.
- Full §19.10 lint depth. Alpha 2 ships the minimal lint set documented in PRD-A2-04 only.
- Full §19.3 schema publication. Only the schemas needed by the Alpha 2 vocabulary round-trip through the schema gate.
- Recipe README strip/flatten (§19.13) **unless** a canonical Alpha recipe lands its README as MDX during Alpha 2 (conditional scope per PRD-A2-04 US-072).
- Library-mode guides (§19.14) targeting `<Run runtime="…" />` host code. Alpha 2 covers `<Run command="…" />` against the CLI seam only.
- Per-variant CI fan-out, the `@smoke` tag policy beyond a single static tag, and any change to the §13.6 per-PR CI matrix beyond adding the new generator/test/type gate.
- Deprecation propagation through `GuideFrontmatter.deprecated` — schema field present, runtime use deferred to RC alongside the rest of §18.
- Any change to compiled binary behavior. Alpha 2 is exclusively a build/test/author surface.

## Exit criteria for the whole Alpha 2 set

At least one authored guide in `docs/guides/**` generates and runs a passing `layer: "scenario"` reader scenario against `TestRuntimeProvider`, at least one hidden guide-local `<Scenario render={false}>` runs without rendering, failures map back to MDX source coordinates (file + line + scenario id), `bun run docs:scenario <guide-id>` exits 0 on green and produces a copy-pasteable re-run command on red, the minimal `bun run lint:guides` gate passes per-PR, the CI gate added by PRD-A2-04 runs `build-guide-scenarios` → `tsc --noEmit` over generated paths → `bun test test/scenarios/generated/guides/**`, and no docs-site render is required for any of the above.
