# PRD: ALPHA4-12 — Terminal UI polish & interaction service

## Introduction

The renderer contract in §8.9 already describes the default `lando` renderer as interactive and colorful. In practice, a renderer can satisfy the event boundary while still feeling flat, overly textual, or hard to scan during setup, init, builds, and release-style summaries. This PRD adds a small Alpha 4 polish pass: move the default user renderer behind a bundled internal `@lando/renderer-lando` plugin, then improve the terminal UI's hierarchy, prompts, progress, and summary surfaces with a futuristic spaceship interface vibe, without changing command semantics or turning the entire CLI into a full-screen TUI.

OpenTUI is allowed as an implementation dependency for bounded TTY surfaces because its Core API exposes an imperative renderer plus composable renderables (`TextRenderable`, `BoxRenderable`, `ScrollBoxRenderable`, `InputRenderable`, `TextareaRenderable`, `SelectRenderable`, `TabSelectRenderable`) and Yoga/Flexbox-style layout primitives. The intent is to use those primitives behind the existing `Renderer` and prompt seams where they help, while preserving the non-TTY, `plain`, `json`, and CI output contracts.

Depends on: **ALPHA4-01** (setup/uninstall renderer and prompt surfaces), **ALPHA4-04** (schema publication for `PromptSpec`), **ALPHA4-05** (plugin authoring prompts), **ALPHA4-07** (public transcript and guide rendering expectations), and **ALPHA4-11** (§17.9 acceptance/perf gates). This PRD does not add unrelated commands, flags, lifecycle events, or product behavior; its new surface is limited to the `InteractionService`/`PromptSpec` primitive and prompt consolidation described below.

This PRD also absorbs the shared `InteractionService` primitive and prompt consolidation work. Interaction belongs with terminal UI polish because it is the input peer of the renderer seam: prompt vocabulary, answer-source precedence, interactivity mode, and prompt chrome must be coordinated with the default renderer and OpenTUI-backed bounded surfaces.

Interaction work keeps its external dependencies on **ALPHA4-01** (setup prompts/confirmations), **ALPHA4-04** (schema publication), **ALPHA4-05** (plugin authoring prompts), and **ALPHA4-11** (SDK/library acceptance + App-handle embedding); renderer coordination is now internal to this PRD.

## Source References

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.9 renderer events, first-paint contract, and concurrent task tree contract.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1 perf-budget renderer tests.
- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) §19.6 public transcript safety and §19.10 guide lint discipline.
- [`spec/ROADMAP.md`](../ROADMAP.md) Phase 4 feature freeze and Phase 8 renderer-plugin follow-up.

### InteractionService source references

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.10 interaction-and-prompts contract, §8.10.1 prompt vocabulary, §8.10.3 answer-source precedence, §8.8.3/§8.8.5 recipe prompts.
- [`spec/03-architecture.md`](../03-architecture.md) §3.4 `InteractionService` service membership and bootstrap-level table.
- [`spec/04-pluggability.md`](../04-pluggability.md) §4.2 `InteractionService` catalog entry and `interactionServices:` manifest contribution.
- [`spec/10-plugins.md`](../10-plugins.md) §9.4/§9.5 contribution surface and interaction-service contribution rules.
- [`spec/09-embedding.md`](../09-embedding.md) §16.2 service tag, §16.3 `interaction` option, §16.7 host-drivable `apps:init`, §16.8 `TestInteractionService`.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1 interaction contract suite.
- [`spec/alpha-4/prd-alpha-4-00-index.md`](./prd-alpha-4-00-index.md) verification contract and SDK/schema rules.

## Goals

- Make the default TTY renderer a bundled internal plugin (`@lando/renderer-lando`) that dogfoods the public renderer contribution shape and serves as the example for third-party renderer authors.
- Make that default TTY renderer feel like a compact spaceship operations console: futuristic, precise, luminous, and easy to scan while staying faithful to existing render events.
- Use OpenTUI field and layout primitives only for bounded interactive surfaces: prompts, selectable lists, task-tree panes, and summaries.
- Preserve machine output exactly: `--renderer=json`, non-TTY/CI output, and `--renderer=plain` remain stable and parseable.
- Prove the visual language with snapshot-style terminal tests and narrow-terminal fixtures before implementation is considered accepted.

### InteractionService goals

- Publish `InteractionService` as the canonical service for every interactive prompt/answer flow in Lando.
- Promote the recipe-scoped prompt vocabulary to a general `PromptSpec` owned by §8.10; redefine `RecipePrompt` in terms of it without breaking the frozen recipe schema surface.
- Centralize the answer-source precedence (explicit answer → default-under-`--yes` → interactive prompt → fail) and the interactivity-mode gate (`auto`/`interactive`/`non-interactive`) into one shared module both dispatch paths import.
- Close the prompt-type divergence by shipping the `editor` type the spec already documents.
- Expose an SDK-safe contract and `interactionServices:` manifest surface for headless/CI, recording/test, and GUI/host implementations, and an `interaction` policy for embedding hosts.
- Migrate `apps:init`, `meta:plugin:new`, the `meta:plugin:add` trust gate, and `meta:setup` confirmations onto one service.
- Add a mandatory contract suite so plugin-contributed and host-supplied interaction services cannot weaken `secret` redaction, answer precedence, or non-interactive fail-fast.

## Visual North Star

The default TTY renderer should feel like a mission-control panel aboard a small spacecraft: dense where density helps, quiet where output needs attention, and animated only when motion communicates live system state.

The visual language should use:

- **Palette:** deep-space base tones, low-contrast grid/border lines, cyan/teal telemetry accents, warm amber warnings, and high-signal red failures. Avoid generic rainbow output and purple-on-white gradients.
- **Structure:** panelized sections, cockpit-style status chips, aligned telemetry columns, compact progress rails, and subtle separators that imply instrumentation rather than boxed enterprise dashboards.
- **Motion:** restrained scanner/spinner/progress movement for active work only; no decorative animation that risks first-paint or CI readability.
- **Tone:** concise labels that read like operational telemetry (`ONLINE`, `SYNCING`, `CACHED`, `BLOCKED`, `MANUAL`) while preserving user-friendly remediation text.
- **Fallback:** monochrome terminals and no-color mode keep the same hierarchy through spacing, labels, and glyph/text redundancy.

## User Stories

### US-280: Bundled renderer plugin seam and visual language

**Description:** As a plugin author and CLI user, I can see the default Lando renderer shipped as a bundled internal plugin and get a recognizable spaceship-console terminal style instead of generic flat text.

**Acceptance Criteria:**

- [ ] A renderer visual-language document defines the spaceship-console direction: palette, status colors, icons, spacing, borders, dimming, headings, progress rails, panel separators, and narrow-terminal wrapping rules for the default `lando` renderer.
- [ ] The old `@lando/renderer-listr` stub is replaced by `@lando/renderer-lando`, with a current-schema manifest declaring `contributes.renderers: ["lando"]` and a `renderer` layer export that becomes the default TTY renderer implementation.
- [ ] Bundled-plugin codegen and renderer resolution can load the `lando` renderer from the bundled plugin while preserving core `plain`, `json`, and `verbose` fallback modes for CI, non-TTY, and debug output.
- [ ] Plugin authoring docs and examples point renderer authors at `@lando/renderer-lando` as the first-party example rather than a separate Listr-themed stub.
- [ ] Golden terminal fixtures cover success, warning, failure, setup plan, uninstall plan, and long-running task states at common widths (80, 100, 120 columns).
- [ ] The visual language preserves accessibility basics: status is never color-only, icons have text fallbacks where needed, and narrow terminals remain readable.
- [ ] The visual language rejects generic CLI styling: no undifferentiated rainbow logs, no default SaaS-purple gradients, no dense ASCII art that harms scanability, and no decorative motion unrelated to live state.
- [ ] `plain`, `json`, non-TTY, and CI output are explicitly excluded from decorative changes except where the existing spec already requires stable prefixes.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-281: Beautiful task-tree progress for builds and setup

**Description:** As a user waiting on setup, builds, file sync, or release checks, I can immediately see what is running, what is cached, what failed, and where to expand for detail.

**Acceptance Criteria:**

- [ ] The default TTY renderer implements the §8.9.2 task-tree layout with cockpit-style parent headers, child rows, scanner/progress states, cached/skipped badges, failure hints, and dimmed four-line detail tails.
- [ ] Keyboard focus, `Enter` expand, and `Esc` collapse behavior remain scoped to TTY mode and still publish `task.detail.expand` / `task.detail.collapse` events.
- [ ] OpenTUI layout primitives may be used for the TTY task-tree pane, but task publishers continue to emit only the existing `task.*` render events.
- [ ] Non-TTY output keeps the stable `[<stepId>]` detail-line prefix and no alt-screen behavior.
- [ ] Perf-budget tests still satisfy first-paint, spinner-threshold, and completion-line latency rules.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-282: OpenTUI-backed prompts for setup, init, and trust decisions

**Description:** As a user answering interactive prompts, I get readable fields, selects, multi-selects, and confirmations with helpful descriptions and validation feedback.

**Acceptance Criteria:**

- [ ] The renderer prompt seam can render TTY prompts through OpenTUI `input`, `textarea`, `select`, and `tab-select` style controls with the same spaceship-console palette and panel rhythm, without changing prompt schemas or command inputs.
- [ ] `apps:init` recipe prompts, `lando setup` provider choices, and plugin trust decisions share the same prompt visual treatment.
- [ ] `--yes`, `--no-interactive`, `--answer`, `--answers`, env-driven installer setup, and CI/non-TTY paths bypass OpenTUI and preserve current deterministic behavior.
- [ ] Validation errors are shown inline in TTY prompts and still surface as tagged errors with remediation in non-interactive paths.
- [ ] Prompt tests cover keyboard navigation, cancellation, validation failure, defaults, and terminal resize.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-283: Polished summaries for plans, info, and diagnostics

**Description:** As a user reading command results, I can scan plans and diagnostics through clear grouped summaries instead of dense unstructured lines.

**Acceptance Criteria:**

- [ ] Setup readiness, uninstall dry-run, `app:info`, scratch/global list output, and deprecation/doctor summaries render as grouped spaceship-console sections with consistent headings, status chips, aligned telemetry labels, and actionable next steps in the default TTY renderer.
- [ ] The rendering is driven by typed result/message records and existing table/message render events, not by command-specific stdout writes.
- [ ] The same data still renders to `json`, `plain`, and non-TTY modes without decorative layout artifacts.
- [ ] Summary fixtures include long paths, long service names, CJK/wide characters, hidden secrets/redaction markers, and small terminal widths.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-284: Visual QA gate for the terminal renderer

**Description:** As a maintainer, I can review renderer changes with objective terminal snapshots so the UI does not regress back to drab or unreadable output.

**Acceptance Criteria:**

- [ ] A terminal-renderer visual QA harness captures deterministic TTY frames for the fixtures owned by US-280 through US-283.
- [ ] Visual QA fixtures include explicit spaceship-console reference frames so reviewers can reject output that is technically structured but visually drab.
- [ ] Snapshot diffs are readable in CI and include enough context to identify spacing, color-token, truncation, and wide-character regressions.
- [ ] The harness runs without a real provider, network, signing credentials, or host mutation by using `TestRuntimeProvider` and injected renderer events.
- [ ] The visual QA gate is focused on renderer output only and does not snapshot `json`, `plain`, or non-TTY logs except for regression fixtures that prove they remain undecorated.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

The following stories are folded in from the InteractionService primitive scope.

### US-293: Publish the `InteractionService` SDK service, `PromptSpec` vocabulary, errors, and manifest surface

**Description:** As a plugin author or embedding host, I can resolve and replace Lando's prompting through a stable `InteractionService` contract and a published prompt vocabulary instead of importing recipe-internal helpers.

**Acceptance Criteria:**

- [ ] `@lando/sdk/services` exports the `InteractionService` service tag and typed interface (`prompt`, `promptAll`, `confirm`, `select`, `secret`, `isInteractive`) with Effect-returning methods.
- [ ] `@lando/sdk/schema` exports `PromptSpec`, `PromptType` (eight literals incl. `editor`), `PromptChoice`, `PromptValidate`, `PromptAnswer`, `PromptBatchOptions`, and `ChoicesFrom`; `RecipePrompt` is redefined as `PromptSpec` plus the recipe-only `when:`/`deprecated:` fields with an unchanged serialized shape.
- [ ] `@lando/sdk/errors` exports tagged errors `InteractionRequiredError`, `PromptValidationError`, `InteractionCancelledError`, `ChoicesUnavailableError`, and `InteractionUnavailableError`; `RecipeMissingAnswerError`, `RecipePromptValidationError`, and `RecipeChoicesError` are preserved as aliases of the generalized errors.
- [ ] Plugin manifests accept `provides.interactionServices[]` with `capabilities` (`interactive`, `promptTypes`, `secretRedaction`), module path containment, deprecation metadata, and standard §4.3 selection behavior.
- [ ] `sdk/API_COMPATIBILITY.md`, SDK export fixtures, the JSON Schema registry + `SDK_SCHEMA_NAMES`, and `sdk/test/fixtures/schema-snapshot.json` are updated in the same change with `bun run codegen:schema-snapshot` producing no further drift.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-294: Implement the default `InteractionServiceLive`, answer-source precedence, and renderer coordination

**Description:** As a user, every Lando prompt resolves through one implementation with consistent answer precedence, interactivity detection, and secret masking.

**Acceptance Criteria:**

- [ ] `InteractionServiceLive` wraps the existing `collectPrompts` engine behind the Effect interface; `PromptIO` becomes an internal Live-layer detail and is no longer the public prompting surface.
- [ ] The service is constructed lazily via `Layer.suspend` at bootstrap level `minimal`; a command that never prompts allocates no reader and touches no stdin, and construction touches no network/provider/plugin module.
- [ ] Answer-source precedence resolves in order: explicit answer (`answers`/`answersFile`) → default when `--yes`/non-interactive → interactive prompt → `InteractionRequiredError`; `mode: "auto"` gates interactivity on a TTY stdin.
- [ ] A shared flag module parses `--answer` (repeatable), `--answers <file>`, `--yes`, `--no-interactive`, and `--interactive` and computes the interactivity gate; both the OCLIF command path and the compiled `run.ts` dispatcher import it, and the scratch `--option` synonym merges into the same answer source.
- [ ] `secret` answers are returned as `Redacted.Redacted<string>`, never echoed, never logged, and absent from transcripts and error messages.
- [ ] Prompt output routes through `Renderer.output.stdout` when a `Renderer` is resolvable via `Effect.serviceOption`, and falls back to a direct stdio write only when no renderer is active; the Live-layer stdin reader and no-renderer fallback writer are the declared §13.4 renderer-boundary carve-outs.
- [ ] `Effect.interrupt` during a prompt surfaces `InteractionCancelledError` and restores TTY raw-mode state before propagating.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-295: Ship the `editor` prompt type and close the 7-vs-8 divergence

**Description:** As a recipe author, I can use the `editor` prompt type the spec documents, and the SDK enum, runtime, and docs agree on the eight prompt types.

**Acceptance Criteria:**

- [ ] `PromptType` (and the recipe re-export) includes `editor`; the prompt runtime handles `editor` by opening `$VISUAL`/`$EDITOR` through `ProcessRunner`, reading the edited buffer back, and applying the prompt's `validate` rules.
- [ ] `editor` falls back to `text` semantics when no editor is configured or when the resolved mode is non-interactive (or `--no-interactive` is set), with no hang.
- [ ] The schema snapshot, JSON Schema output, and any generated reference docs reflect eight prompt types; no spec/SDK/runtime divergence remains.
- [ ] A scenario or unit test exercises an `editor` prompt with a scripted editor command and asserts the captured multi-line value.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-296: Migrate existing prompt call sites onto `InteractionService`

**Description:** As a maintainer, I can reason about one prompting path instead of auditing near-duplicate prompt loops across init, plugin authoring, plugin trust, and setup.

**Acceptance Criteria:**

- [ ] `apps:init` resolves recipe prompts and the tarball-checksum confirmation through `InteractionService` (`promptAll`/`confirm`); the local `resolveIO` and the hard-coded `yes:false, nonInteractive:false` gate are removed.
- [ ] `meta:plugin:new` builds a `PromptSpec[]` (name/template/cspace/description) and resolves it through `promptAll`; its bespoke `readAnswer` loop is removed.
- [ ] The `meta:plugin:add` trust confirmation uses `interaction.confirm(...)`, and the non-interactive trust failure surfaces `InteractionRequiredError` with the existing `--trust` remediation preserved.
- [ ] `meta:setup` confirmations resolve through `InteractionService`; `--yes`/`--no-interactive` route through the shared flag module.
- [ ] Inlined `process.stdin.isTTY !== true` interactivity checks across `run.ts`, the OCLIF commands, and the affected command modules are replaced by the shared interactivity gate.
- [ ] Source-mode and compiled `$bunfs` dispatch resolve answers and interactivity identically; dispatch-parity tests cover `apps:init`, `meta:plugin:new`, and `meta:plugin:add --trust`.
- [ ] The recipe-scoped `collectPrompts`/`PromptIO` modules are reduced to Live-layer internals (or removed) with no public-surface consumers outside the Live layer.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

### US-297: Enforce the interaction contract suite, `TestInteractionService`, redaction, and embedding wiring

**Description:** As a maintainer, security reviewer, or embedding host, I can prove every built-in, plugin-contributed, or host-supplied interaction service preserves the spec's guarantees, and I can drive prompt flows without a terminal.

**Acceptance Criteria:**

- [ ] `@lando/core/testing` exports `TestInteractionService` (pre-seeded answers keyed by prompt name; captures the prompt transcript; never opens stdin) and it backs the executable-guide scenario answer flow (§19.4).
- [ ] `@lando/sdk/test` exports an interaction contract suite that runs against `InteractionServiceLive`, `TestInteractionService`, and any plugin-contributed implementation.
- [ ] The suite covers capability declaration, answer-source precedence, `auto`-mode TTY gating, non-interactive fail-fast (never blocks on stdin), per-type validation, `secret` non-echo/redaction, `Effect.interrupt` → `InteractionCancelledError` with TTY restore, dynamic `choicesFrom` resolution and manual fallback, and prompt-output routing through `Renderer.output`.
- [ ] `makeLandoRuntime` accepts the `interaction` option (default `non-interactive` in library mode, `auto` in CLI) and a host can override `InteractionService` via `overrides` to route prompts through its own transport; a library-API test drives an `apps:init`-style flow non-interactively with seeded answers.
- [ ] Contract tests prove a plugin/host implementation cannot weaken `secret` redaction, answer precedence, or non-interactive fail-fast while still satisfying the interface.
- [ ] Tests pass.
- [ ] Typecheck passes.
- [ ] Lint passes.

## Functional Requirements

- FR-1: Terminal UI polish MUST be implemented behind the existing `Renderer` and prompt seams; command logic must not import OpenTUI directly.
- FR-2: `--renderer=json`, `--renderer=plain`, non-TTY output, and CI logs MUST remain stable and machine-readable.
- FR-3: The default TTY renderer MUST live in the bundled `@lando/renderer-lando` plugin so Lando dogfoods the renderer contribution surface and plugin authors have a maintained internal example.
- FR-4: The default TTY renderer SHOULD use OpenTUI primitives only where they improve bounded surfaces; level-`none` commands and the pre-renderer fast path MUST NOT import OpenTUI.
- FR-5: First-paint, spinner-threshold, completion-line latency, and cancellation budgets from §8.9 and §13.1 remain merge gates.
- FR-6: Visual status cannot rely on color alone; every success/warning/error/progress state needs text or glyph+text redundancy.
- FR-7: The default TTY visual direction is futuristic spaceship operations console, not generic colorful CLI output; implementations must preserve this direction in fixtures and docs.

### InteractionService functional requirements

- FR-1: Every interactive prompt/answer flow in core and bundled plugins MUST resolve through `InteractionService`; ad-hoc `process.stdin`/`readLine` prompting outside the Live layer is forbidden by the §13.4 boundary gate (the renderer alt-screen input and the `lando shell` REPL are out of scope and keep their own terminal modes).
- FR-2: The prompt vocabulary MUST be the published `PromptSpec`; recipe prompts MUST be `PromptSpec` plus recipe-only fields with an unchanged serialized shape.
- FR-3: Non-interactive resolution MUST fail fast with `InteractionRequiredError` and MUST NOT block on stdin.
- FR-4: `secret` answers MUST be carried as `Redacted.Redacted<string>` and MUST be absent from logs, events, transcripts, and error messages.
- FR-5: The `--answer`/`--answers`/`--yes`/`--no-interactive`/`--interactive` flags and the interactivity gate MUST come from one shared module used by both the OCLIF and compiled dispatch paths.
- FR-6: `interactionServices:` plugins and host-supplied implementations MUST pass the SDK interaction contract suite before they are considered compatible.
- FR-7: Library mode MUST default to `non-interactive`; CLI mode defaults to `auto`.
- FR-8: There is no `Interaction` lifecycle event scope in v4.0; prompts fire at command boundaries only (no mid-build prompting).

## Non-Goals

- Replacing the entire CLI with a full-screen TUI shell.
- Adding unrelated commands, flags, lifecycle events, or behavioral semantics outside the `InteractionService` / `PromptSpec` surface explicitly covered by this PRD.
- Decorating `json`, `plain`, non-TTY, or CI output beyond existing stable prefixes and structured events.
- Building the post-GA `github-actions` renderer or plugin marketplace UI.
- Replacing Starlight docs rendering or changing public transcript schemas.

### InteractionService non-goals

- Adopting an external prompt/TUI library; the existing hand-rolled engine is retained behind the service.
- Mid-build / interleaved prompting against the live §8.9.2 task tree.
- Replacing the renderer alt-screen keyboard input or the `lando shell` REPL stdin handling.
- A new lifecycle event scope for prompts.
- Rich-widget prompts (tables, trees) beyond the eight `PromptType` values.

## Technical Considerations

- OpenTUI Core is the preferred integration layer for Alpha 4 polish because it exposes imperative renderables and avoids requiring React/Solid runtimes in the default renderer plugin.
- OpenTUI can be used incrementally: instantiate it only for TTY prompt/task/summary surfaces owned by `@lando/renderer-lando`, and tear it down when the prompt or task tree completes. This is not a requirement to run the entire command in alternate-screen mode.
- The implementation must preserve the §8.9 hand-off from the pre-renderer banner. OpenTUI must not be imported before bootstrap for level ≥ `plugins`, and must never be imported for level-`none` commands.
- TTY rendering should have a fallback when OpenTUI cannot initialize (unsupported terminal, missing native binding, or test harness constraints). The fallback is the existing `plain`/minimal renderer path with a warning only when it does not contaminate machine output.
- Renderer tests should feed synthetic `RenderEvent` streams rather than requiring slow real provider operations.

### InteractionService technical considerations

- Keep the engine logic intact; this is a contract-promotion + wiring + migration change, not a prompting rewrite.
- `RecipePrompt` must remain serialization-compatible so the §13.2 schema snapshot diff is additive (alias to `PromptSpec`, add `editor` to the enum).
- Provide `TestInteractionService` so scenario and library tests assert prompt flows without a terminal; the executable-guide scenario answer flow consumes it.
- The renderer-boundary gate (§13.4) must explicitly allow the Live-layer stdin reader and no-renderer fallback writer; route question chrome through `Renderer.output` whenever a renderer is present.
- Coordinate with PRD-12's renderer seam so prompt output and task-tree output do not interleave; prompts remain command-boundary only.

## Success Metrics

- A first-time user can identify the current phase, active task, failure, and next action from `lando setup`, `lando start`, and `lando uninstall --dry-run` output within one screenful, and describe the interface as futuristic/mission-control rather than plain terminal output.
- Visual QA snapshots catch accidental loss of spacing, status labels, or hierarchy before merge.
- TTY polish ships with zero changes to JSON renderer envelopes and no first-paint regression.

### InteractionService success metrics

- Grepping core shows one prompting implementation; `collectPrompts`/`PromptIO` have no consumers outside `InteractionServiceLive`, and the inlined `process.stdin.isTTY` interactivity checks are gone.
- A single contract suite validates the default, test, and any contributed interaction service.
- `apps:init`, `meta:plugin:new`, `meta:plugin:add --trust`, and `meta:setup` all resolve prompts and interactivity through the shared service and flag module, with dispatch parity green.
- Embedding hosts drive `apps:init`-style flows non-interactively with seeded answers and zero terminal access.

## Guide Coverage

Per [PRD-12 US-198](../alpha-3/prd-alpha-3-12-executable-guides.md) (`## Guide Coverage` convention) and [US-199](../alpha-3/prd-alpha-3-12-executable-guides.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-280, US-281, US-283 | Bundled default terminal renderer visual language | `docs/guides/cli/terminal-ui-polish.mdx` | Required at story acceptance |
| US-282 | OpenTUI-backed interactive prompts | `docs/guides/cli/interactive-prompts.mdx` | Required at story acceptance |
| US-284 | Terminal renderer visual QA | `docs/guides/contributing/terminal-renderer-visual-qa.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `core/src/cli/renderer/**`
- `core/src/cli/renderer-boundary.ts`
- `core/src/cli/renderer-selection.ts`
- `core/src/cli/commands/**`
- `core/src/cli/oclif/pre-renderer.ts`
- `core/test/cli/renderer/**`
- `core/test/perf/**`
- `plugins/renderer-*/**`
- `docs/guides/cli/**`
- `docs/guides/contributing/**`

## Open Questions

- Should OpenTUI be a direct `@lando/core` dependency or live inside a bundled renderer plugin? Decision: bundled `@lando/renderer-lando` plugin, so the core renderer boundary stays pluggable and import-budget tests can isolate the dependency.
- Should the polished task tree use alternate screen only for expanded detail or for the whole active task tree? Default: expanded detail only; the main task tree stays inline so scrollback remains useful.
- Should prompt controls use tabbed horizontal choices for small option sets? Default: yes for two to four choices, vertical select for longer lists.

### InteractionService open questions

- Should `editor` shell out via `ProcessRunner` or reuse a `ShellRunner` path? Default: `ProcessRunner` with an argv-precise `$VISUAL`/`$EDITOR` invocation and a temp-file buffer, falling back to `text`.
- Should `interactionServices:` allow replacing the reserved `id: stdio` default, or only adding alternatives? Default: additions only in v4.0; `stdio` is core-reserved like the `host`/`providerExec` tooling engines.
- Should the embedding `interaction` option also accept a seeded-answers map inline, or only via `@lando/core/cli` call options? Default: answers flow through the call/`promptAll` options; `interaction` selects the mode only.
