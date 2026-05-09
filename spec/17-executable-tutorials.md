# Lando v4 — Executable Tutorials

> **Part 17 of 17** · [Index](./README.md)

This part defines how Lando v4 keeps narrative user docs and end-to-end test coverage in lock-step. An *executable tutorial* is an MDX file that is both the authored guide a reader follows and the structured source from which one or more TypeScript test files are generated. Prose stays prose; structured assertions live in the typed props of a small JSX component vocabulary; codegen compiles the components into runnable tests that drive `@lando/core/testing` against the live runtime; the same components render in Starlight as styled command blocks with embedded transcripts captured from the most recent test run.

This is the v4 mechanism for the Diátaxis *tutorial* and *how-to* buckets. *Reference* docs remain codegen from the canonical registries (§17.2). *Explanation* docs remain prose-only. There is no markdown-as-test surface in v4; the v3 Leia format is retired (§13.1).

---

## 19. Executable Tutorials

### 19.1 Mission

A v4 tutorial has three audiences whose needs differ: the reader wants narrative; CI wants structured assertions and Scope-bound cleanup; the author wants one file. v3 collapsed all three into bash blocks parsed by a markdown runner, optimizing for the test runner and degrading the doc. v4 inverts that — every assertion lives in the typed props of a JSX component, the document is the canonical source for both the rendered page and every generated test it implies, and the tests cannot drift from the doc because they do not exist on disk between runs.

The mechanism applies to:

- `docs/src/content/docs/tutorials/**/*.mdx` — Diátaxis tutorials.
- `docs/src/content/docs/how-to/**/*.mdx` — Diátaxis how-tos.
- `recipes/<id>/README.mdx` — recipe-author-supplied tutorial for using a canonical recipe (§8.8.2).

It does **not** apply to the `explanation/` or `reference/` buckets or to the blog. Executable components in those buckets are a lint failure (§19.10).

### 19.2 The artifact

An executable tutorial is an MDX file with required frontmatter, a single top-level `<Tutorial>` element, and any combination of the components listed in §19.3 inside it.

```mdx
---
title: Set up a Drupal site with Lando
diataxis: tutorial
test:
  id: drupal-tutorial
  layer: e2e
  tags: ["recipes", "drupal", "smoke"]
---

import { Tutorial, Step, Run, Verify, Cleanup, Variable }
  from "@lando/core/docs/components";

<Tutorial>

<Variable name="siteName" value="mysite" display="mysite" />

<Step name="scaffold">
  <Run command="lando init --recipe drupal" answers={{ name: "{{siteName}}" }} />
  <Verify file=".lando.yml" matchesSchema="Landofile" />
</Step>

<Step name="start">
  <Run command="lando start" />
  <Verify event="post-start" status="success" within="60s" />
</Step>

<Cleanup>
  <Run command="lando destroy -y" />
</Cleanup>

</Tutorial>
```

The frontmatter `test:` block validates against the `TutorialFrontmatter` schema, defined in `@lando/sdk` and re-exported through `@lando/core/schema`. Its keys:

| Key | Meaning |
|---|---|
| `id` | Stable kebab-case identifier; matches the generated test filename prefix. |
| `layer` | `"scenario"` (against `TestRuntimeProvider`, every PR) or `"e2e"` (real provider, nightly + smoke subset on PRs). |
| `provider` | Inferred from `layer` (`"scenario"`→`"test"`, `"e2e"`→`"real"`); rarely overridden. |
| `timeout` | Per-tutorial timeout in ms. Default 60 000 (scenario), 300 000 (e2e). The §2.1 hot-path budgets do not apply. |
| `platforms` | Platform allowlist. Empty/omitted = every platform in the matrix. |
| `tags` | Test tags. Implicitly tagged with `"tutorial"` and the diataxis bucket. |
| `skip` | Skip every variant. The MDX still renders. `reason` is required; `until` is optional. |
| `deprecated` | A `DeprecationNotice` (§18.2). |
| `tabs` | Single-axis sugar (§19.16). Mutually exclusive with `axes:`. |
| `axes` | Multi-axis declaration (§19.16). Mutually exclusive with `tabs:`. |
| `variants` | Per-cell overrides keyed by the dot-joined axis-value path (e.g., `"drupal-11.npm"`); refines `skip`/`platforms`/`tags` for a single Cartesian cell. |

The `diataxis:` frontmatter key (independent of `test:`) constrains which components are legal in the file. Allowed values: `"tutorial"`, `"how-to"`, `"explanation"`, `"reference"`. Only `"tutorial"` and `"how-to"` MAY contain executable components. Files declaring both `tabs:` and `axes:` are rejected by lint.

### 19.3 Component vocabulary

The component set is intentionally small. Prop schemas are published in `@lando/sdk/docs/components`, round-trip through the §13.2 schema gate, and are re-exported by `@lando/core/docs/components` alongside the JSX/Astro implementations and the AST helpers used by `scripts/build-doc-tests.ts`. New components are a §4-style abstraction add: every component MUST have a published prop schema, MUST render in Starlight, and MUST have a deterministic generator path.

| Component | Renders | Generates | Required props |
|---|---|---|---|
| `<Tutorial>` | Scoped wrapper; numbered headings, transcript shell | `describe()`; opens an Effect `Scope`; resolves `TutorialContext` | (root only) |
| `<Step name="…">` | Titled, numbered block | `test(name, …)`; per-step Effect program | `name` (kebab-case, unique per variant) |
| `<Run>` | Code block + collapsible captured transcript | Calls `runCli`, `shell`, `runTooling`, or a `runtime` method | one of `command`, `shell`, `tooling`, `runtime` |
| `<Verify>` | Optional ✓ annotation; can be hidden | `expect(...)` against the captured artifact | one of `event`, `command`, `file`, `tooling`, `runtime` |
| `<Inspect>` | Pretty-rendered captured file/JSON/log | Snapshot assertion | one of `file`, `json`, `events`, `output` |
| `<Variable>` | Nothing, or its `display` value inline | `const <name> = <value>` in the prelude; available via `{{name}}` interpolation | `name`, `value` |
| `<Hidden>` | Nothing | Inline test code; same generator paths as the contained children | `reason` (≥ 8 chars) |
| `<Cleanup>` | Single collapsed callout | `Effect.addFinalizer` registered before any `test()` runs | (none) |
| `<Skip>` | Children with a "skipped" badge | `test.skip(...)` for the contained `<Step>`s | `reason`, optional `until` |
| `<Inline>` | A code block (`lang="ts"` by default) | Verbatim TypeScript injected into the generated test | `lang`, `code`, `justification` (≥ 8 chars) |
| `<Tabs>` | A Starlight tab group | Forks codegen along the declared axis (§19.16) | `axis` when the tutorial has multiple axes; optional otherwise |
| `<Tab>` | One tab pane inside a `<Tabs>` | Content for variants whose axis value matches `name` | `name` (matches a value declared in `tabs:`/`axes:`) |

`<Inline>` is the explicit escape hatch for shapes the typed components do not cover. The lint gate caps inline density and requires the `justification` prop. Custom matcher logic also belongs in `<Inline>`.

The assertion vocabulary used by `<Verify>` and `<Inspect>` is `MatcherSchema`, also defined in `@lando/sdk/docs/components`. It is a small declarative language: scalars match by deep-equal, plain objects match partially by default, and tagged operators add `exact`, `partial`, `regex`, `schema`, `anyOf`, `allOf`, `oneOf`, and `not`. Anything else belongs in `<Inline>`.

### 19.4 The TutorialContext

Every generated test opens an Effect `Scope` and binds a `TutorialContext` for the duration of the run. The context is the only Effect requirement on the generated program; it is provided by `@lando/core/testing` and is shape-stable across `layer`, `provider`, and variant. Its fields:

- `id` — tutorial id from frontmatter.
- `variant` — axis-value map for this variant (empty for tutorials with no axes); available to `<Inline>` for variant-specific assertions.
- `testDir` — per-test working directory under `os.tmpdir()`, created at scope acquire and removed at finalize unless `KEEP_TUTORIAL_DIRS=1`.
- `runtime` — `TestRuntime` for `layer: "scenario"`, real `LandoRuntime` for `layer: "e2e"`.
- `vars` — `<Variable>` declarations in source order.
- `runCli`, `shell` — invoke the CLI binary or a `Bun.$` pipeline; return captured stdout/stderr/exit/event-trace.
- `events` — lifecycle event stream for the active runtime.
- `transcript` — append-only writer; generators emit transcript writes automatically.

`TutorialContext` is part of the embedding-host testing surface (§16.8). Embedding hosts MAY use it to author their own executable tutorials targeting library entry points (§19.14).

### 19.5 Display vs. execute

Every executable component has up to two views: what the *reader* sees and what the *test* does. They are bound by default — `<Run command="lando start" />` shows `lando start` and runs `lando start`. They diverge only when the component carries an explicit override prop (`displayCommand`, `displayShell`, `display` on `<Variable>`). Inferred display rewriting is forbidden — too easy to make the doc lie.

Path substitution is the most common legitimate divergence. The recommended idiom is to declare a `<Variable display="~/projects/mysite" value={ctx.testDir} />` at the top of the tutorial and reference it via `{{siteName}}`-style interpolation that the renderer resolves to `display` and the generator resolves to `value`. The lint gate (§19.10) caps display:execute divergence at 25% of executable components per tutorial.

### 19.6 Transcripts

A *transcript* is the captured artifact set produced by one variant of a tutorial run: per-`<Run>` stdout, stderr, exit code, lifecycle event trace, and the final state of any `<Inspect>` target. Transcripts are written to `dist/transcripts/<id>[.<axis-value>...].json` at test time and consumed by the docs renderer at site build time. The `Transcript` and `TranscriptFrame` schemas are canonical, defined in `@lando/sdk/docs/components`, and round-trip through the §13.2 schema gate.

Transcripts are **regenerated every test run, gitignored, and never committed**. Drift is caught by the docs preview build of the PR — a materially different transcript is visible to the reviewer. There is no separate `git diff --exit-code` against transcripts. When a transcript is absent at site-build time (developer authored a new tutorial without running tests yet), the renderer shows the static command and a "no transcript yet" placeholder rather than failing the build.

Redaction is uniform with the rest of the runtime:

- The `pre-shell-exec` redaction policy (§3.5, §11.2) applies to every captured stdout/stderr.
- `BunSelfRunner` payloads observed via `pre-bun-self-exec`/`post-bun-self-exec` (§3.4) — registry tokens, secret-resolved env, the `LANDO_DISALLOW_BUN_BE_BUN_REENTRY` re-entry marker — are stripped identically.
- Absolute paths under `os.tmpdir()` are rewritten to the tutorial's display path (or `~/projects/<siteName>`), timestamps are masked to `YYYY-MM-DD HH:MM:SS`, container ids and port allocations are masked to placeholder tokens, and `.lndo.site` salts are stripped.

The redaction list is published as `@lando/sdk/docs/redactions` and is itself test-covered by the redaction gate in §19.10.

### 19.7 Codegen contract

The MDX→TypeScript codegen lives at `scripts/build-doc-tests.ts` and is registered in §17.2's codegen catalog as a §17.1 stage-1 generator that runs before type-check.

**Inputs.** `docs/src/content/docs/tutorials/**/*.mdx`, `docs/src/content/docs/how-to/**/*.mdx`, `recipes/*/README.mdx`.

**Outputs.** `test/mdx/<bucket>/<id>[.<axis-value>...].test.ts` per Cartesian-product cell (one variant when no axes are declared) plus a `test/mdx/index.ts` barrel. Outputs are **gitignored** and regenerated each run.

**Generation steps.** Parse MDX → validate frontmatter (`tabs:`/`axes:` mutex) → walk the AST collecting `<Tutorial>` and descendants → validate every component's props against its prop schema → resolve the variant set (Cartesian product of all declared axes; singleton `[{}]` if none) → for each variant, flatten the component tree (non-`<Tabs>` content goes verbatim into every variant; `<Tabs axis="A">` content goes only into variants whose A-value matches; missing tab/step combinations emit `test.skip(...)` so coverage gaps surface in test reports) → emit one TypeScript file per variant with `// @generated` and `// @source: <mdx-path>:<line-range>` headers above every `test()`, `expect()`, `addFinalizer`, and emitted `<Inline>`; tabbed variants additionally carry `// @variant: <axis>=<value>...` so failure output identifies the cell.

The generator MUST be deterministic. Identical input MDX produces byte-identical generated TypeScript. Determinism is asserted by re-running into a temp dir and comparing.

Because outputs are not committed, the §17.2 staleness gate is replaced by: generator exits 0; `tsc --noEmit` over generated paths passes; `bun test test/mdx/` passes under each layer's CI matrix entry (§13.6). A `bun run dev:tutorials` watcher regenerates on MDX change and re-runs only the affected variants.

### 19.8 Source-location preservation

Failure-traceability is not optional. A reader who breaks a tutorial must land on the MDX line that owns the failing assertion, not on a generated `.ts` file. Two mechanisms cooperate: the `// @source:` and `// @variant:` headers emitted by codegen (§19.7) and the **MDX source-mapper reporter** at `scripts/test-reporters/mdx-source-mapper.ts`, enabled by default for the `test/mdx/` layer via `bunfig.toml`. The reporter post-processes failure output, finds the nearest preceding `@source:` header for each generated-line stack frame, rewrites the primary frame to point at the MDX path/line range, prefixes the failure description with the variant axis-value map when one is present, and keeps the generated frame as a secondary annotation. The reporter is itself test-covered by a fixture pair under `test/mdx-reporter/` (§19.10).

### 19.9 Hidden / Cleanup discipline

`<Hidden>` carries setup and isolation that the reader does not perform. Every block requires a `reason` (≥ 8 chars) surfaced in lint reports and `lando doctor --tutorials --verbose`. The hidden:visible step ratio is capped at 1:3 *per variant*; violations require a `{/* lint:hidden-ratio-justified: <reason> */}` comment immediately above the offending block. A `<Hidden>` MUST NOT contain a `<Cleanup>` (cleanup must remain visible) and MUST NOT contain a `<Variable>` whose value is needed by a visible step without an accompanying `display` prop.

`<Cleanup>` runs regardless of test outcome (success, assertion failure, timeout, interrupt) via `Effect.addFinalizer`. Every `<Tutorial layer="e2e">` MUST contain at least one `<Cleanup>` block applicable to every generated variant — a cleanup nested inside a single `<Tab>` does not satisfy the rule. Cleanup commands MUST be idempotent; the contract suite's tutorial harness runs every cleanup block twice and asserts the second invocation does not error. The renderer surfaces cleanup as a single collapsed callout under the tutorial's last visible step.

### 19.10 Lint and quality gates

`bun run lint:tutorials` is a merge gate (§13.4) that walks every executable-tutorial MDX file and asserts:

- Frontmatter validates against `TutorialFrontmatter`.
- `diataxis:` is `"tutorial"` or `"how-to"`. Other buckets containing `<Tutorial>` (or any executable component) fail.
- `tabs:` and `axes:` are not both present.
- Every `<Step name>` is unique within its containing variant.
- Every component's props validate against the prop schema in `@lando/sdk/docs/components`.
- `<Hidden>` `reason`, `<Inline>` `justification`, and the hidden:visible / `<Inline>`-density / display:execute caps hold (§19.5, §19.9).
- Every `<Tutorial layer="e2e">` carries at least one `<Cleanup>` applicable to every variant.
- No raw fenced bash/sh/zsh code blocks appear inside `<Tutorial>` — shell snippets MUST go through `<Run>` or `<Inline>`. (This is the v3 Leia failure mode and is rejected outright.)
- Every `<Verify>` `expect` value parses against `MatcherSchema`.
- Every `<Verify event="...">` name is a member of the canonical event registry (the same registry that drives §13.4's "event registry drift" check). Unknown event names — including stale v3-style ids like `post-app-start` — fail the lint with `TutorialUnknownEventError` and a suggestion list. The flagship `<Verify event="post-start" ...>` example in §19.2 is exercised by the lint-fixture suite to keep this rule honest.
- `<Tabs>` blocks do not nest (`TutorialNestedTabsError`); every `<Tab name>` matches a value declared for the enclosing axis; every `axes:`-declared axis has either exactly one `default: true` value or every value `default: false`; every `variants:` key resolves to a real Cartesian cell (`TutorialVariantKeyError`).

Cooperating gates:

- **Schema gate (§13.2):** `TutorialFrontmatter`, every component prop schema, `MatcherSchema`, `Transcript`, `TranscriptFrame`, `TabAxis`, and `TabAxisValue` round-trip through encode/decode.
- **Type gate (§13.3):** generated `test/mdx/**/*.test.ts` passes `tsc --noEmit`.
- **Reporter gate:** the source-mapper reporter is exercised by a fixture pair (multi-axis MDX + seeded failure → expected reporter output, with the variant prefix asserted).
- **Redaction gate:** a fixture transcript whose contents include every redaction class redacts byte-identically to the canonical golden frame.

### 19.11 Test layer position

Executable tutorials add one row to the §13.1 test-layer table and one column to the §13.6 CI matrix. Per-PR CI runs every variant of every `layer: "scenario"` tutorial on every supported platform plus the `@smoke`-tagged subset of `layer: "e2e"` variants on Linux x64. Nightly runs every `layer: "e2e"` variant on Linux x64/arm64 and macOS x64/arm64. The weekly provider matrix runs every `layer: "e2e"` variant against every provider in the matrix.

Per-variant budgets: scenario variants must hold p95 < 30 s; e2e smoke variants must hold p95 < 5 min including provider setup (`lando setup` cost is measured separately and excluded). These are advisory at v4.0 GA and become merge gates once the perf-budget suite's tutorial coverage is in place (§13.1).

Authors are expected to be deliberate about axis fan-out. A tutorial declaring `axes: { v: [a,b], pm: [c,d,e] }` produces six variants, each running on every per-PR platform. Per-axis-value `platforms:` and per-cell `variants:` overrides are the right tool when the matrix is broader than CI cost allows.

### 19.13 Recipe README integration

`recipes/<id>/README.mdx` is the canonical location for an executable tutorial that walks a user through a canonical recipe (§8.8.2). The MDX rendered into the docs site uses the full vocabulary; the file copied into the user's project at scaffold time is a **prose-only render** of the same MDX with executable components stripped or flattened.

`scripts/build-recipe-readmes.ts` (§17.2 codegen catalog) performs the strip and writes `recipes/<id>/.scaffold/<axis-value>[.<axis-value>...].md` for every legal axis-value combination. The cell selected at scaffold time is the one matching the user's resolved `lando init` answers (the recipe manifest declares the prompt-answer→axis-value mapping; see §8.8). This guarantees that what the user sees in their scaffolded project is plain Markdown — never an MDX file with broken JSX imports — and is single-variant rather than tab-confusing.

The strip rules: `<Tutorial>` is unwrapped, `<Step>` becomes a numbered Markdown heading, `<Run>` becomes a fenced code block of the *displayed* command (transcript omitted because the user's context will produce different output), `<Verify>` and `<Hidden>` are omitted, `<Inspect>` becomes a fenced block of the most recent transcript value (or "(generated at runtime)" when none exists), `<Variable>` is replaced by its `display` at every interpolation site, `<Cleanup>` becomes a final "Cleanup" section listing displayed commands, `<Inline>` becomes a `ts` fenced block, and `<Tabs>` is resolved to the chosen tab's content. Recipe authors MAY set `<Tutorial scaffoldStrip={false}>` to suppress the strip and copy the MDX directly — rare and explicit; the author then takes responsibility for editor-side rendering.

### 19.14 Library-mode tutorials

Tutorials that document the embedding API (§16) target the library entry points instead of the binary. `<Run runtime="appStart" />` invokes `LandoRuntime` operations directly through `TutorialContext.runtime`; the rendered docs show the host TypeScript code (using `makeLandoRuntime` and the targeted method) rather than a CLI command. The same `<Verify>`, `<Inspect>`, `<Cleanup>`, and `<Tabs>` vocabulary applies. Mixing CLI and runtime forms in one tutorial is allowed and common (a host walking through `runTooling` for a build step followed by `runCli` to spawn an interactive subshell). The lint gate enforces that every `<Run runtime="…" />` is paired with a rendered TypeScript snippet showing the host code.

### 19.15 Acceptance criteria

The §15.C checklist gains the following items, all release-blocking for v4.0 GA:

- Every executable tutorial under `docs/src/content/docs/{tutorials,how-to}/**` and every `recipes/<id>/README.mdx` containing `<Tutorial>` produces a passing generated test (or variant set) on the per-PR matrix.
- The tutorial linter and the source-mapper reporter pass on every supported platform; the reporter translates a known-failing fixture into MDX coordinates with no off-by-one errors, including the variant axis-value prefix when the fixture declares axes.
- Every component prop schema in `@lando/sdk/docs/components` round-trips through the §13.2 schema gate, including `TabsProps`, `TabProps`, `TabAxis`, and `TabAxisValue`.
- The redaction gate passes against a fixture transcript exercising every redaction class.
- Every `layer: "e2e"` tutorial's cleanup is idempotent under the second-invocation harness.
- Every recipe README's strip-and-flatten output scaffolds into a directory whose `README.md` contains no MDX JSX, no `import` statements, no unresolved interpolation expressions, and no `<Tabs>`/`<Tab>` markers.
- A multi-axis fixture tutorial (≥ 2 axes, ≥ 2 values per axis) generates the full Cartesian product of test files, each runs cleanly, and the reporter prefixes failure output with the variant axis-value map.

### 19.16 Tabbed variants

Tutorials often need to branch (Drupal 10 vs 11, Composer vs npm, macOS vs Linux). v4 makes the tabs the source of truth for the test matrix.

**Axes.** A tutorial declares zero or more axes in frontmatter. Each axis has a name and an ordered list of values. The variant set is the **Cartesian product** of every axis's values; a tutorial with no axes has the singleton variant. Two declaration forms (mutually exclusive):

- `tabs:` — single-axis sugar; implicit axis name `default`.
- `axes:` — explicit multi-axis; each key is the axis name, each value is a `TabAxis` declaration with its values.

The `TabAxis` and `TabAxisValue` schemas live in `@lando/sdk/docs/components`. Each `TabAxisValue` carries a `name`, `label`, optional `icon`, optional `default: true` (exactly one per axis when there is more than one value), and may refine `tags`/`platforms`/`skip` for that axis-value's variants. The frontmatter `variants:` map provides per-cell overrides keyed by the dot-joined axis-value path. Resolution order (later wins): tutorial-wide → per-axis-value → per-cell.

**`<Tabs>`/`<Tab>`.** A `<Tabs axis="A">` block iterates axis A; each `<Tab name="V">` provides the content for variants whose A-value is V. The `axis` prop is required when the tutorial has more than one axis and inferred otherwise. Multiple `<Tabs>` blocks are allowed and orthogonal — same-axis blocks concatenate their per-tab content; different-axis blocks compose Cartesian-product-style. **Nesting is forbidden.** Multi-axis variation is expressed by separate top-level `<Tabs>` blocks each on their own axis. The `syncKey` prop mirrors Starlight's cross-page tab synchronization and is purely a UX feature.

**Coverage gaps.** Within a single `<Tabs>` block, not every tab needs to include every step. The codegen rule: the union of `<Step name>` values across all tabs in a block defines the block's step set; for any step name a matched tab does not include, the variant emits `test.skip(<step-name>, "axis A=V tab does not include step <step-name>")`. For variants whose axis value is not represented by any tab in this block, the block emits one `test.skip` per step in the union. This keeps test reports honest — readers see exactly which steps are absent for which axis values.

**Naming.** Generated test files use dot-separated axis-value suffixes in declaration order: `<id>.test.ts` (no axes), `<id>.<value>.test.ts` (`tabs:`), `<id>.<axis1-value>.<axis2-value>.....test.ts` (`axes:`). The `describe()` block matches.

**Rendering.** Each `<Tabs>` block renders as a Starlight tab group. The transcript embedded in each tab pane is the transcript captured for *that variant's* run; switching tabs swaps both the displayed command set and the captured output.
