# PRD: ALPHA3-09 — Renderer & CLI dispatch

## Introduction

Alpha 3 closes two interlocking debts: the renderer must reach the §8.9 full first-paint contract (`task.detail` streaming, expand/collapse, `verbose` mode), and the CLI command boundary must finally route through a `Renderer` Live Layer instead of `console.log`/`console.error`. The CLI dispatch unification spike (§14.2) also lands here — if it succeeds, `runCompiledCli` is deleted; if it fails, the parity rules in §8.4.1 become normative and a compiled-binary parity test layer is added to §13.1.

Depends on: **—** (entry point for the renderer/CLI half of Alpha 3).

## Source References

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.4 dispatch + §8.4.1 dual-dispatch parity, §8.9 renderer contract.
- [`spec/01-mission-and-tenets.md`](../01-mission-and-tenets.md) §2.4 two-carve-out rule, §13.4 lint gate, §14.2 open decisions for both items.
- [`AGENTS.md`](../../AGENTS.md) interim notes for dual CLI dispatch and renderer wiring.

## Goals

- Wire the `Renderer` Live Layer at the CLI command boundary; remove every direct `console.log`/`console.error` outside the two §2.4 carve-outs.
- Ship the §8.9 full first-paint contract including `task.detail` streaming, expand/collapse, and the `verbose` renderer.
- Run the CLI dispatch unification spike and apply the chosen outcome.
- Add the §13.4 lint gate so the renderer carve-outs are enforceable.

## User Stories

### US-150: `task.detail` streaming tail (4-line ring buffer)

**Description:** As a user watching `lando start`, each running task shows the last 4 lines of its stdout/stderr beneath the task line.

**Acceptance Criteria:**
- [ ] `task.detail` events publish a single line; the renderer keeps a 4-line ring buffer per task.
- [ ] Buffer wraps oldest-out at exactly 4 lines (configurable later, fixed for Alpha 3).
- [ ] Tests cover ring-buffer rotation, finished-task collapse, and CSI cursor handling.
- [ ] Tests pass; typecheck passes; lint passes.

### US-151: `task.detail.expand` + `task.detail.collapse` keybindings

**Description:** As a user, I can press a key to expand a task's full detail and another to collapse it back to the 4-line tail.

**Acceptance Criteria:**
- [ ] Expand / collapse keybindings registered (default per §8.9; user-configurable post-GA).
- [ ] Expanding shows the whole stream tail (bounded by terminal scroll); collapsing restores the 4-line ring.
- [ ] Tests use a fake TTY to exercise the keybinding state machine.
- [ ] Tests pass; typecheck passes; lint passes.

### US-152: full first-paint contract per §8.9.1

**Description:** As a user, the first paint after `lando start` matches §8.9.1 exactly — banner, task tree placeholder, and no flicker.

**Acceptance Criteria:**
- [ ] `paint.banner` first-paint contract honored; no Effect / OCLIF / SDK / plugin imports happen before first paint (covered by the canary test added in MVP).
- [ ] Renderer initializes the task tree skeleton before any work runs.
- [ ] Tests use a fake terminal recorder to assert byte-for-byte first-paint output.
- [ ] Tests pass; typecheck passes; lint passes.

### US-153: `verbose` renderer

**Description:** As a debugging user, I can pass `--renderer=verbose` to get the same task tree as `lando` plus full message and event traces.

**Acceptance Criteria:**
- [ ] `verbose` renderer registered alongside `lando`, `json`, `plain`.
- [ ] Output is human-readable but extends `lando` with every published event payload.
- [ ] Tests cover the renderer-selection precedence (`flag > env > config > default`) with `verbose` as a valid choice.
- [ ] Tests pass; typecheck passes; lint passes.

### US-154: renderer message contract (`message.info` / `warn` / `error`)

**Description:** As a developer, every user-facing message goes through the renderer's `message.info`/`message.warn`/`message.error` contract — never `console.log` directly.

**Acceptance Criteria:**
- [ ] Renderer message API exposed via the `Renderer` Effect Service tag.
- [ ] All four renderers (`lando`, `json`, `plain`, `verbose`) implement the message contract.
- [ ] Tests cover each renderer's output for each severity level.
- [ ] Tests pass; typecheck passes; lint passes.

### US-155: CLI dispatch unification spike

**Description:** As a maintainer, I run the spike per ROADMAP Phase 3: can `@oclif/core`'s `execute()` dispatch reliably inside `bun build --compile` against `oclif.manifest.json` + `core/src/cli/oclif/compiled-commands.ts`?

**Acceptance Criteria:**
- [ ] Spike covers `app:start`, `meta:setup`, `meta:bun --version` passthrough, and one deferred command id.
- [ ] Spike asserts exit code, stderr remediation, and JSON-renderer parity against `runCompiledCli`.
- [ ] Spike documented in `spec/14-appendices.md` with the conclusion (option a or option b).
- [ ] Tests pass; typecheck passes; lint passes.

### US-156: apply spike outcome — unify or harden dual dispatch

**Description:** As a maintainer, the spike outcome from US-155 is applied: either delete `runCompiledCli` and drop §8.4.1's relaxed-import rule, or promote §8.4.1 to normative and add a compiled-binary parity test layer.

**Acceptance Criteria:**
- [ ] If option (a): `runCompiledCli` removed from `core/src/cli/run.ts`; §8.4.1 folded into a historical note; `AGENTS.md` interim bullets for dual CLI dispatch + single source of truth + compiled CLI coverage all removed.
- [ ] If option (b): §8.4.1 parity rules become normative; new §13.1 parity test layer covers every canonical command id (MVP_COMMAND_IDS + the §17.1 stage-7 deferred-command set).
- [ ] Either way: §14.2 row "Compiled-binary CLI dispatch unification" closed; ROADMAP Phase 3 spike entry stricken or referenced.
- [ ] Tests pass; typecheck passes; lint passes.

### US-157: `Renderer` Live Layer wired at CLI command boundary

**Description:** As a maintainer, every CLI command's `render()` helper / direct `console.*` call in `core/src/cli/run.ts` and per-command modules is replaced by `Renderer` service calls.

**Acceptance Criteria:**
- [ ] `Renderer` Live Layer instantiated at the command-boundary; commands consume it via `Effect.serviceOption`.
- [ ] `renderer` field added to `GlobalConfig` Schema so the `flag > env > config > default` precedence reaches a real Live Layer (closes the AGENTS interim note).
- [ ] No `process.stdout.write` or `console.*` calls outside the two §2.4 carve-outs (`core/bin/lando.ts`, `core/src/cli/oclif/pre-renderer.ts`).
- [ ] Tests pass; typecheck passes; lint passes.

### US-158: §13.4 renderer lint gate

**Description:** As a maintainer, the lint gate from §13.4 fails CI when any source file outside the two §2.4 carve-outs calls `process.stdout.write` or `console.*`.

**Acceptance Criteria:**
- [ ] Lint rule added to `scripts/check-renderer-boundary.ts` (or AST-grep config); CI calls it from `static-checks`.
- [ ] AGENTS.md "Renderer not wired at the CLI command boundary" interim bullet is removed; §2.4 reverts to its originally-specified prohibitions.
- [ ] Lint gate covers `core/src/**` and `plugins/**`; the two carve-out files are explicitly allowlisted.
- [ ] Tests pass; typecheck passes; lint passes.

## Functional Requirements

- FR-1: `task.detail` events stream into a 4-line ring buffer per task; expand/collapse keybindings work in the `lando` renderer.
- FR-2: First-paint output matches §8.9.1 byte-for-byte against a recorded fixture.
- FR-3: `verbose` renderer is shipped and registered via the `--renderer=verbose` selection path.
- FR-4: `Renderer` Live Layer is wired at the CLI command boundary; `renderer` exists on `GlobalConfig`.
- FR-5: §13.4 lint gate fails CI on any direct console write outside the two §2.4 carve-outs.
- FR-6: CLI dispatch unification spike has been run; its outcome (option a or b) is applied and §14.2 closed.

## Non-Goals

- New renderer plugins (TUI-style `lando` variant, CI-friendly `github-actions`) — Phase 6 per ROADMAP.
- User-customizable keybindings for expand/collapse (post-GA).
- Real-time task tree resizing on terminal resize (Beta 1).
- `verbose` renderer mirroring JSON output verbatim — `json` is the canonical machine-readable mode; `verbose` is human-debug.

## Technical Considerations

- The `Renderer` Live Layer must be provided **at the CLI command boundary**, not inside the Effect runtime construction — otherwise commands that bypass the runtime (e.g. `lando --version` fast path) would carry an unused layer.
- Compiled-binary first paint must still satisfy the cold-start canary added in MVP (no static imports of Effect / OCLIF / SDK / renderer code before paint).
- The dispatch unification spike must not be done blind — write the failing parity tests first, then run the OCLIF dispatch attempt.
- Removing `runCompiledCli` (option a) needs a clean Git history pass — every interim note in AGENTS.md disappears in the same PR series.

## Success Metrics

- Zero `console.*` or `process.stdout.write` matches in source outside the two §2.4 carve-outs (CI-enforced).
- First-paint latency under 50ms on the existing benchmark (no regression from MVP's banner-paint test).
- Compiled-binary parity tests are either gone (option a) or fully populated (option b) — no in-between.

## Guide Coverage

**None — internal/infra PRD.** Per [PRD-12 US-198](./prd-alpha-3-12-executable-guides.md), this PRD ships internal infrastructure with no user-visible CLI surface; no executable guides are required. PRs touching this PRD's surfaces are exempt from the [US-199](./prd-alpha-3-12-executable-guides.md) drift gate by virtue of the §Guide Coverage section having no declared paths.

## Open Questions

- If the spike outcome is option (b), should the parity test layer compare stdout AND stderr byte-for-byte, or only assert structural equivalence? Default: byte-for-byte on stderr (error messages), structural on stdout (which may differ between OCLIF and the hand-rolled path on help text).
- Should `verbose` renderer be the default in CI? Default: no — `json` is the CI default; `verbose` is opt-in for humans.
- Should the lint gate also catch `Effect.log*` outside the carve-outs? Default: no — `Effect.log` flows through Effect's logger and is acceptable.
