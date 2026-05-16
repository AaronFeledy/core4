# PRD: ALPHA-03 — Tooling and CLI coverage

## Introduction

This PRD covers Phase 2 Alpha work for **Tooling and CLI coverage**. It translates the Alpha section of [`spec/ROADMAP.md`](../ROADMAP.md) into implementation-sized stories while preserving the MVP rule that the detailed spec parts remain source of truth.

Depends on: **PRD-01, PRD-02**.


## Source References

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) — tooling schema, engines, compilation pipeline, CLI commands.
- [`spec/03-architecture.md`](../03-architecture.md) — lifecycle/events architecture used by command execution.
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) — compiled binary parity constraints.

## Goals

- Parse and execute Alpha `tooling:` definitions.
- Implement providerExec and host tooling engines.
- Fill Alpha app/meta command coverage while preserving structured remediation for deferred commands.

## User Stories

### US-017: Parse Alpha `tooling:` Landofile section

**Description:** As a user, I can define basic tooling commands in `.lando.yml`.

**Acceptance Criteria:**
- [ ] Landofile parser tests cover `tooling:` tasks with `cmds:`, `service:`, `description:`, and basic `vars:`
- [ ] Unsupported Beta-only tooling features fail with remediation, not silent ignore
- [ ] Parsed tooling contributes to command registry at bootstrap `tooling`
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-018: Implement providerExec ToolingEngine

**Description:** As a user, default tooling runs inside the selected service through the runtime provider.

**Acceptance Criteria:**
- [ ] ToolingEngine unit tests verify command execution delegates to `RuntimeProvider.exec`
- [ ] Service resolution selects the declared service or a deterministic default
- [ ] Exit code/stdout/stderr are preserved through CLI rendering
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-019: Implement host ToolingEngine

**Description:** As a user, I can opt into host-mode tooling backed by Bun.$.

**Acceptance Criteria:**
- [ ] Host engine tests cover success, non-zero exit, cwd, and env propagation
- [ ] Shell errors map to tagged ShellExecError/remediation patterns from existing services
- [ ] Host mode is available for `lando shell` in Alpha; service shell remains Beta
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-020: Compile tooling command registry on cold path

**Description:** As the CLI, I can discover tooling commands during bootstrap and cache the resulting command index.

**Acceptance Criteria:**
- [ ] Compilation pipeline tests cover Landofile tooling to command specs
- [ ] Cold path writes plugin/tooling command index cache using §12 encoding
- [ ] Hot-path optimization is explicitly not required in Alpha
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-021: Support `.bun.sh` script-backed tasks

**Description:** As a power user, I can define script-backed tasks without a separate plugin.

**Acceptance Criteria:**
- [ ] Parser and execution tests cover `.bun.sh` task discovery described by §8.5.9
- [ ] Scripts run with documented cwd/env and failure behavior
- [ ] Script-backed tasks cannot escape declared host/provider execution mode without explicit config
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-022: Implement `lando exec`, provider-exec `lando ssh`, and host-mode `lando shell`

**Description:** As a user, I can execute commands, use Alpha `ssh` as provider-exec TTY command behavior, and open host-mode shells from the CLI.

**Acceptance Criteria:**
- [ ] Scenario tests cover `exec` against providerExec with fake provider output
- [ ] `ssh` behavior is documented as provider-exec TTY command behavior only; SSH sidecar/subsystem work remains deferred
- [ ] `shell` host mode works; service shell and SSH subsystem/sidecar features return NotImplemented/Beta remediation
- [ ] Compiled and source CLI paths match for supported commands
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-023: Fill Alpha app command coverage

**Description:** As an app user, most `app:*` commands work except explicitly deferred commands.

**Acceptance Criteria:**
- [ ] Scenario tests cover app start/stop/restart/rebuild/destroy/info/logs/config/cache basics according to §8.2
- [ ] Deferred `app:includes:*` and `app:config:translate` return structured NotImplemented remediation
- [ ] Compiled `$bunfs` handlers mirror source command behavior until full OCLIF dispatch lands
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-024: Fill Alpha meta/app management commands

**Description:** As a maintainer, I can run app list/poweroff and basic plugin/config/setup/doctor/bun/x commands.

**Acceptance Criteria:**
- [ ] Scenario tests cover `apps:list`, `apps:poweroff`, `meta:config`, `meta:plugin:add` npm source, `meta:plugin:remove`, `meta:setup`, `meta:doctor`, `meta:bun`, and `meta:x`
- [ ] `meta:plugin:add` npm source validates manifest/module containment before loading any plugin code
- [ ] `meta:plugin:add` warns/confirms that plugins run as trusted host code while trust/signing is deferred; non-interactive mode requires an explicit trust/confirm flag
- [ ] Deferred plugin trust/new/test/build/link/unlink/publish commands return structured remediation
- [ ] Command aliases follow the top-level alias conflict rules
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- Implement only the Phase 2 Alpha surface assigned to this PRD.
- Preserve all accepted MVP behavior and regression coverage.
- Match existing Bun workspace conventions: `bun run typecheck`, `bun run lint`, `bun test`, and generated-file updates through `bun run codegen` where applicable.
- Source CLI behavior and compiled binary behavior must stay aligned for user-visible commands touched by this PRD.

## Non-Goals

- Do not implement features listed in the Alpha index cross-cutting non-goals.
- Do not stabilize non-SDK library APIs beyond the `unstable`/dev-channel promise.
- Do not add new external dependencies unless the relevant spec part already requires them or a separate architecture decision approves them.

## Technical Considerations

- Use the spec part referenced by each story as the source of truth when details conflict with this PRD.
- Prefer fake-client/unit coverage for provider and CLI behavior; live runtime tests must be env-gated.
- Keep tagged errors and remediation text consistent across source OCLIF and compiled `$bunfs` paths.
- Avoid broad refactors while implementing a story; each story should be reviewable independently.

## Success Metrics

- Every user story in this PRD is accepted with its tests merged.
- `bun run typecheck`, `bun run lint`, and `bun test` pass for the whole workspace.
- Alpha roadmap exit criteria remain achievable without adding unplanned Beta/RC scope.

## Open Questions

- None blocking; resolve story-level ambiguities by updating this PRD and the authoritative spec part together.
