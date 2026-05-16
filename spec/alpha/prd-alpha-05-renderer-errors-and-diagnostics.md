# PRD: ALPHA-05 — Renderer, errors, and diagnostics

## Introduction

This PRD covers Phase 2 Alpha work for **Renderer, errors, and diagnostics**. It translates the Alpha section of [`spec/ROADMAP.md`](../ROADMAP.md) into implementation-sized stories while preserving the MVP rule that the detailed spec parts remain source of truth.

Depends on: **PRD-03, PRD-04**.


## Source References

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) — §8.9 renderer/message/task tree contracts.
- [`spec/03-architecture.md`](../03-architecture.md) — §3.5 lifecycle event payloads consumed by the renderer and §11.2 redaction shape for host-proxy events.
- [`spec/11-subsystems.md`](../11-subsystems.md) — §10.9 logs/diagnostics surface and §10.10 host-proxy behavior.
- [`spec/14-appendices.md`](../14-appendices.md) — non-goals/open decisions that remediation should name accurately.

## Goals

- Make renderer selection and task/message contracts real for Alpha.
- Improve failure output so alpha bug reports are actionable.
- Keep deferred renderer features explicit.

## User Stories

### US-033: Implement renderer selection

**Description:** As a user, I can select `--renderer=plain|json|lando` and get consistent output semantics.

**Acceptance Criteria:**
- [ ] CLI tests cover renderer flag parsing and config/env precedence
- [ ] Unsupported renderer values fail before command execution with a tagged parse error
- [ ] Compiled and source CLI paths share renderer selection code
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-034: Implement concurrent task tree events

**Description:** As a user, long-running operations show task tree progress for concurrent work.

**Acceptance Criteria:**
- [ ] Renderer tests cover `task.tree.start`, `task.start`, `task.complete`, and `task.fail` events
- [ ] Concurrent task ordering is covered by the named snapshot fixture `renderer.task-tree.concurrent.ndjson`, asserting `task.tree.start`, child `task.start`, `task.detail`, terminal event, and `task.tree.complete` order per §8.9.2
- [ ] Plain renderer remains readable in non-TTY CI logs
- [ ] Renderer subscriber stream is materialized before the first event publish per the EventService no-replay contract; cold-start regression test asserts no events are dropped between bootstrap and the first `task.tree.start`
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-035: Implement message info/warn/error contract

**Description:** As a command author, I can emit structured messages consistently across renderers.

**Acceptance Criteria:**
- [ ] Unit tests cover `message.info`, `message.warn`, and `message.error` in plain/json/lando renderers
- [ ] Warnings do not change exit code unless command fails separately
- [ ] Error messages include remediation when present on tagged errors
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-036: Implement basic first-paint banner

**Description:** As a user, the lando renderer paints a useful first banner before long-running work.

**Acceptance Criteria:**
- [ ] TTY fixture test covers `paint.banner` first-paint behavior from §8.9.1: a single-line pre-bootstrap banner on stdout, emitted before plugin import, within the 50 ms cold first-byte budget, and handed off once to the Renderer Layer
- [ ] Full first-paint contract and expand/collapse remain marked RC/deferred
- [ ] Non-TTY output avoids control sequences
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-037: Keep unsupported command remediation precise

**Description:** As a user hitting a Beta/RC command, I see when and why it is unavailable.

**Acceptance Criteria:**
- [ ] Fixture lists every deferred command surface for Alpha: `apps:scratch:*`, `meta:global:*`, `app:includes:*`, `app:config:translate`, `meta:plugin:trust*`, and `meta:plugin:{new,test,build,link,unlink,publish}`. A snapshot test asserts each command returns a tagged NotImplementedError with phase-specific remediation
- [ ] Tests assert every not-yet-shipped command returns NotImplementedError with target phase remediation
- [ ] Remediation text uses the roadmap phase names from `spec/ROADMAP.md` Phase 2 and §14 open-decision labels, and does not include stack traces or source file paths
- [ ] Compiled `$bunfs` fallback mirrors source OCLIF guard behavior
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-038: Standardize alpha bug-report diagnostics

**Description:** As an alpha tester, command failures include enough context for useful bug reports.

**Acceptance Criteria:**
- [ ] Failure output includes command id, app id when known, provider id when known, and log/cache path pointers
- [ ] Sensitive env/prompt values are redacted
- [ ] JSON renderer includes machine-readable error code and remediation
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-039: Render provider and recipe progress through task tree

**Description:** As a user, setup/start/init show visible progress instead of silent hangs.

**Acceptance Criteria:**
- [ ] Scenario tests assert setup/start/init emit task events for provider setup, service apply, recipe rendering, and postInit
- [ ] Provider fake clients can inject progress events without coupling to provider internals
- [ ] Plain renderer snapshots remain stable
- [ ] Init progress (recipe rendering + postInit) renders correctly in plain/json/lando renderer modes; snapshot tests cover all three modes
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-040: Document renderer limitations for Alpha

**Description:** As contributors, we know which renderer features are intentionally deferred.

**Acceptance Criteria:**
- [ ] Alpha PRD/source docs list deferred `task.detail` streaming tail, expand/collapse, and full first-paint contract
- [ ] Tests assert deferred flags/options fail with RC/Beta remediation instead of no-op behavior
- [ ] Docs and NotImplemented remediation agree
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
- Default runtime provider for tests in this PRD is `TestRuntimeProvider` from `@lando/sdk/test`; live `provider-lando`/`provider-docker` cases must be gated on `LANDO_TEST_PODMAN_SOCKET` / `LANDO_TEST_DOCKER_SOCKET` (or `DOCKER_HOST`).
- Keep tagged errors and remediation text consistent across source OCLIF and compiled `$bunfs` paths.
- Avoid broad refactors while implementing a story; each story should be reviewable independently.

## Success Metrics

- Every user story in this PRD is accepted with its tests merged.
- `bun run typecheck`, `bun run lint`, and `bun test` pass for the whole workspace.
- Alpha roadmap exit criteria remain achievable without adding unplanned Beta/RC scope.

## Open Questions

- None blocking; resolve story-level ambiguities by updating this PRD and the authoritative spec part together.
