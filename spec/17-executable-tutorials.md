# Lando v4 — Executable Guides and Scenarios

> **Part 17 of 18** · [Index](./README.md)

This part defines how Lando v4 keeps user-facing docs and scenario coverage in lock-step. An **executable guide** is an MDX-authored guide that can generate one or more runnable **scenarios**. The guide stays optimized for the reader; the scenario engine owns execution, assertions, fixtures, variants, cleanup, source mapping, and transcripts.

The core model is:

> **Executable Guides are MDX-authored guide files that define Scenarios. A Scenario is the engine's runnable unit.**

Guides may contain reader-facing scenarios that render in the docs and test-only scenarios that stay invisible but validate related edge cases. Unrelated regressions live in standalone scenario fixtures. Diátaxis remains editorial metadata for docs; it is not the execution model.

---

## 19. Executable Guides and Scenarios

### 19.1 Mission

A v4 guide has three audiences whose needs differ:

1. **Readers** want a clean Lando guide: prose, commands, expected output, and enough validation to know the setup worked.
2. **CI** wants structured, deterministic scenarios with cleanup, assertions, source mapping, and fixture isolation.
3. **Authors** want one natural place to keep a guide's visible path and closely related edge cases from drifting apart.

v3 collapsed all three into bash blocks parsed by a markdown runner. v4 separates the concerns: user-facing docs are **Guides**, runnable behavior is **Scenarios**, and static input state is **Fixtures**. The same MDX source may define both visible reader scenarios and hidden test-only scenarios, but hidden coverage must not pollute the rendered page.

The mechanism applies to authored guide sources:

- `docs/src/content/docs/guides/**/*.mdx` — Lando's public guide surface.
- `docs/src/content/docs/tutorials/**/*.mdx` — Diátaxis tutorial pages when the docs tree chooses to expose that bucket separately.
- `docs/src/content/docs/how-to/**/*.mdx` — Diátaxis how-to pages.
- `recipes/<id>/README.mdx` — recipe-author-supplied guide for using a canonical recipe (§8.8.2).

It does **not** apply to explanation, reference, or blog content. Executable components in those buckets are a lint failure (§19.10). Standalone non-documentary scenario coverage belongs under `test/scenarios/` or a future scenario-fixture tree, not in public docs.

### 19.2 Model and artifact

An executable guide is an MDX file with required frontmatter, a single top-level `<Guide>` element, and one or more `<Scenario>` elements. The engine compiles scenarios, not pages.

```mdx
---
title: Set up a WordPress site with Lando
diataxis: how-to
test:
  id: wordpress-guide
  defaultLayer: scenario
  tags: ["recipes", "wordpress"]
---

import { Guide, Scenario, Step, Run, Verify, Cleanup, Variable }
  from "@lando/core/docs/components";

<Guide>

<Variable name="siteName" value="mysite" display="mysite" />

<Scenario id="reader" render tags={["smoke"]}>
  <Step name="scaffold">
    <Run command="lando init --recipe wordpress" answers={{ name: "{{siteName}}" }} />
    <Verify file=".lando.yml" matchesSchema="Landofile" />
  </Step>

  <Step name="start">
    <Run command="lando start" />
    <Verify event="post-start" status="success" within="60s" />
  </Step>

  <Cleanup>
    <Run command="lando destroy -y" />
  </Cleanup>
</Scenario>

<Scenario
  id="rejects-invalid-service-type"
  render={false}
  reason="Regression coverage for Landofile validation remediation"
  tags={["edge", "landofile"]}
>
  <Step name="start-invalid-app">
    <UseFixture name="invalid-service-type" />
    <Run command="lando start" expectExit={1} />
    <Verify errorTag="LandofileValidationError" remediationIncludes="service type" />
  </Step>
</Scenario>

</Guide>
```

The key terms:

| Term | Meaning |
|---|---|
| **Guide** | Authored MDX document, rendered for users. Public navigation should call these guides, recipes, concepts, or reference pages — not tests. |
| **Diátaxis kind** | Editorial metadata (`tutorial`, `how-to`, `explanation`, `reference`). It constrains where executable components are allowed but does not define execution. |
| **Scenario** | One executable behavior flow compiled into tests. A guide may define multiple scenarios. |
| **Reader scenario** | A scenario with `render`/`render={true}`. Its visible steps and sanitized captured output may appear in public docs. |
| **Test-only scenario** | A colocated scenario with `render={false}`. It generates tests and source-mapped failures but does not render and does not produce public transcript frames. |
| **Fixture scenario** | A standalone non-doc scenario under the scenario test tree. Use for regressions, contracts, or edge cases with no natural guide home. |
| **Variant** | One axis/tab/platform/provider cell of a scenario. Each variant emits a separate generated test and transcript. |
| **Step** | Ordered unit inside a scenario. |
| **Action/assertion** | `Run`, `Verify`, `Inspect`, `Cleanup`, or explicitly justified `Inline` code inside a step. |
| **Fixture** | Immutable input copied into a temp workspace before mutation. Fixtures are data, not test logic. |

The frontmatter `test:` block validates against `GuideFrontmatter` (formerly `TutorialFrontmatter` during the pre-Alpha2 spec), defined in `@lando/sdk` and re-exported through `@lando/core/schema`. Its keys:

| Key | Meaning |
|---|---|
| `id` | Stable kebab-case guide identifier; used as the generated scenario filename prefix. |
| `defaultLayer` | Default scenario layer: `"scenario"` (against `TestRuntimeProvider`) or `"e2e"` (real provider). Individual `<Scenario>` elements may override it. |
| `provider` | Default provider. Inferred from layer (`"scenario"` → `"test"`, `"e2e"` → `"real"`) unless overridden. |
| `timeout` | Default per-scenario timeout in ms. Default 60 000 for scenario layer and 300 000 for e2e. |
| `platforms` | Platform allowlist. Empty/omitted = every platform in the applicable matrix. |
| `tags` | Guide-level tags inherited by scenarios. Each scenario is also tagged with `guide:<id>` and the Diátaxis bucket. |
| `skip` | Skip every scenario variant. Reason required; `until` optional. |
| `deprecated` | A `DeprecationNotice` (§18.2). |
| `tabs` | Single-axis sugar (§19.16). Mutually exclusive with `axes:`. |
| `axes` | Multi-axis declaration (§19.16). Mutually exclusive with `tabs:`. |
| `variants` | Per-cell overrides keyed by dot-joined axis values; refines skip/platforms/tags for a single variant. |

`diataxis:` remains independent metadata. Allowed values: `tutorial`, `how-to`, `explanation`, `reference`. Only `tutorial` and `how-to` MAY contain rendered executable scenarios. Lando's public docs may group both under a broader **Guides** navigation label.

### 19.3 Component vocabulary

The component set is intentionally small. Prop schemas are published in `@lando/sdk/docs/components`, round-trip through the §13.2 schema gate, and are re-exported by `@lando/core/docs/components` alongside the JSX/Astro implementations and AST helpers used by `scripts/build-guide-scenarios.ts` (the successor to the older `scripts/build-doc-tests.ts` name). New components are a §4-style abstraction add: every component MUST have a published prop schema, MUST render in Starlight when applicable, and MUST have a deterministic generator path.

| Component | Renders | Generates | Required props |
|---|---|---|---|
| `<Guide>` | Page wrapper and guide-scoped transcript shell | `describe()` group and guide metadata | (root only) |
| `<Scenario>` | Visible scenario when `render` is true; nothing when `render={false}` | One generated scenario suite per variant | `id`; `reason` when `render={false}` |
| `<Step name="…">` | Titled, numbered block for rendered scenarios | `test(name, …)` or a generated step function | `name` (kebab-case, unique per scenario variant) |
| `<Run>` | Code block + optional captured output | Calls `runCli`, `shell`, `runTooling`, or a runtime method | one of `command`, `shell`, `tooling`, `runtime` |
| `<Verify>` | Optional reader-facing validation annotation | `expect(...)` against captured artifacts | one of `event`, `command`, `file`, `tooling`, `runtime`, `errorTag` |
| `<Inspect>` | Pretty-rendered captured file/JSON/log for visible scenarios | Snapshot/assertion against file, JSON, events, or output | one of `file`, `json`, `events`, `output` |
| `<Variable>` | Nothing, or its `display` value inline | Adds a variable to `ScenarioContext.vars` | `name`, `value` |
| `<Hidden>` | Nothing | Invisible support code inside the current scenario | `reason` (≥ 8 chars) |
| `<Cleanup>` | Collapsed cleanup block when useful to readers | `Effect.addFinalizer` registered before scenario steps run | (none) |
| `<Skip>` | Children with a skipped badge for rendered scenarios | `test.skip(...)` for contained steps/scenarios | `reason`, optional `until` |
| `<Inline>` | A code block (`lang="ts"` by default) when rendered | Verbatim TypeScript injected into generated scenario code | `lang`, `code`, `justification` (≥ 8 chars) |
| `<UseFixture>` | Nothing | Copies an immutable fixture into the scenario temp dir | `name` |
| `<Tabs>` | A Starlight tab group | Forks scenario codegen along the declared axis (§19.16) | `axis` when the guide has multiple axes; optional otherwise |
| `<Tab>` | One tab pane inside `<Tabs>` | Content for variants whose axis value matches `name` | `name` (matches a declared axis value) |

`<Hidden>` is deliberately narrow. It may set up isolation, seed deterministic state, or assert an invariant directly supporting the current scenario. It MUST NOT define a distinct product behavior. Distinct hidden coverage belongs in a `render={false}` scenario or standalone fixture scenario.

The assertion vocabulary used by `<Verify>` and `<Inspect>` is `MatcherSchema`, also defined in `@lando/sdk/docs/components`. It is a small declarative language: scalars match by deep-equal, plain objects match partially by default, and tagged operators add `exact`, `partial`, `regex`, `schema`, `anyOf`, `allOf`, `oneOf`, and `not`. Anything else belongs in `<Inline>` with a justification.

### 19.4 The ScenarioContext

Every generated scenario opens an Effect `Scope` and binds a `ScenarioContext` for the duration of the run. The context is the only Effect requirement on the generated program; it is provided by `@lando/core/testing` and is shape-stable across layer, provider, and variant. Its fields:

- `guideId` — guide id from frontmatter, when sourced from a guide.
- `scenarioId` — scenario id.
- `variant` — axis-value map for this variant; available to `<Inline>` and companion cases.
- `testDir` — per-scenario working directory under `os.tmpdir()`, created at scope acquire and removed at finalize unless `KEEP_SCENARIO_DIRS=1` or the author command passes `--keep`.
- `runtime` — `TestRuntime` for `layer: "scenario"`, real `LandoRuntime` for `layer: "e2e"`.
- `vars` — `<Variable>` declarations in source order.
- `runCli`, `shell` — invoke the CLI binary or a Bun Shell pipeline; return captured stdout/stderr/exit/event trace.
- `events` — lifecycle event stream for the active runtime.
- `transcript` — append-only writer with frame visibility metadata.
- `fixtures` — resolved fixture registry for this guide/scenario.

`ScenarioContext` is part of the embedding-host testing surface (§16.8). Embedding hosts MAY use it to author their own executable guides or standalone scenario fixtures targeting library entry points (§19.14).

### 19.5 Display vs. execute

Every executable component has up to two views: what the reader sees and what the test does. They are bound by default — `<Run command="lando start" />` shows `lando start` and runs `lando start`. They diverge only when the component carries an explicit override prop (`displayCommand`, `displayShell`, `display` on `<Variable>`). Inferred display rewriting is forbidden.

Path substitution is the most common legitimate divergence. The recommended idiom is to declare a `<Variable display="~/projects/mysite" value={ctx.testDir} />` at the top of the guide and reference it through interpolation. The renderer resolves to `display`; the generator resolves to `value`. The lint gate (§19.10) caps display:execute divergence at 25% of executable components per rendered scenario.

### 19.6 Transcripts

A *transcript* is the captured artifact set produced by one scenario variant: per-`<Run>` stdout, stderr, exit code, lifecycle event trace, final `<Inspect>` artifacts, and cleanup status. Transcripts are written to `dist/transcripts/<guide-or-fixture-id>/<scenario-id>[.<axis-value>...].json` at test time.

There are two transcript surfaces:

| Surface | Contents | Consumers |
|---|---|---|
| **Internal transcript** | All sanitized frames, including hidden/test-only scenario frames, support events, and cleanup. | CI artifacts, local debug commands, failure reports. |
| **Public transcript** | Only visible frames from rendered reader scenarios. Hidden blocks, test-only scenarios, fixtures, and internal event traces are excluded. | Docs renderer and recipe README strip/flatten flow. |

Transcripts are **regenerated every test run, gitignored, and never committed**. Drift is caught by docs preview/review for public frames and by scenario test failures for internal frames. When a public transcript is absent at site-build time, the renderer shows the static command and a "no captured output yet" placeholder rather than failing the docs build.

Redaction is uniform with the rest of the runtime:

- The `pre-shell-exec` redaction policy (§3.5, §11.2) applies to captured stdout/stderr.
- `BunSelfRunner` payloads observed via `pre-bun-self-exec`/`post-bun-self-exec` (§3.4) are stripped identically.
- Absolute temp paths are rewritten to the guide's display path, timestamps are masked, container ids and port allocations are masked, and `.lndo.site` salts are stripped.

The redaction list is published as `@lando/sdk/docs/redactions` and is test-covered by the redaction gate in §19.10.

### 19.7 Codegen contract

The MDX→scenario codegen lives at `scripts/build-guide-scenarios.ts` and is registered in §17.2's codegen catalog as a §17.1 stage-1 generator that runs before type-check. For backward compatibility during the Alpha2 migration, `scripts/build-doc-tests.ts` MAY exist as a thin alias, but the spec-owned name is `build-guide-scenarios`.

**Inputs.** `docs/src/content/docs/guides/**/*.mdx`, `docs/src/content/docs/tutorials/**/*.mdx`, `docs/src/content/docs/how-to/**/*.mdx`, `recipes/*/README.mdx`, and colocated guide case files when supported (for example `<guide>.cases.ts`).

**Outputs.** Generated tests under `test/scenarios/generated/guides/<guide-id>/<scenario-id>[.<axis-value>...].test.ts` and `test/scenarios/generated/fixtures/<fixture-id>/<scenario-id>[.<axis-value>...].test.ts`, plus a generated index. Outputs are **gitignored** and regenerated each run. A compatibility `test/mdx/**` barrel MAY remain during transition, but generated scenario paths are canonical.

**Generation steps.** Parse MDX → validate `GuideFrontmatter` (`tabs:`/`axes:` mutex) → walk the AST collecting `<Guide>`, `<Scenario>`, and descendants → validate every component's props against its prop schema → resolve scenarios → resolve variant sets → flatten the component tree for each variant → emit one TypeScript file per scenario variant with `// @generated`, `// @source: <source-path>:<line-range>`, `// @scenario: <scenario-id>`, and optional `// @variant: <axis>=<value>...` headers above every generated `test()`, `expect()`, finalizer, and emitted `<Inline>`.

The generator MUST be deterministic. Identical inputs produce byte-identical generated TypeScript. Determinism is asserted by re-running into a temp dir and comparing.

Because outputs are not committed, the staleness gate is replaced by: generator exits 0; `tsc --noEmit` over generated paths passes; `bun test test/scenarios/generated/` passes under each layer's CI matrix entry (§13.6). A `bun run dev:guides` watcher regenerates on MDX or colocated-case edit and re-runs only affected scenarios.

### 19.8 Source-location preservation

Failure traceability is not optional. A maintainer who breaks a scenario must land on the source that owns the failing assertion, not on a generated `.ts` file.

Generated failures report:

```text
Guide: docs/src/content/docs/guides/node-postgres.mdx:42
Scenario: rejects-invalid-service-type
Variant: linux.provider-lando
Step: start-invalid-app
Fixture: docs/src/content/docs/guides/fixtures/node-postgres/invalid-service-type

Original generated frame:
test/scenarios/generated/guides/node-postgres/rejects-invalid-service-type.linux.test.ts:87
```

Two mechanisms cooperate: source headers emitted by codegen (§19.7) and the **scenario source-mapper reporter** at `scripts/test-reporters/scenario-source-mapper.ts`. The older `mdx-source-mapper` name MAY remain as an alias during migration. The reporter post-processes failure output, finds the nearest preceding source/scenario/variant headers for each generated-line stack frame, rewrites the primary frame to the MDX or `.cases.ts` source range, prefixes the failure description with scenario and variant, and keeps the generated frame as a secondary annotation. The reporter is test-covered by fixture pairs under `test/scenarios/reporter/`.

### 19.9 Hidden, test-only, and fixture discipline

Executable guides can contain hidden coverage, but hidden coverage is constrained:

- `<Hidden>` supports the current scenario only. It may not define a distinct behavior.
- A `<Scenario render={false}>` is the colocated form for related edge cases and regressions.
- Standalone fixture scenarios under `test/scenarios/` are the form for non-documentary behavior coverage.

A test-only scenario MUST declare `reason`, `tags`, and an owner/domain once ownership metadata exists. It renders nothing, contributes no public transcript frames, and is excluded from scaffolded recipe READMEs. Its failures still map to source coordinates.

Promotion rules:

- If a case tests a core invariant, move it to the regular scenario suite.
- If a case tests docs fidelity or a guide-specific promise, keep it with the guide.
- If three guides need the same hidden case, it is not guide-specific anymore.
- If a hidden/test-only scenario fails mostly due to provider or infra instability, move it out of guide execution or tag it for the e2e/nightly layer.

Fixtures are immutable. The harness copies fixture directories into `ScenarioContext.testDir` before mutation. Fixture names should match scenario names unless intentionally shared; shared fixtures require an owner comment or metadata field.

### 19.10 Lint and quality gates

`bun run lint:guides` is a merge gate (§13.4). During Alpha2 migration, `bun run lint:tutorials` MAY alias it. The lint walks every executable guide MDX file and asserts:

- Frontmatter validates against `GuideFrontmatter`.
- `diataxis:` is `tutorial` or `how-to` for rendered executable scenarios. Other buckets containing rendered executable components fail.
- `tabs:` and `axes:` are not both present.
- Every `<Scenario id>` is unique within a guide.
- Every rendered guide has at least one reader scenario unless explicitly marked test-only in frontmatter.
- Every test-only scenario has `render={false}` and a `reason`.
- Every `<Step name>` is unique within its containing scenario variant.
- Every component's props validate against the prop schema in `@lando/sdk/docs/components`.
- `<Hidden>` `reason`, `<Inline>` `justification`, and hidden:visible / inline-density / display:execute caps hold.
- `<Hidden>` does not contain a distinct product behavior assertion; those must be test-only scenarios.
- Every `<Scenario layer="e2e">` carries at least one `<Cleanup>` applicable to every variant.
- No raw fenced bash/sh/zsh code blocks appear inside `<Guide>`; shell snippets MUST go through `<Run>` or `<Inline>`.
- Every `<Verify>` `expect` value parses against `MatcherSchema`.
- Every `<Verify event="...">` name is a member of the canonical event registry.
- `<Tabs>` blocks do not nest; every `<Tab name>` matches a declared axis value; every `variants:` key resolves to a real Cartesian cell.

Cooperating gates:

- **Schema gate (§13.2):** `GuideFrontmatter`, every component prop schema, `MatcherSchema`, `Transcript`, `TranscriptFrame`, `TabAxis`, and `TabAxisValue` round-trip through encode/decode.
- **Type gate (§13.3):** generated `test/scenarios/generated/**/*.test.ts` passes `tsc --noEmit`.
- **Reporter gate:** the source-mapper reporter is exercised by fixture pairs (MDX + colocated cases + seeded failure → expected mapped output).
- **Redaction gate:** a fixture transcript whose contents include every redaction class redacts byte-identically to the canonical golden frame.

### 19.11 Test layer position

Executable guides add generated scenarios to the §13.1 test layer matrix:

- Per-PR CI runs every variant of every generated `layer: "scenario"` reader or test-only scenario on every supported platform.
- Per-PR CI runs the `@smoke`-tagged subset of generated `layer: "e2e"` scenarios on Linux x64.
- Nightly CI runs every generated `layer: "e2e"` scenario on Linux x64/arm64 and macOS x64/arm64.
- The weekly provider matrix runs generated e2e scenarios against each provider in the provider matrix.

Per-variant budgets: scenario variants should hold p95 < 30 s; e2e smoke variants should hold p95 < 5 min including provider setup (`lando setup` cost is measured separately and excluded). These are advisory at v4.0 GA and become merge gates once the perf-budget suite has guide-scenario coverage (§13.1).

Authors must be deliberate about axis fan-out. A guide declaring `axes: { v: [a,b], pm: [c,d,e] }` produces six variants per scenario, each running on every applicable platform. Per-axis-value `platforms:` and per-cell `variants:` overrides are the right tool when the matrix is broader than CI cost allows.

### 19.12 Author commands

The guide-scenario engine exposes one focused local workflow:

```bash
bun run docs:scenario node-postgres
bun run docs:scenario node-postgres --scenario rejects-invalid-service-type
bun run docs:scenario node-postgres --variant php-8.3.postgres
bun run docs:scenario node-postgres --keep
bun run docs:scenario node-postgres --explain
```

Required behaviors:

- `--keep` preserves the temp dir and prints its path.
- `--debug` prints generated test path, source map, resolved variables, and fixture copy map.
- `--update-transcript` regenerates local transcript artifacts.
- `--scenario <id>` runs one scenario.
- `--step <name>` runs or stops after one step when the generated shape supports it.
- `--fixture <name>` forces a fixture-backed scenario when applicable.
- `--explain` prints the MDX/cases → scenario plan without running it.

Failure output MUST include a copy-pasteable re-run command.

### 19.13 Recipe README integration

`recipes/<id>/README.mdx` is the canonical location for an executable guide that walks a user through a canonical recipe (§8.8.2). The MDX rendered into the docs site uses the full vocabulary; the file copied into the user's project at scaffold time is a **prose-only render** of the same guide with executable components stripped or flattened.

`scripts/build-recipe-readmes.ts` (§17.2 codegen catalog) performs the strip and writes `recipes/<id>/.scaffold/<axis-value>[.<axis-value>...].md` for every legal axis-value combination. The cell selected at scaffold time is the one matching the user's resolved `lando init` answers (the recipe manifest declares the prompt-answer→axis-value mapping; see §8.8).

The strip rules: `<Guide>` and the rendered reader `<Scenario>` are unwrapped, `<Step>` becomes a numbered Markdown heading, `<Run>` becomes a fenced code block of the displayed command, `<Verify>` and `<Hidden>` are omitted, test-only scenarios are omitted entirely, `<Inspect>` becomes a fenced block of the most recent public transcript value (or "(generated at runtime)" when none exists), `<Variable>` is replaced by its `display`, `<Cleanup>` becomes a final "Cleanup" section listing displayed commands, `<Inline>` becomes a `ts` fenced block only when rendered, and `<Tabs>` resolves to the chosen tab's content. Recipe authors MAY set `<Guide scaffoldStrip={false}>` to suppress the strip and copy the MDX directly — rare and explicit.

### 19.14 Library-mode guides and scenarios

Guides that document the embedding API (§16) target library entry points instead of the binary. `<Run runtime="app.start" />` resolves an `App` handle through the active `ScenarioContext.runtime` and invokes handle methods such as `app.start()`, `app.info()`, and `app.stop()`; rendered docs show host TypeScript code rather than a CLI command. Guides that need command-shaped behavior MAY use documented `@lando/core/cli` operations through `runtime.run(...)`, but App handles are the preferred lifecycle form. The same `<Verify>`, `<Inspect>`, `<Cleanup>`, `<Tabs>`, and test-only scenario vocabulary applies. Mixing CLI and runtime forms in one guide is allowed when the reader story needs it. The lint gate enforces that every `<Run runtime="…" />` is paired with rendered TypeScript showing the host code.

### 19.15 Acceptance criteria

The §15.C checklist gains the following items, all release-blocking for v4.0 GA:

- Every executable guide under `docs/src/content/docs/{guides,tutorials,how-to}/**` and every `recipes/<id>/README.mdx` containing `<Guide>` produces passing generated scenario tests for every applicable variant, or is explicitly skipped with a reason.
- Test-only scenarios colocated with guides are hidden from rendered docs, excluded from public transcript frames, source-mapped to MDX or `.cases.ts` coordinates, and reported separately from reader scenario failures.
- The guide linter and source-mapper reporter pass on every supported platform.
- Every component prop schema in `@lando/sdk/docs/components` round-trips through the §13.2 schema gate, including `GuideFrontmatter`, `ScenarioProps`, `TabsProps`, `TabProps`, `TabAxis`, and `TabAxisValue`.
- The redaction gate passes against a fixture transcript exercising every redaction class.
- Every `layer: "e2e"` scenario's cleanup is idempotent under the second-invocation harness.
- Every recipe README strip-and-flatten output scaffolds into a directory whose `README.md` contains no MDX JSX, no imports, no unresolved interpolation expressions, and no test-only scenario content.
- A multi-axis fixture guide (≥ 2 axes, ≥ 2 values per axis) generates the full Cartesian product of scenario tests, each runs cleanly, and the reporter prefixes failure output with the scenario and variant map.

### 19.16 Tabbed variants

Guides often need to branch (Drupal 10 vs 11, Composer vs npm, macOS vs Linux). v4 makes the tabs the source of truth for scenario variants.

**Axes.** A guide declares zero or more axes in frontmatter. Each axis has a name and ordered values. The variant set is the Cartesian product of every axis's values; a guide with no axes has the singleton variant. Two declaration forms are mutually exclusive:

- `tabs:` — single-axis sugar; implicit axis name `default`.
- `axes:` — explicit multi-axis; each key is the axis name, each value is a `TabAxis` declaration.

The `TabAxis` and `TabAxisValue` schemas live in `@lando/sdk/docs/components`. Each `TabAxisValue` carries a `name`, `label`, optional `icon`, optional `default: true`, and may refine tags/platforms/skip for that axis value's variants. Frontmatter `variants:` provides per-cell overrides keyed by dot-joined axis values. Resolution order (later wins): guide-wide → per-axis-value → per-cell → scenario-local override.

**`<Tabs>`/`<Tab>`.** A `<Tabs axis="A">` block iterates axis A; each `<Tab name="V">` provides content for variants whose A-value is V. The `axis` prop is required when the guide has more than one axis and inferred otherwise. Multiple `<Tabs>` blocks are allowed and orthogonal. Nesting is forbidden.

**Coverage gaps.** Within a single `<Tabs>` block, not every tab needs every step. The codegen rule: the union of `<Step name>` values across all tabs in a block defines the block's step set; for any step name a matched tab does not include, the variant emits `test.skip(<step-name>, "axis A=V tab does not include step <step-name>")`. For variants whose axis value is absent from a block, the block emits one skip per step in the union. This keeps reports honest: maintainers see exactly which steps are absent for which axis values.
