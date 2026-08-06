# PRD: ARCH-01 — Single CLI dispatch engine

## Introduction

Collapse dual CLI dispatch. Today source mode routes through `@oclif/core` `execute()` while the compiled `$bunfs` binary uses `runCompiledCli`, held together by parity tests and a generated OCLIF manifest. The §14 Appendix D.1 spike proved OCLIF cannot dispatch inside `bun build --compile` through any supported public API. Option (b) made dual dispatch permanent; **this wave supersedes that outcome**: keep the native dispatcher as the **only** shipping engine and remove OCLIF from the shipping path.

## Source References

- `spec/01-mission-and-tenets.md` §1.2, §14.2
- `spec/08-cli-and-tooling.md` §8.4.1
- `spec/09-embedding.md` §16.2
- `spec/13-testing-and-distribution.md` §13.1
- `spec/14-appendices.md` Appendix D.1
- `spec/15-binary-build-and-release.md` §17.2–§17.3
- `core/AGENTS.md` CLI section

## Goals

- One command registry is the source of truth for ids, flags, bootstrap level, run, help metadata, and `resultSchema`.
- Source and compiled entries call the same native dispatcher.
- No shipping runtime dependency on `@oclif/core`.
- Drop dual-path parity suite; keep registry completeness, machine-output, and relocated-binary smoke.
- Remove `@lando/core/oclif` export.

## User Stories

### US-522: Single command registry module is source of truth

**Description:** As a maintainer, one registry holds canonical ids, flags, bootstrap level, run, help, and resultSchema.

**Acceptance Criteria:**
- [ ] No second SoT for implemented vs deferred ids across OCLIF classes and runCompiledCli switches.
- [ ] Registry drives help, dispatch, schema snapshot command list, and MCP projections.
- [ ] Tests pass; typecheck passes; lint passes

### US-523: Unify source entry on native dispatcher

**Description:** As a user, bun core/bin/lando.ts and the compiled binary call the same runCli/native dispatcher engine.

**Acceptance Criteria:**
- [ ] Source path does not call @oclif/core execute() for shipping command dispatch.
- [ ] core/bin/lando.ts and compiled entry share the engine.
- [ ] Tests pass; typecheck passes; lint passes

### US-524: Delete OCLIF runtime dependency from shipping CLI

**Description:** As a maintainer, @oclif/core is removed from the shipping CLI hot path and OCLIF command class tree is deleted or inert.

**Acceptance Criteria:**
- [ ] package.json dependency graph for shipping CLI has no required @oclif/core runtime load.
- [ ] Cold-start import graph excludes OCLIF.
- [ ] Tests pass; typecheck passes; lint passes

### US-525: Help and deferred-command UX from registry

**Description:** As a user, --help, unknown command, and deferred plans work without OCLIF help classes.

**Acceptance Criteria:**
- [ ] Root and per-command help render from registry metadata.
- [ ] Deferred ids emit NotImplementedError with phase-tagged remediation.
- [ ] Flexible taxonomy policy documented for the native parser (colon canonical; space forms if supported).
- [ ] Tests pass; typecheck passes; lint passes

### US-526: Drop @lando/core/oclif public export

**Description:** As an embedding host, @lando/core/oclif is removed per §16.2.

**Acceptance Criteria:**
- [ ] package.json exports no longer advertise a required oclif adapter for shipping.
- [ ] Embedding docs updated; boundary tests updated.
- [ ] Tests pass; typecheck passes; lint passes

### US-527: Replace dual parity layer with single-path suite

**Description:** As CI, source-vs-compiled OCLIF parity tests are deleted; relocated binary smoke + registry completeness + machine-output remain.

**Acceptance Criteria:**
- [ ] core/test/cli/parity dual-path suite removed or reduced to single-engine registry completeness.
- [ ] Machine-output and relocated binary tests still green.
- [ ] Tests pass; typecheck passes; lint passes

### US-528: Codegen: command registry manifest for embed

**Description:** As a releaser, the binary embeds a **built-in-only** registry-derived command manifest; oclif-manifest generator is removed or repurposed. Scope is the OCLIF sidecar replacement — not bundled-plugin command composition (that is US-534).

**Acceptance Criteria:**
- [x] §17.2 catalog row updated for built-in `builtInCommandEntries` only; build embeds registry manifest.
- [x] No oclif.manifest.json required for shipping dispatch.
- [x] Bundled-plugin command metadata is **not** required in the embedded manifest (owned by `plugin-command` cache / US-534).
- [x] Tests pass; typecheck passes; lint passes

### US-534: Bundled-plugin command metadata ownership (follow-up)

**Description:** As a maintainer, bundled and external plugin command metadata follows the same validated `plugin-command` cache path while the embedded command-registry manifest remains built-in-only.

**Acceptance Criteria:**
- [x] Spec (§9.7, §12.1, §17.2, §17.9) states one ownership model for bundled-versus-external plugin command metadata (cache-only for all plugins).
- [x] Precedence, invalidation, and router/bootstrap composition rules are documented for the chosen model.
- [x] Generated inputs and consumers match the chosen model; no hand edits in `src/` are required to add or remove a bundled plugin's commands from the shipping surface that owns them.
- [x] Proof: removing a bundled plugin that contributes commands from `core/build.config.ts` and rebuilding omits those commands from the owning artifact without `src/` hand edits.
- [x] Tests pass; typecheck passes; lint passes

### US-529: Cold-start gate: no OCLIF on level-none

**Description:** As CI, level-none fast path remains free of OCLIF and heavy Effect imports per §1.2.

**Acceptance Criteria:**
- [ ] Import-boundary / cold-start tests updated for native dispatcher.
- [ ] Tests pass; typecheck passes; lint passes

### US-530: Migrate plugin setup flag merge off OCLIF metadata

**Description:** As a maintainer, setup.flags and topics merge through the native registry generators.

**Acceptance Criteria:**
- [ ] codegen:setup-plugin-flags (or successor) feeds the native registry.
- [ ] meta:setup still merges bundled plugin flags without importing bundled plugin graph into cold path.
- [ ] Tests pass; typecheck passes; lint passes

### US-531: Sweep dual-dispatch references in AGENTS and beta-1 notes

**Description:** As a maintainer, remaining OCLIF/runCompiledCli parity instructions are rewritten to native dispatcher.

**Acceptance Criteria:**
- [ ] core/AGENTS.md CLI section describes single dispatcher.
- [ ] Current-facing maintainer/user guidance, public/package metadata, exported diagnostics/comments, guide proof text, and native-path test labels describe one native dispatcher; retained OCLIF references are limited to historical/superseded records, genuine development-only compatibility fixtures, negative dependency assertions, or legacy identifiers/paths.
- [ ] A repository-wide tracked-text search for claims that OCLIF is the default/shipping framework, @lando/core/oclif is public, or source/compiled/runCompiledCli paths require dual parity returns only those explicit exceptions; verification must not rely on a hardcoded file allowlist.
- [ ] rg for 'dual dispatch is permanent' returns only historical/superseded notes.
- [ ] Tests pass; typecheck passes; lint passes

**Notes:** Adjudication 2026-08-05: US-531 owns the repository-wide current-facing claim sweep; direct tracked-text verification is required, but a committed fixed-file prose scan is not.

## Functional Requirements

- Default `CommandFramework` implementation is the native Lando dispatcher (§4.2).
- Compiled detection may remain only for path/embed quirks, not a second router.
- Effect command bodies under `core/src/cli/commands/` stay the implementation home.

## Non-Goals

- Keeping OCLIF as a source-only engine with generated wrappers (rejected: two engines).
- Byte-identical plain-text help with historical OCLIF wrapping.
- New user-facing commands.

## Technical Considerations

- Spike evidence in Appendix D.1 remains valid and motivates **removing** OCLIF, not keeping dual engines.
- MCP, schema snapshot command list, and setup flag merge must all read the same registry.
- Prefer gut-and-replace of `core/src/cli/oclif/**` over long-lived shims.

## Success Metrics

- Zero shipping imports of `@oclif/core` on the CLI hot path.
- One registry completeness suite replaces dual parity.
- Cold-start budgets unchanged or improved.

## Guide Coverage

**None — internal/infra PRD.** This wave changes maintainer/CI architecture only; no new end-user CLI feature requires an executable guide.

## Open Questions

- None blocking CLI collapse. Bundled and external plugin command metadata is cache-only; executable plugin-command dispatch remains deferred until the public plugin contract defines an implementation loader.
- Space-form flexible taxonomy is a native-parser product choice documented in US-525.
