# PRD: BETA-10 — Tooling hot path

## Introduction

Alpha shipped the tooling system (parsed `tooling:`, both built-in `ToolingEngine`s, cold-path compilation, `.bun.sh` script-backed tasks, `lando exec`/`ssh`/`shell` in host mode). Beta finishes it: the `tooling` bootstrap level becomes real (cache-only app-plan read), tooling compilation is cached per Landofile content, the perf budget is enforced via a benchmark gate, and `lando shell` in service-mode lands.

Depends on: **BETA-09** (renderer must be ready for tooling output to stream through the task tree consistently).

## Source References

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.5–8.7 tooling system; §8.5.9 `.bun.sh` script tasks.
- [`spec/03-architecture.md`](../03-architecture.md) bootstrap level ranking — `tooling` between `commands` and `provider`.
- [`spec/12-caches-and-persistence.md`](../12-caches-and-persistence.md) tooling-compilation cache.

## Goals

- Make tooling commands feel native by hitting only the `tooling` bootstrap level (no provider attach, no app planner roundtrip).
- Cache tooling compilation by Landofile content hash so reruns are near-instant.
- Enforce the §1.1 ~150ms hot-path latency target as a CI gate.
- Add service-mode `lando shell` so users can drop into a running container.

## User Stories

### US-159: `tooling` bootstrap level becomes real

**Description:** As the runtime, the `tooling` bootstrap level loads what's necessary to dispatch a tooling command — and nothing more.

**Acceptance Criteria:**
- [ ] `tooling` `BootstrapLevel` declared per §3.2 ranking; composed Live Layer in `core/src/runtime/layer.ts`.
- [ ] No provider connection / app planner construction at `tooling` level; relies on the §12 app-plan cache.
- [ ] Tests assert `tooling` boots cleanly without `LANDO_TEST_PODMAN_SOCKET`.
- [ ] Tests pass; typecheck passes; lint passes.

### US-160: cache-only app-plan read at `tooling` level

**Description:** As a tooling command, I read the planned app from the cache; cache miss falls back to a one-shot `app` bootstrap (cold path).

**Acceptance Criteria:**
- [ ] Tooling dispatch reads `app-plan` cache by `(landofileContentHash, providerId)`; cache miss → fall back to `app` bootstrap, regenerate plan, repopulate cache.
- [ ] Cache key includes Landofile content hash, included-fragment SHAs, and provider id.
- [ ] Tests cover hit, miss, and stale-entry invalidation.
- [ ] Tests pass; typecheck passes; lint passes.

### US-161: tooling compilation cache

**Description:** As a tooling command, the compiled command set is cached by Landofile content hash so repeated invocations skip recompilation.

**Acceptance Criteria:**
- [ ] Compilation cache stored under §12 cache rules; key = Landofile content hash + tooling-relevant config hash.
- [ ] Cache invalidation on any tooling-affecting key change (services, tooling, includes).
- [ ] Tests cover cold compile, warm reuse, and invalidation.
- [ ] Tests pass; typecheck passes; lint passes.

### US-162: perf-budget benchmark gate (~150ms target)

**Description:** As maintainers, a CI benchmark gate measures tooling hot-path latency and fails the run if regression exceeds the budget.

**Acceptance Criteria:**
- [ ] Benchmark script (`scripts/bench-tooling-hot-path.ts`) measures `lando <tooling-alias>` cold + warm latency on Linux x64.
- [ ] Budget recorded in a versioned baseline; per-PR regression > 25% fails CI.
- [ ] Target is ~150ms warm-path on Linux x64 per §1.1; current baseline documented even if not yet at target.
- [ ] Tests pass; typecheck passes; lint passes.

### US-163: service-mode `lando shell`

**Description:** As a user, I can run `lando shell <service>` to drop into the running container's shell.

**Acceptance Criteria:**
- [ ] Service mode is the default for `lando shell <service>`; host mode is `lando shell --host` (Alpha behavior preserved).
- [ ] Shell is launched via the selected provider's exec, attaches stdin/stdout/stderr, and forwards window-resize signals.
- [ ] AbortSignal forwarding stops the shell on Ctrl-C of the parent CLI.
- [ ] Tests pass; typecheck passes; lint passes.

### US-164: tooling output streams via the renderer task tree

**Description:** As a user, `lando <tool>` output (whether host or provider-exec) streams into the renderer task tree consistently, matching the §8.9 contract.

**Acceptance Criteria:**
- [ ] Tooling commands publish `task.start`/`task.detail`/`task.complete`/`task.fail` events through the renderer.
- [ ] `--renderer=plain` produces a flat stream (preserving the Alpha behavior); `lando` and `verbose` produce the tree.
- [ ] Tests pass; typecheck passes; lint passes.

## Functional Requirements

- FR-1: `tooling` is a real bootstrap level; tooling commands never attach to a provider unless the cache misses.
- FR-2: App-plan + tooling-compilation caches use the §12 encoding + atomic-write rules.
- FR-3: Tooling hot-path latency is benchmarked per-PR; regressions above the budget fail CI.
- FR-4: `lando shell` defaults to service mode; host mode is opt-in via `--host`.
- FR-5: Tooling output flows through the renderer's task tree.

## Non-Goals

- Persistent local agent (`lando agent`) — post-4.0 §14.2 deferral.
- Custom `ToolingEngine` examples (`processExec`, `dryRun`) — Phase 7 ecosystem polish.
- `lando shell` for stopped services (must be running; auto-start is post-GA).
- Tooling output transformations / filtering (Phase 6+).
- Profile-guided tooling hot path on macOS Docker Desktop — Phase 6 reactive work.

## Technical Considerations

- The cache-miss fallback path must not block: it should regenerate the cache asynchronously where possible and return synchronously from the warm-path for repeat invocations.
- Service-mode shell must handle terminal resize (`SIGWINCH`) and stdin TTY mode toggling correctly across all providers.
- The benchmark gate baseline lives in a tracked file (`scripts/bench-baselines.json` or similar) so deliberate budget changes are reviewed in PRs.
- AbortSignal forwarding to running shell sessions reuses the pattern established in MVP US-053 / US-054.

## Success Metrics

- Warm `lando <tool>` latency on Linux x64 trends toward ~150ms; regression alerts catch backsliding.
- `lando shell <service>` works on every provider × platform cell where the provider supports TTY exec.
- Compilation cache hit rate >95% in repeat-invocation scenarios.

## Guide Coverage

Per [PRD-12 US-198](./prd-beta-12-executable-guides-beta.md) (`## Guide Coverage` convention) and [US-199](./prd-beta-12-executable-guides-beta.md) (drift gate), this PRD owns the executable guides listed below. Each guide exercises the happy path of its mapped user story; failure modes remain covered by unit and integration tests in the named packages. PRs that touch the listed surface paths MUST also touch the corresponding guide(s), or use the `Guide-Coverage-Skip:` escape hatch.

**Guides owned by this PRD:**

| User Story | Feature | Guide Path | Acceptance |
|---|---|---|---|
| US-159 | tooling bootstrap level + cache-only app-plan read | `docs/guides/tooling/composer-php.mdx` | Required at story acceptance |
| US-163 | service-mode `lando shell` | `docs/guides/tooling/lando-shell.mdx` | Required at story acceptance |
| US-164 | tooling output via renderer task tree | `docs/guides/tooling/output-streaming.mdx` | Required at story acceptance |

**CLI / source surface paths covered (drift gate input):**

- `core/src/tooling/**`
- `core/src/cli/commands/shell.ts`
- `core/src/cli/bootstrap/tooling.ts`

## Open Questions

- Should the benchmark gate use mean or p50 latency? Default: p50 over 30 warm runs.
- Should `lando shell` default to bash, sh, or whatever the service-type's documented shell is? Default: the service-type advertises a `defaultShell` (falling back to `sh`).
- Should the tooling hot path warm up the perf-budget baseline on macOS too, or only Linux x64? Default: Linux x64 only for Beta; macOS gating is Phase 6.
