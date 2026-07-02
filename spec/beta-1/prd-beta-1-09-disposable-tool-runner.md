# PRD: BETA1-09 — Disposable tool runner (`lando run` / `apps:scratch:run`)

## Introduction

Beta 1 is the final feature wave before feature freeze. The disposable tool runner gives users and agents a one-shot way to run project-adjacent tools without creating a permanent app: `lando run -- composer install`, `lando run node --version`, or `lando apps scratch run --from lamp -- php -v`.

The command is intentionally thin. It uses `ScratchAppService.acquire`, the bundled `toolbox` canonical recipe by default, a cwd mount by default, `RuntimeProvider.exec` for the target process, and scope finalizers for teardown. Non-zero tool exits propagate as command exits rather than becoming Lando errors.

## Source References

- [`spec/19-scratch-apps.md`](../19-scratch-apps.md) §21.10 command table, §21.10.2 top-level alias reservation, and §21.10.3 `apps:scratch:run` behavior.
- [`spec/19-scratch-apps.md`](../19-scratch-apps.md) §21.5 `ScratchAppService.acquire`, §21.11 cleanup and registry, §21.14 `ScratchRunTargetError`, and §21.15 scratch non-goals.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.2 command table row for `apps:scratch:run` and aliases `scratch:run`, `run`.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.3 `LandoCommandSpec`, required `resultSchema`, and streaming schema.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.4.1 dual-dispatch parity rules.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.8.10 bundled `toolbox` canonical recipe and recipe codegen.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.11 machine-readable output contract.
- [`spec/ROADMAP.md`](../ROADMAP.md) Phase 5, Beta 1 feature-wave framing.

## Goals

- Ship the bundled `toolbox` canonical recipe as the default disposable tool environment.
- Implement `apps:scratch:run` with top-level aliases `scratch:run` and `run`, backed by `ScratchAppService.acquire` and `RuntimeProvider.exec`.
- Make the command safe for foreground use: cwd mounted by default, non-zero tool exits propagated, Ctrl+C teardown, and `--keep` detachment when the user asks to inspect or reuse the scratch.
- Provide streaming machine output, result schema coverage, redacted env forwarding, and dual-dispatch parity.
- Harden cleanup, registry, GC, and warm-repeat behavior without introducing a warm toolbox pool.

## User Stories

### US-406: Bundled `toolbox` canonical recipe

**Description:** As a user, I can run `lando run <argv>` without choosing a recipe because Lando ships a default toolbox recipe that is non-interactive, pinned, and available inside the compiled binary.

**Acceptance Criteria:**

- [ ] A canonical `recipes/toolbox/recipe.yml` exists with exactly one `type: lando` service for the disposable tool-runner default.
- [ ] The toolbox service uses a version-pinned general-purpose CLI image suitable for one-shot tool execution.
- [ ] Every toolbox prompt has a non-interactive default, so default `lando run` never blocks for answers.
- [ ] The recipe is wired through `scripts/build-bundled-recipes.ts`; `bun run codegen` updates the bundled recipe registry and leaves generated recipe paths clean under `git diff --exit-code`.
- [ ] The compiled binary embeds the toolbox recipe through the generated bundled-recipe table.
- [ ] `lando meta recipes list`, `lando meta recipes describe toolbox`, and `lando meta recipes validate recipes/toolbox/recipe.yml` all pass through the machine-output contract.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-407: `apps:scratch:run` command core

**Description:** As a user, I can run a one-off command in a disposable scratch app that mounts my cwd by default, tears down on exit or Ctrl+C, and preserves the tool's exit code.

**Acceptance Criteria:**

- [ ] `apps:scratch:run` accepts `[--from <recipe-ref>] [--service <name>] [--no-mount] [--answer key=value]... [--keep] [--] <argv...>` exactly as specified.
- [ ] The command defaults `--from` to the bundled `toolbox` canonical recipe and passes explicit `--from` values through the standard recipe source registry.
- [ ] Acquisition calls `ScratchAppService.acquire` with `source: from-recipe`, `isolate: "cwd"`, `mountCwd: <cwd>`, and `detached: false`; `--no-mount` switches to `isolate: "baked"`.
- [ ] Recipe `postInit:` actions are skipped for the run path.
- [ ] `<argv>` executes in the target service through `RuntimeProvider.exec`, with TTY allocation when stdin is a TTY and everything after `--` passed verbatim.
- [ ] The target service defaults to the recipe's primary or only service; unknown `--service` fails with tagged `ScratchRunTargetError` carrying the requested service and available services.
- [ ] Non-zero tool exit codes propagate as the Lando command exit code without tagged Lando error remediation.
- [ ] Normal exit, non-zero exit, command failure, and Ctrl+C all close the foreground scope and destroy the scratch; `--keep` converts the scratch to detached, prints the scratch id, and leaves lifecycle ownership to `apps:scratch:*` commands.
- [ ] Top-level aliases `scratch:run` and bare `run` route to `apps:scratch:run`; plugin and tooling claims for `run` or `scratch:*` are rejected with `CommandAliasConflictError`, while `commandAliases.custom` can remap within an app context.
- [ ] OCLIF and compiled dispatch both register the canonical id, aliases, result schema, and implemented-id switch branch; dual-dispatch parity tests cover success, failure, and alias forms.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-408: Streaming machine output and env forwarding

**Description:** As an automation agent, I can call `lando run --format json` and receive redacted NDJSON stream frames plus a terminal result frame, while my approved agent context reaches the tool process.

**Acceptance Criteria:**

- [ ] The `apps:scratch:run` `LandoCommandSpec` declares `resultSchema` and `streaming` with the shared `StreamFrame` schema.
- [ ] Under `--format json`, stdout and stderr are emitted as newline-delimited `StreamFrame`s and terminated by a `result` frame carrying a `CommandResultEnvelope`.
- [ ] The terminal result frame includes the propagated tool exit code and scratch id.
- [ ] Streaming output passes through the central machine-output seam and `RedactionService`; no per-command JSON serialization is introduced.
- [ ] Agent-context env forwarding follows §6.9.1 into `RuntimeProvider.exec`, respects app opt-out rules, and redacts forwarded values in frames, events, transcripts, and errors.
- [ ] The machine-output conformance layer covers `apps:scratch:run` for success, tagged command failure, and non-zero tool exit.
- [ ] Source and compiled dispatch produce equivalent JSON frames after normalizing timestamps and temp paths.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-409: Hardening and docs

**Description:** As a user or maintainer, I can trust `lando run` to clean up after itself, preserve kept scratches for inspection, benefit from warm cached repeats, and be covered by executable docs.

**Acceptance Criteria:**

- [ ] A `--keep` run appears in `apps:scratch:list` with source, isolation, detached state, scratch id, and status.
- [ ] `apps:scratch:gc --prune` reaps a kept disposable-run scratch and its provider resources through the registry plus provider-label scan.
- [ ] A Ctrl+C interrupted `lando run` leaves no registry entry, scratch root, container, volume, host-proxy socket, or provider-label orphan in the normal cleanup path.
- [ ] Warm-repeat coverage proves a second `lando run` with the same toolbox recipe uses the content-addressed recipe cache and standard `buildKey` short-circuit rather than re-resolving the recipe or rebuilding the image.
- [ ] Tests assert the warm toolbox pool remains absent; repeated runs still acquire and destroy a fresh scratch unless `--keep` is set.
- [ ] Executable guide coverage for `lando run` shows default toolbox use, `--from`, `--service`, `--no-mount`, `--keep`, exit-code propagation, and JSON streaming.
- [ ] Cleanup, guide, and recipe codegen gates are documented in the PR verification notes for this story.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1:** `apps:scratch:run` is a built-in scratch-bootstrap command with top-level aliases `scratch:run` and `run`.
- **FR-2:** The command shape is `[--from <recipe-ref>] [--service <name>] [--no-mount] [--answer key=value]... [--keep] [--] <argv...>`.
- **FR-3:** Default source is the bundled `toolbox` canonical recipe; custom sources use the standard recipe source registry.
- **FR-4:** Foreground acquisition uses `ScratchAppService.acquire` with cwd isolation by default, baked isolation for `--no-mount`, and skipped `postInit:` actions.
- **FR-5:** Execution uses `RuntimeProvider.exec`, allocates a TTY when stdin is a TTY, forwards agent-context env per §6.9.1, streams stdout and stderr, and propagates the tool exit code.
- **FR-6:** Scope finalization destroys disposable scratches on normal exit, non-zero exit, failure, and Ctrl+C; `--keep` detaches and prints the scratch id.
- **FR-7:** JSON streaming uses `StreamFrame`s and a terminal result frame with exit code and scratch id.
- **FR-8:** `ScratchRunTargetError` is the tagged error for unknown `--service`.

## Non-Goals

- No warm toolbox pool. Each non-kept run acquires and destroys a fresh scratch.
- No new isolation mode beyond `cwd` and `baked` for this command.
- No new lifecycle machinery outside `ScratchAppService` and existing scope finalizers.
- No interpretation of `<argv>` after `--`; Lando must not parse tool flags.
- No plugin or tooling command may claim the reserved bare `run` alias except through user `commandAliases.custom` remapping inside an app context.

## Technical Considerations

- `--keep` changes lifecycle ownership. The command needs a clear point where a foreground scope-owned scratch becomes a detached registry-owned scratch after exec completes.
- Exit-code propagation must distinguish tagged Lando failures from tool failures. A tool exit of `2` should produce command exit `2` without `ok: false` tagged-error remediation.
- The OCLIF path and compiled `runCompiledCli` path must share flag, answer, raw-argv, renderer, and env-forwarding helpers to avoid drift.
- Ctrl+C tests should use an integration harness that can assert scope finalizers ran without relying on timing-sensitive sleeps.
- Recipe codegen must be the only way the toolbox enters generated bundled-recipe tables; generated artifacts and source recipe changes move together.

## Success Metrics

- `lando run -- echo ok` starts a toolbox scratch, streams `ok`, exits 0, and leaves no scratch resources behind.
- `lando run -- sh -c 'exit 7'` exits 7 without a Lando tagged error.
- `lando run --keep -- echo ok` prints a scratch id that appears in `apps:scratch:list` and is removed by `apps:scratch:gc --prune`.
- `lando run --format json -- echo ok` emits valid `StreamFrame` NDJSON and a terminal result envelope with scratch id and exit code.

## Guide Coverage

| Surface | Guide | Status |
| --- | --- | --- |
| `lando run` default toolbox flow | `docs/guides/scratch/disposable-tool-runner.mdx` | Planned (new guide, this PRD) |
| `--from`, `--service`, and `--no-mount` | `docs/guides/scratch/disposable-tool-runner.mdx` | Planned (new guide, this PRD) |
| `--keep`, list, and GC cleanup | `docs/guides/scratch/disposable-tool-runner.mdx` | Planned (new guide, this PRD) |
| JSON streaming and exit-code propagation | `docs/guides/scratch/disposable-tool-runner.mdx` | Planned (new guide, this PRD) |

## Open Questions

- What exact version-pinned general-purpose CLI image should the canonical `toolbox` recipe use for the first beta?
- What is the precise primary-service selection rule when a custom `--from` recipe contains more than one service and no explicit primary marker?
- Should `--keep` detach only after successful exec startup, or also after source/materialization failures when a partial scratch can help debugging? The spec only requires detachment after exec completes.
