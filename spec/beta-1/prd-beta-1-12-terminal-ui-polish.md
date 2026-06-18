# PRD: BETA1-12 — Terminal UI polish

## Introduction

The renderer contract in §8.9 already describes the default `lando` renderer as interactive and colorful. In practice, a renderer can satisfy the event boundary while still feeling flat, overly textual, or hard to scan during setup, init, builds, and release-style summaries. This PRD adds a small Beta 1 polish pass: move the default user renderer behind a bundled internal `@lando/renderer-lando` plugin, then improve the terminal UI's hierarchy, prompts, progress, and summary surfaces with a futuristic spaceship interface vibe, without changing command semantics or turning the entire CLI into a full-screen TUI.

OpenTUI is allowed as an implementation dependency for bounded TTY surfaces because its Core API exposes an imperative renderer plus composable renderables (`TextRenderable`, `BoxRenderable`, `ScrollBoxRenderable`, `InputRenderable`, `TextareaRenderable`, `SelectRenderable`, `TabSelectRenderable`) and Yoga/Flexbox-style layout primitives. The intent is to use those primitives behind the existing `Renderer` and prompt seams where they help, while preserving the non-TTY, `plain`, `json`, and CI output contracts.

Depends on: **BETA1-01** (setup/uninstall renderer surfaces), **BETA1-07** (public transcript and guide rendering expectations), and **BETA1-11** (§17.9 acceptance/perf gates). This PRD does not add new commands, flags, schema fields, lifecycle events, or product behavior.

## Source References

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.9 renderer events, first-paint contract, and concurrent task tree contract.
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.1 perf-budget renderer tests.
- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) §19.6 public transcript safety and §19.10 guide lint discipline.
- [`spec/ROADMAP.md`](../ROADMAP.md) Phase 4 feature freeze and Phase 8 renderer-plugin follow-up.

## Goals

- Make the default TTY renderer a bundled internal plugin (`@lando/renderer-lando`) that dogfoods the public renderer contribution shape and serves as the example for third-party renderer authors.
- Make that default TTY renderer feel like a compact spaceship operations console: futuristic, precise, luminous, and easy to scan while staying faithful to existing render events.
- Use OpenTUI field and layout primitives only for bounded interactive surfaces: prompts, selectable lists, task-tree panes, and summaries.
- Preserve machine output exactly: `--renderer=json`, non-TTY/CI output, and `--renderer=plain` remain stable and parseable.
- Prove the visual language with snapshot-style terminal tests and narrow-terminal fixtures before implementation is considered accepted.

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

## Functional Requirements

- FR-1: Terminal UI polish MUST be implemented behind the existing `Renderer` and prompt seams; command logic must not import OpenTUI directly.
- FR-2: `--renderer=json`, `--renderer=plain`, non-TTY output, and CI logs MUST remain stable and machine-readable.
- FR-3: The default TTY renderer MUST live in the bundled `@lando/renderer-lando` plugin so Lando dogfoods the renderer contribution surface and plugin authors have a maintained internal example.
- FR-4: The default TTY renderer SHOULD use OpenTUI primitives only where they improve bounded surfaces; level-`none` commands and the pre-renderer fast path MUST NOT import OpenTUI.
- FR-5: First-paint, spinner-threshold, completion-line latency, and cancellation budgets from §8.9 and §13.1 remain merge gates.
- FR-6: Visual status cannot rely on color alone; every success/warning/error/progress state needs text or glyph+text redundancy.
- FR-7: The default TTY visual direction is futuristic spaceship operations console, not generic colorful CLI output; implementations must preserve this direction in fixtures and docs.

## Non-Goals

- Replacing the entire CLI with a full-screen TUI shell.
- Adding new commands, flags, schema fields, lifecycle events, or behavioral semantics.
- Decorating `json`, `plain`, non-TTY, or CI output beyond existing stable prefixes and structured events.
- Building the post-GA `github-actions` renderer or plugin marketplace UI.
- Replacing Starlight docs rendering or changing public transcript schemas.

## Technical Considerations

- OpenTUI Core is the preferred integration layer for Beta 1 polish because it exposes imperative renderables and avoids requiring React/Solid runtimes in the default renderer plugin.
- OpenTUI can be used incrementally: instantiate it only for TTY prompt/task/summary surfaces owned by `@lando/renderer-lando`, and tear it down when the prompt or task tree completes. This is not a requirement to run the entire command in alternate-screen mode.
- The implementation must preserve the §8.9 hand-off from the pre-renderer banner. OpenTUI must not be imported before bootstrap for level ≥ `plugins`, and must never be imported for level-`none` commands.
- TTY rendering should have a fallback when OpenTUI cannot initialize (unsupported terminal, missing native binding, or test harness constraints). The fallback is the existing `plain`/minimal renderer path with a warning only when it does not contaminate machine output.
- Renderer tests should feed synthetic `RenderEvent` streams rather than requiring slow real provider operations.

## Success Metrics

- A first-time user can identify the current phase, active task, failure, and next action from `lando setup`, `lando start`, and `lando uninstall --dry-run` output within one screenful, and describe the interface as futuristic/mission-control rather than plain terminal output.
- Visual QA snapshots catch accidental loss of spacing, status labels, or hierarchy before merge.
- TTY polish ships with zero changes to JSON renderer envelopes and no first-paint regression.

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
