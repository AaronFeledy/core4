# Lando v4: Executable Guides and Scenarios

> **Part 17 of 20** · [Index](./README.md)
> **Read next:** [18 The Global App](./18-global-app.md)

This part defines how MDX-authored user guides generate runnable scenarios without turning reader prose into test syntax.

---

## 19. Executable Guides and Scenarios

### 19.1 Mission

An executable guide is a prose-first MDX guide that defines Scenarios, the engine's runnable units. Readers receive clear Markdown, CI receives deterministic execution and assertions, and authors keep visible promises with closely related edge coverage.

Components are the executable minority. Documentation MUST remain Markdown; component props are machine hints, not prose. Non-executed examples stay outside `<Scenario>`. A scenario MUST execute or assert behavior.

Executable components are allowed only in the guide discovery roots:

- `docs/guides/**/*.mdx`
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

`MatcherSchema` is the assertion vocabulary for `<Verify>` and `<Inspect>`. A scalar (string, number, boolean, null) matches by deep equality. An array matches an array of the same length element by element. A plain object is a partial object matcher: every listed key MUST match, and unlisted keys are ignored. An object whose single key is one of the named operators is an operator: `regex` tests the stringified value against a pattern, `schema` names a schema from the canonical public schema registry in `@lando/sdk/schema` and validates that the value conforms to that schema's encoded (input) shape, equivalent to `Schema.is(Schema.toEncoded(codec))`; it MUST NOT be read as full decoder validation, because codec transformations and decoder-only refinements are not applied, so a value that matches MAY still be rejected by the canonical decoder, `anyOf` accepts when any listed matcher matches, and `not` negates one matcher. A `schema` name that is not registered does not match, so the verification fails when the generated test runs. The operator keys `exact`, `allOf`, and `oneOf` are reserved and rejected; partial objects MUST NOT use any reserved key. Other assertions require justified `<Inline>`.

`<Run command>` and `<Verify command>` accept an optional integer `expectExit`, defaulting to zero. Command verification MUST enforce that exit code before checking output matchers; `expectExit` is invalid on other verification targets. A negative lint report therefore uses explicit exit 1 in every format while retaining its report assertions, without a shell wrapper that hides the status.

`<Hidden>` MUST NOT define distinct product behavior. `<Inline>` MUST remain exceptional. `<Variable>` display values MUST be short substitutions, never explanatory sentences.

Component placement is fail-closed. `<Guide>` is a root-level element. `<Scenario>` is a direct child of `<Guide>`. `<Step>`, `<Hidden>`, `<Skip>`, and `<Tabs>` are direct children of `<Scenario>`; `<Tab>` is a direct child of `<Tabs>`; `<Hidden>`, `<Skip>`, and `<Tab>` contain only `<Step>`. Leaf actions (`<Run>`, `<Verify>`, `<Cleanup>`, `<Variable>`, `<UseFixture>`, `<Inspect>`, `<Inline>`) are direct children of `<Step>`. Markdown prose MAY appear inside any wrapper. An executable component anywhere else, including a wrapper nested in another wrapper or an executable component written inline within a paragraph, MUST be rejected with its source path and line rather than silently ignored.

### 19.4 The ScenarioContext

Every generated scenario acquires an Effect `Scope` and one `ScenarioContext`. The context owns guide/scenario identity, resolved variant, isolated working directory, scenario or real runtime, the resolved variable bindings, CLI and shell invocation, lifecycle events, transcript writing, and fixture resolution.

The context is the execution-time view of one resolved scenario (§19.7). It receives bindings already validated and resolved for its scenario and variant; it MUST NOT re-interpolate, re-declare, or mutate them. Hidden and visible bindings are both available to execution; visibility only governs public output (§19.9).

`ScenarioContext` is stable across providers, layers, and variants, and is part of `@lando/core/testing` (§16.8). Scope finalization removes temporary state unless an explicit author/debug option preserves it.

### 19.5 Display vs. execute

Display and execution are bound by default. They MAY diverge only through explicit display props; inferred rewriting is forbidden. Variable interpolation is the preferred substitution mechanism: public output uses `display`, falling back to `value` when no display is set, and execution uses `value`.

`<Variable>` carries `name`, `value`, and optional `display`. An interpolation site is a simple identifier token in double braces, `{{name}}`, with optional whitespace permitted around the identifier (`{{ name }}` resolves the same binding); dots and expressions are not interpolation syntax. A whitespace-padded token whose identifier has no binding is an unresolved reference and MUST fail like any other. Only `Run.command`, `Verify.command`, `Verify.file`, `Inspect.file`, and `Inspect.json` interpolate guide bindings. Shell payloads, library `code` and `displayCode`, `<Inline>` code, matcher values, and recipe answers are opaque and stay literal; a dotted or foreign template token inside them is not a guide reference and MUST NOT be rewritten or diagnosed.

An empty string is a valid bound value. Display values MUST be short literals such as paths, names, or masked credentials, never explanatory prose; this is an authoring requirement enforced by review, not a subjective machine check. A `display` value masks what readers see and is not secret storage: raw credentials MUST NOT appear in `value` or `display` of committed MDX. Divergence between display and execution MUST be explicit through bindings or display props; the compiler imposes no count-based or percentage limit on it.

### 19.6 Transcripts

Each scenario variant captures stdout, stderr, exit status, lifecycle events, inspected artifacts, and cleanup status as a `Transcript` of `TranscriptFrame` values under `dist/transcripts/`.

| Surface | Contract |
|---|---|
| Internal transcript | Contains all sanitized frames, including hidden, test-only, fixture, event, and cleanup frames; consumed by CI and diagnostics. |
| Public transcript | Generated statically from the resolved scenario at codegen time; contains only visible frames from rendered reader scenarios; consumed by docs and recipe README generation. Not execution evidence. |

Transcripts are regenerated, gitignored, and never committed. Public output MUST NOT include hidden blocks, test-only scenarios, internal event traces, or fixtures. When public output is unavailable, the docs renderer MAY show the static command and an explicit uncaptured-output placeholder rather than fabricate output.

All frames use the canonical transcript redaction profile (§3.7): registered secrets and shell/Bun payloads are redacted; temporary paths, timestamps, container ids, ports, and route salts are normalized. The redaction vocabulary is published from `@lando/sdk/docs/redactions` and MUST match the §13 contract gate byte-for-byte.

### 19.7 Codegen contract

`scripts/build-guide-scenarios.ts` is the canonical §17.2 codegen entry. A transitional `build-doc-tests` alias MAY exist, but MUST delegate without changing semantics.

Inputs are the allowed MDX locations and supported colocated case files. Outputs are one gitignored TypeScript test per scenario variant plus a generated index under `test/scenarios/generated/`.

Generation MUST validate frontmatter and props, resolve variants, flatten the component tree, preserve visibility, and emit deterministic tests. Identical inputs MUST produce byte-identical outputs. Because outputs are uncommitted, the gate is successful generation, typecheck, and execution under the applicable §13.6 matrix. `bun run dev:guides` regenerates and runs affected scenarios during authoring.

One private build-time compiler owns guide semantics. It parses a guide into a validated AST and resolves each scenario once per selected variant into a resolved scenario: ordered steps, public steps, bindings, skips, selected tabs, and run mode. Test generation, public transcript emission (§19.6), scaffold README generation (§19.13), and semantic lint (§19.10) MUST consume that resolved scenario rather than re-parsing MDX or re-implementing interpolation, so one guide yields consistent, explicitly projected substitutions in every output: execution consumes `value`, and public transcripts and scaffold READMEs consume the same `display` projection (§19.5). Outputs differ only by that declared projection, never by independent parsing. Additional documentation adapters MUST preserve these semantics and SHOULD reuse the compiler rather than define independent binding or variant rules; adapter integration may be sequenced separately.

Bindings are collected for the whole scenario and selected variant before any reference is resolved, so a reference MAY precede its declaration in step order. Bindings are immutable within a scenario: a second declaration of the same name, visible or hidden, is an error. The same name MAY be declared independently in different scenarios and in mutually exclusive `<Tab>` blocks of one group, because only one is active per variant.

### 19.8 Source-location preservation

Generated tests MUST preserve source path, line range, scenario, variant, step, and fixture provenance. The scenario source-mapper reporter MUST rewrite the primary failure location to MDX or colocated case source while retaining the generated frame as secondary evidence. Reporter fixtures MUST cover mappings and prevent off-by-one drift.

### 19.9 Hidden, test-only, and fixture discipline

- `<Hidden>` supports only the current scenario.
- A hidden step MAY reference visible or hidden bindings. A visible component MUST NOT reference a binding declared only in a hidden step, even when that binding supplies a `display`, because public output would show a value whose declaration readers cannot see. A test-only scenario has no public components, so this rule does not apply inside it.
- A test-only scenario MUST declare `render={false}`, a reason, tags, and ownership metadata when available; it MUST execute or assert behavior.
- Variable-only or documentation-only scenarios are forbidden.
- Non-documentary behavior belongs in standalone fixture scenarios.
- Fixtures are immutable and copied before mutation; shared fixtures require explicit ownership.
- Core invariants graduate to the regular scenario suite. Guide-specific promises stay with the guide. Coverage reused by three guides is no longer guide-specific.
- Provider-unstable coverage SHOULD move to e2e/nightly rather than weakening a reader guide.

### 19.10 Lint and quality gates

`bun run lint:guides` is a merge gate and MUST enforce:

- `GuideFrontmatter`, scenario, component, matcher, transcript, tab, and variant schema validity.
- Component placement (§19.3): a misplaced, nested, or inline executable component fails with its source path and line.
- Allowed Diátaxis buckets and unique scenario/step ids.
- At least one reader scenario unless explicitly test-only.
- Required reasons, ownership metadata, and cleanup for every e2e scenario variant.
- Hidden and inline discipline.
- No raw shell fence inside a scenario; executable shell uses `<Run>` or justified `<Inline>`.
- Binding semantics from §19.5 and §19.7: every binding is referenced, every reference resolves, no name is declared twice in one scenario, and no visible component references a hidden-only binding. These are machine-enforced by the shared compiler; display literal quality remains an authoring requirement.
- Every scenario contains an action or assertion.
- Markdown remains the dominant reader surface.
- Event assertions reference the canonical event registry.
- Tabs do not nest and every tab or per-cell override resolves to a declared axis value.

A binding diagnostic MUST name the guide source path and line, the scenario and resolved variant, and a remediation, and MAY name the related declaration line. It MUST NOT print bound values. Every failure includes a copy-pasteable rerun command (§19.12).

Schema round-trip, generated-test typecheck, source-mapper fixtures, public-transcript policy, and canonical redaction are cooperating merge gates (§13.2–§13.4).

### 19.11 Test layer position

Per-PR CI runs all scenario-layer variants on every §13.5 compile target, including `windows-arm64`, and the e2e smoke subset on Linux x64. Nightly CI runs all e2e variants on the §13.6 nightly platforms. The weekly matrix runs e2e variants against every applicable provider (§13.6). A guide-scenario job MUST emit enough per-step output to distinguish a hang from slow progress before its timeout is tuned; a cap reached with no attributable step output is a defect in the job, not evidence for a longer cap.

Scenario variants SHOULD remain below 30 seconds p95 and e2e smoke below 5 minutes p95, excluding separately measured provider setup. These budgets are advisory until §13 perf coverage includes guide scenarios, at which point they become merge gates. Authors MUST constrain axis fan-out with platform and cell overrides rather than silently dropping cells.

### 19.12 Author commands

The author workflow MUST run a guide, scenario, variant, step, or fixture; preserve the workspace on request; update local transcript artifacts; explain the resolved scenario plan; and print source maps and resolved bindings in debug mode. Every failure MUST include a copy-pasteable rerun command.

### 19.13 Recipe README integration

`recipes/<id>/README.mdx` is the canonical recipe guide (§8.8.2). `scripts/build-recipe-readmes.ts` generates one prose-only scaffold README per legal variant cell and selects the cell from resolved recipe answers.

Strip-and-flatten consumes the resolved scenario (§19.7). It MUST unwrap the guide and rendered reader scenario, keep authored scenario and step order including steps from the selected tab, turn steps into numbered headings, render displayed commands as fences, omit hidden and test-only content, substitute variable displays, flatten cleanup into a final section, resolve tabs to the selected cell, and include inspected public output only when captured. The cleanup section hoists the cleanup step's ordered fences and coalesces only adjacent fences of the same language; it does not change cleanup execution semantics. Output MUST contain no MDX JSX, imports, test-only content, or unresolved guide references; opaque foreign template syntax inside literal props is not a guide reference and is preserved. `scaffoldStrip={false}` MAY explicitly preserve MDX.

A scaffold README MUST exist for every declared legal variant cell, including cells whose execution is skipped. `<Skip>` bodies are not executed and their bindings and references are not active, but an execution-skipped variant still validates. A static command in a scaffold README is not evidence that it ran; execution evidence comes only from captured execution data (the internal transcript, §19.6) and passing generated tests. The public transcript is a generated static inventory (§19.6) and is not execution evidence either, and skipped or test-only scenarios produce no public transcript.

### 19.14 Library-mode guides and scenarios

Embedding guides (§16) MAY target runtime operations and `App` handles instead of the binary. Rendered docs MUST show the corresponding host TypeScript. Command-shaped library operations MAY use `@lando/core/cli`; lifecycle guides SHOULD prefer `App` handles.

Each scenario runs in exactly one mode: CLI or shell commands, or library `<Run runtime="library">`. Mixing modes within one scenario is an error, and an `e2e` scenario is CLI only. CLI and library forms MAY coexist on one page as separate scenarios when the reader workflow needs both. Library `code` and `displayCode` are opaque to guide interpolation (§19.5).

### 19.15 Acceptance criteria

The following augment §15.C and define executable-guide acceptance:

- Every executable guide and recipe README generates passing tests for every applicable variant or carries an explicit skip reason.
- Test-only scenarios remain absent from rendered docs and public transcripts while failures map to authored source.
- Guide lint, source mapping, component schemas, transcript redaction, and public transcript gates pass on every supported platform.
- Every e2e cleanup path is idempotent under a second invocation.
- Every scaffold README is prose-only and free of unresolved executable syntax.
- A multi-axis fixture generates and runs the full Cartesian product, and failures identify the scenario and variant map.

### 19.16 Tabbed variants

`tabs` is single-axis sugar and `axes` declares named multi-axis values; they are mutually exclusive. `TabAxis` and `TabAxisValue` name ordered values, labels, optional icons/defaults, and optional tag/platform/skip refinements. The variant set is the Cartesian product, with precedence: guide-wide, then axis value, then cell override, then scenario-local override.

`<Tabs>` selects an axis and `<Tab>` selects a declared value. Multiple orthogonal tab groups are allowed; nesting is forbidden. Missing steps in a tab cell MUST be emitted as explicit skipped tests, not silently omitted, so coverage gaps remain visible.
