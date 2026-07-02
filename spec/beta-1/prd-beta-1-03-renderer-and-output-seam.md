# PRD: BETA1-03 — Renderer ownership & machine-output seam

## Introduction

Two Alpha 4 output-surface PRDs left seams incomplete:

1. **Renderer ownership (PRD-ALPHA4-12).** The default terminal UI was to move behind the bundled `@lando/renderer-lando` plugin. The plugin exists, declares `contributes.renderers: ["lando"]`, and ships the OpenTUI prompt driver — but its `renderer` export is `Layer.empty` (`plugins/renderer-lando/src/index.ts`), while the actual default TTY renderer is still assembled inside core (`core/src/cli/renderer/bundled-renderers.ts` builds `landoRenderer` from `rendererFactories` and core primitives). The plugin is a label, not an owner: a third-party renderer plugin cannot follow `@lando/renderer-lando` as a reference implementation because the reference implementation is not actually in the plugin.
2. **StreamFrame serialization seam (PRD-ALPHA4-15 US-326).** One-off NDJSON/event-line renderers were to migrate onto the central `StreamFrame` encode seam. `core/src/cli/commands/doctor-ndjson.ts` and `core/src/cli/commands/doctor-report.ts` still serialize frames/event lines with raw `JSON.stringify`, bypassing the single redaction-aware seam that `encodeCommandResult`/the frame encoder provide.

## Source References

- [`spec/alpha-4/prd-alpha-4-12-terminal-ui-polish.md`](../alpha-4/prd-alpha-4-12-terminal-ui-polish.md) — renderer plugin ownership acceptance criteria.
- [`spec/alpha-4/prd-alpha-4-15-universal-json-output.md`](../alpha-4/prd-alpha-4-15-universal-json-output.md) US-326 — StreamFrame migration.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) renderer service and machine-output contract.
- [`core/AGENTS.md`](../../core/AGENTS.md) — renderer plugin + dynamic-import boundary for OpenTUI.

## Goals

- Make `@lando/renderer-lando` the real owner of the default TTY renderer layer; core consumes it through the bundled-plugin wiring instead of assembling it.
- Centralize all StreamFrame/NDJSON serialization on the single encode seam so redaction and shape-freeze guarantees hold everywhere.

## User Stories

### US-382: `@lando/renderer-lando` owns the default renderer layer

**Description:** As a renderer-plugin author, I can read `@lando/renderer-lando` as the reference implementation: its exported renderer layer *is* the default TTY renderer, and core wires it via the bundled-plugin mechanism rather than assembling renderer internals itself.

**Acceptance Criteria:**

- [ ] `plugins/renderer-lando`'s renderer export is the real default TTY renderer layer (task-tree painter, event consumer, plain/json fallbacks) — no more `Layer.empty` placeholder.
- [ ] `core/src/cli/renderer/bundled-renderers.ts` no longer constructs the lando renderer from parts; it resolves the renderer contribution from the bundled plugin (shared primitives may live in `@lando/sdk/renderer` for reuse, but composition/ownership sits in the plugin).
- [ ] Fallback modes (non-TTY plain, `--renderer=json`) and renderer selection order are preserved; existing renderer golden/visual-QA tests stay green (goldens may move, not weaken).
- [ ] Cold-start discipline holds: the plugin's renderer layer stays off the `core/src/cli/index.ts` / pre-renderer static import graph, and `@opentui/core` remains behind the dynamic-import boundary; import-boundary gates pass.
- [ ] Bundled-plugin codegen (`codegen:bundled-plugins`, bootstrap layers) is regenerated in the same change if the contribution shape changes; `git diff --exit-code` clean on generated paths after codegen.
- [ ] `check:renderer-boundary` passes.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-383: Doctor NDJSON goes through the central StreamFrame seam

**Description:** As an agent consuming `lando doctor` NDJSON, every emitted line is produced by the central redaction-aware StreamFrame encoder, so shape and redaction guarantees are uniform with every other streaming command.

**Acceptance Criteria:**

- [ ] `core/src/cli/commands/doctor-ndjson.ts` serializes frames through the central StreamFrame encode seam (the `encodeCommandResult`/frame-encoder family), not raw `JSON.stringify`.
- [ ] `core/src/cli/commands/doctor-report.ts`'s `doctor.check` event lines go through the same seam.
- [ ] Emitted NDJSON output is byte-compatible with the frozen shapes (existing snapshot/conformance tests prove no consumer-visible change), or any deliberate shape change updates the frozen snapshot with justification.
- [ ] A redaction test proves a registered secret in a doctor check result is masked in the NDJSON output.
- [ ] The machine-output gate (`scripts/check-machine-output.ts`) no longer needs any special-casing for these two files; if the gate has allowlist entries for them, they are removed.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1:** Exactly one code path serializes `StreamFrame`s and command result envelopes.
- **FR-2:** The default TTY renderer implementation is importable only via the bundled renderer plugin's contribution, and the plugin's exports are self-sufficient as a reference implementation.

## Non-Goals

- No visual redesign; goldens move only if file locations move.
- No renderer plugin API changes beyond making the existing contribution surface real.
- No changes to the `CommandResultEnvelope`/`StreamFrame` schemas.

## Technical Considerations

- Moving composition into the plugin must not regress CLI cold-start: the plugin's manifest/metadata must stay importable without pulling renderer internals (mirror the OpenTUI dynamic-import pattern documented in `core/AGENTS.md`).
- Compiled-binary parity: renderer resolution must behave identically under OCLIF source dispatch and `runCompiledCli`; run the parity tests.
- Keep `@lando/core` → plugin dependency direction legal per the bundled-plugin wiring rules (core may depend on bundled plugin packages through the generated wiring only).

## Success Metrics

- `Layer.empty` renderer export is gone; a grep for renderer assembly in `core/src/cli/renderer/` shows resolution, not construction.
- Zero raw `JSON.stringify` StreamFrame call sites under `core/src/cli/commands/`.

## Guide Coverage

**None — internal/infra PRD.**

Terminal-UI and JSON-scripting guides shipped in Alpha 4 and remain owned there; both must pass the guide drift gate after these changes since their transcripts touch rendered output.

## Open Questions

- Should shared renderer primitives stay in core (`@lando/sdk/renderer`) with the plugin composing them, or move wholesale into the plugin? Default assumption: primitives stay in the SDK, composition/ownership moves to the plugin.
