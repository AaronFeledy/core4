# Lando v4 — Executable Guides and Scenarios

> **Part 17 of 18** · [Index](./README.md)

This part defines how MDX-authored user guides generate runnable scenarios without turning reader prose into test syntax.

---

## 19. Executable Guides and Scenarios

### 19.1 Mission

An executable guide is a prose-first MDX guide that defines Scenarios, the engine's runnable units. Readers receive clear Markdown, CI receives deterministic execution and assertions, and authors keep visible promises with closely related edge coverage.

Components are the executable minority. Documentation MUST remain Markdown; component props are machine hints, not prose. Non-executed examples stay outside `<Scenario>`. A scenario MUST execute or assert behavior.

Executable components are allowed only in:

- `docs/src/content/docs/guides/**/*.mdx`
- `docs/src/content/docs/tutorials/**/*.mdx`
- `docs/src/content/docs/how-to/**/*.mdx`
- `recipes/<id>/README.mdx`

Explanation, reference, and blog content MUST NOT contain rendered executable scenarios. Unrelated regressions belong under `test/scenarios/`.

### 19.2 Model and artifact

An executable guide has `GuideFrontmatter`, one top-level `<Guide>`, and one or more `<Scenario>` elements. The engine compiles scenarios, not pages.

`GuideFrontmatter` names `id`, `defaultLayer`, `provider`, `timeout`, `platforms`, `tags`, `skip`, `deprecated`, mutually exclusive `tabs` or `axes`, and per-cell `variants`. `id` is stable; layer selects `scenario` or `e2e`; scenario props MAY override inherited layer, provider, timeout, platforms, tags, skip, and variant policy.

`ScenarioProps` names the scenario `id`, visibility through `render`, required `reason` for test-only scenarios, layer/provider overrides, tags, platforms, timeout, skip, and variant refinements. `diataxis` remains independent editorial metadata; only `tutorial` and `how-to` MAY contain rendered executable scenarios.

| Term | Contract |
|---|---|
| Guide | Authored MDX rendered for users. |
| Scenario | One executable behavior flow, expanded once per variant. |
| Reader scenario | `render` is true; visible steps and public transcript frames MAY render. |
| Test-only scenario | `render={false}`; source-mapped tests run, but no public content is emitted. |
| Fixture scenario | Standalone non-doc coverage under the scenario test tree. |
| Variant | One resolved axes/platform/provider cell with its own test and transcript. |
| Step | Ordered unit within a scenario. |
| Fixture | Immutable input copied before mutation; fixtures contain data, not test logic. |

### 19.3 Component vocabulary

Prop schemas live in `@lando/sdk/docs/components`; implementations and AST helpers live in `@lando/core/docs/components`. Every new component MUST have a published schema, deterministic generator behavior, and reader rendering where applicable.

| Component | Purpose |
|---|---|
| `<Guide>` | Root wrapper, guide metadata, and transcript scope. |
| `<Scenario>` | Declares one visible or test-only runnable flow per variant. |
| `<Step>` | Names an ordered, unique scenario step. |
| `<Run>` | Executes exactly one command, shell pipeline, tooling task, or runtime operation and MAY display it. |
| `<Verify>` | Applies declarative assertions to events, commands, files, tooling, runtime results, or tagged errors. |
| `<Inspect>` | Captures and optionally renders files, JSON, events, or output. |
| `<Variable>` | Binds an execution value and optional short display substitution; every variable MUST be interpolated. |
| `<Hidden>` | Performs support work for the current behavior only and requires a reason. |
| `<Cleanup>` | Registers cleanup before scenario actions begin and MAY render a collapsed reader block. |
| `<Skip>` | Marks contained coverage skipped with a reason and optional expiry. |
| `<Inline>` | Injects justified TypeScript only when declarative components cannot express the assertion. |
| `<UseFixture>` | Copies an immutable named fixture into the scenario workspace. |
| `<Tabs>` | Selects content by a declared variant axis; nesting is forbidden. |
| `<Tab>` | Supplies content for one declared axis value. |

`MatcherSchema` is the assertion vocabulary for `<Verify>` and `<Inspect>`. It supports deep-equal scalars, partial objects by default, and the named operators `exact`, `partial`, `regex`, `schema`, `anyOf`, `allOf`, `oneOf`, and `not`. Other assertions require justified `<Inline>`.

`<Hidden>` MUST NOT define distinct product behavior. `<Inline>` MUST remain exceptional. `<Variable>` display values MUST be short substitutions, never explanatory sentences.

### 19.4 The ScenarioContext

Every generated scenario acquires an Effect `Scope` and one `ScenarioContext`. The context owns guide/scenario identity, resolved variant, isolated working directory, scenario or real runtime, variables, CLI and shell invocation, lifecycle events, transcript writing, and fixture resolution.

`ScenarioContext` is stable across providers, layers, and variants, and is part of `@lando/core/testing` (§16.8). Scope finalization removes temporary state unless an explicit author/debug option preserves it.

### 19.5 Display vs. execute

Display and execution are bound by default. They MAY diverge only through explicit display props; inferred rewriting is forbidden. Variable interpolation is the preferred path substitution mechanism: rendering uses the display value and execution uses the bound value.

Display values MUST remain literals such as paths, names, or masked credentials. A rendered scenario MAY diverge in no more than 25% of executable components. Unreferenced variables and prose-like display values are lint failures.

### 19.6 Transcripts

Each scenario variant captures stdout, stderr, exit status, lifecycle events, inspected artifacts, and cleanup status as a `Transcript` of `TranscriptFrame` values under `dist/transcripts/`.

| Surface | Contract |
|---|---|
| Internal transcript | Contains all sanitized frames, including hidden, test-only, fixture, event, and cleanup frames; consumed by CI and diagnostics. |
| Public transcript | Contains only visible frames from rendered reader scenarios; consumed by docs and recipe README generation. |

Transcripts are regenerated, gitignored, and never committed. Public output MUST NOT include hidden blocks, test-only scenarios, internal event traces, or fixtures. When public output is unavailable, the docs renderer MAY show the static command and an explicit uncaptured-output placeholder rather than fabricate output.

All frames use the canonical transcript redaction profile (§3.7): registered secrets and shell/Bun payloads are redacted; temporary paths, timestamps, container ids, ports, and route salts are normalized. The redaction vocabulary is published from `@lando/sdk/docs/redactions` and MUST match the §13 contract gate byte-for-byte.

### 19.7 Codegen contract

`scripts/build-guide-scenarios.ts` is the canonical §17.2 codegen entry. A transitional `build-doc-tests` alias MAY exist, but MUST delegate without changing semantics.

Inputs are the allowed MDX locations and supported colocated case files. Outputs are one gitignored TypeScript test per scenario variant plus a generated index under `test/scenarios/generated/`.

Generation MUST validate frontmatter and props, resolve variants, flatten the component tree, preserve visibility, and emit deterministic tests. Identical inputs MUST produce byte-identical outputs. Because outputs are uncommitted, the gate is successful generation, typecheck, and execution under the applicable §13.6 matrix. `bun run dev:guides` regenerates and runs affected scenarios during authoring.

### 19.8 Source-location preservation

Generated tests MUST preserve source path, line range, scenario, variant, step, and fixture provenance. The scenario source-mapper reporter MUST rewrite the primary failure location to MDX or colocated case source while retaining the generated frame as secondary evidence. Reporter fixtures MUST cover mappings and prevent off-by-one drift.

### 19.9 Hidden, test-only, and fixture discipline

- `<Hidden>` supports only the current scenario.
- A test-only scenario MUST declare `render={false}`, a reason, tags, and ownership metadata when available; it MUST execute or assert behavior.
- Variable-only or documentation-only scenarios are forbidden.
- Non-documentary behavior belongs in standalone fixture scenarios.
- Fixtures are immutable and copied before mutation; shared fixtures require explicit ownership.
- Core invariants graduate to the regular scenario suite. Guide-specific promises stay with the guide. Coverage reused by three guides is no longer guide-specific.
- Provider-unstable coverage SHOULD move to e2e/nightly rather than weakening a reader guide.

### 19.10 Lint and quality gates

`bun run lint:guides` is a merge gate and MUST enforce:

- `GuideFrontmatter`, scenario, component, matcher, transcript, tab, and variant schema validity.
- Allowed Diátaxis buckets and unique scenario/step ids.
- At least one reader scenario unless explicitly test-only.
- Required reasons, ownership metadata, and cleanup for every e2e scenario variant.
- Hidden, inline, and display divergence limits.
- No raw shell fence inside a scenario; executable shell uses `<Run>` or justified `<Inline>`.
- Every variable is consumed and no display prop carries prose.
- Every scenario contains an action or assertion.
- Markdown remains the dominant reader surface.
- Event assertions reference the canonical event registry.
- Tabs do not nest and every tab or per-cell override resolves to a declared axis value.

Schema round-trip, generated-test typecheck, source-mapper fixtures, public-transcript policy, and canonical redaction are cooperating merge gates (§13.2–§13.4).

### 19.11 Test layer position

Per-PR CI runs all scenario-layer variants on every supported platform and the e2e smoke subset on Linux x64. Nightly CI runs all e2e variants on Linux x64/arm64 and macOS x64/arm64. The weekly matrix runs e2e variants against every applicable provider (§13.6).

Scenario variants SHOULD remain below 30 seconds p95 and e2e smoke below 5 minutes p95, excluding separately measured provider setup. These budgets are advisory at v4.0 GA and become merge gates when §13 perf coverage includes guide scenarios. Authors MUST constrain axis fan-out with platform and cell overrides rather than silently dropping cells.

### 19.12 Author commands

The author workflow MUST run a guide, scenario, variant, step, or fixture; preserve the workspace on request; update local transcript artifacts; explain the resolved scenario plan; and print source maps and resolved bindings in debug mode. Every failure MUST include a copy-pasteable rerun command.

### 19.13 Recipe README integration

`recipes/<id>/README.mdx` is the canonical recipe guide (§8.8.2). `scripts/build-recipe-readmes.ts` generates one prose-only scaffold README per legal variant cell and selects the cell from resolved recipe answers.

Strip-and-flatten MUST unwrap the guide and rendered reader scenario, turn steps into numbered headings, render displayed commands as fences, omit hidden and test-only content, substitute variable displays, flatten cleanup into a final section, resolve tabs to the selected cell, and include inspected public output only when captured. Output MUST contain no MDX JSX, imports, unresolved interpolation, or test-only content. `scaffoldStrip={false}` MAY explicitly preserve MDX.

### 19.14 Library-mode guides and scenarios

Embedding guides (§16) MAY target runtime operations and `App` handles instead of the binary. Rendered docs MUST show the corresponding host TypeScript. Command-shaped library operations MAY use `@lando/core/cli`; lifecycle guides SHOULD prefer `App` handles. CLI and runtime forms MAY coexist when the reader workflow needs both.

### 19.15 Acceptance criteria

The following augment §15.C and are release-blocking for v4.0 GA:

- Every executable guide and recipe README generates passing tests for every applicable variant or carries an explicit skip reason.
- Test-only scenarios remain absent from rendered docs and public transcripts while failures map to authored source.
- Guide lint, source mapping, component schemas, transcript redaction, and public transcript gates pass on every supported platform.
- Every e2e cleanup path is idempotent under a second invocation.
- Every scaffold README is prose-only and free of unresolved executable syntax.
- A multi-axis fixture generates and runs the full Cartesian product, and failures identify the scenario and variant map.

### 19.16 Tabbed variants

`tabs` is single-axis sugar and `axes` declares named multi-axis values; they are mutually exclusive. `TabAxis` and `TabAxisValue` name ordered values, labels, optional icons/defaults, and optional tag/platform/skip refinements. The variant set is the Cartesian product, with precedence: guide-wide, then axis value, then cell override, then scenario-local override.

`<Tabs>` selects an axis and `<Tab>` selects a declared value. Multiple orthogonal tab groups are allowed; nesting is forbidden. Missing steps in a tab cell MUST be emitted as explicit skipped tests, not silently omitted, so coverage gaps remain visible.
