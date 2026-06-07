# PRD: MVP-06 — CLI commands (`start`, `stop`, `info`, `version`, `shellenv`, `init`)

## Introduction

This is the user-visible end of MVP. It wires the OCLIF command shells (`Effect.die("not yet implemented")` today) to the runtime PRDs 01–05 ship.

Per [`spec/ROADMAP.md`](../../spec/ROADMAP.md) Phase 1 "CLI commands working end-to-end":

- `lando start` / `app:start`
- `lando stop` / `app:stop`
- `lando info` / `app:info` (basic — service list + endpoints)
- `lando version`, `lando shellenv` (bootstrap `none` — no Effect runtime; PRD-02 already handles these)
- `lando init` only with `--full` flag pointing at the single hardcoded recipe — no prompts beyond `--name`

Today (Phase 0): OCLIF command shells exist for ~25 commands; every `run()` body is `Effect.die("not yet implemented")`.

Depends on: **PRD-01 (SDK)**, **PRD-02 (Foundation)**, **PRD-03 (Effect services)**, **PRD-04 (Providers)**, **PRD-05 (Bundled services)**.

## Goals

- Six MVP-mandated commands work end-to-end against the real bundled `@lando/provider-lando` provider on Linux x64.
- `lando init --full --name=<name>` scaffolds a working Node + Postgres app from a hardcoded built-in recipe.
- `lando start` brings up that app via `provider-lando`.
- `lando info` prints the service list + endpoints in plain text.
- `lando stop` stops the app cleanly.
- The exit-criteria command from `spec/ROADMAP.md` works verbatim against a fresh checkout on Linux x64.
- Every other OCLIF command not in this list still exists as a shell that returns a structured `NotImplementedError` with a remediation pointing at the spec.

## User Stories

### US-001: `lando init --full --name=<name>` scaffolds a Node+Postgres app

**Description:** As a new user, I run `lando init --full --name=my-app` and end up in a subdirectory with a working `.lando.yml` and a minimal Node project skeleton.

**Acceptance Criteria:**
- [ ] Failing scenario test in `core/test/cli/init.scenario.test.ts` runs the OCLIF `init` command with `--full --name=my-app` against a temp `cwd` and asserts:
  - Directory `<cwd>/my-app/` is created.
  - `<cwd>/my-app/.lando.yml` exists and parses through `LandofileService.discover` with no errors.
  - The Landofile contains one `node:lts` service and one `postgres` service.
  - A skeleton `<cwd>/my-app/package.json` exists with at minimum `name: "my-app"`.
- [ ] Test asserts running `init --full` *without* `--name` fails with a typed error message naming the missing flag (no interactive prompts at MVP).
- [ ] Test asserts running `init --full --name=existing` against an existing non-empty directory fails with `InitTargetExistsError` and remediation pointing at `--force` (whose implementation is Alpha 1 — at MVP we just refuse).
- [ ] The "hardcoded built-in recipe" lives at `core/src/recipes/builtin/node-postgres/` (or similar) and is loaded by direct import — not from a parsed `recipe.yml` (recipe parser is Alpha 1).
- [ ] Bootstrap level for `init`: `commands` (no provider, no app — recipe execution doesn't need them).
- [ ] Test passes after the impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-002: `lando start` brings up the scaffolded app via `provider-lando`

**Description:** As the user from US-001, I `cd my-app && lando start` and the Node + Postgres services come up under the Lando-managed Podman runtime.

**Acceptance Criteria:**
- [ ] Failing scenario test in `core/test/cli/start.scenario.test.ts` (gated on `LANDO_TEST_PODMAN_SOCKET`; otherwise xfail with a comment explaining the gate) scaffolds an app via `init --full --name=test-start`, `cd`s into it, runs `start`, and asserts:
  - Exit code 0.
  - Both `pre-app-start` and `post-app-start` events were published.
  - The provider's `bringUp` was called once with the planned `AppPlan`.
  - `provider.inspect(plan)` shows both services in `state: running`.
  - Stdout contains a final "ready" line listing each service and its endpoint.
- [ ] Test asserts a missing `.lando.yml` (running `start` outside an app dir) fails with `LandofileNotFoundError` and a remediation pointing at `lando init`.
- [ ] Test asserts a malformed `.lando.yml` fails with `LandofileParseError` carrying `{ filePath, line }` in the rendered output.
- [ ] Test asserts cancellation via SIGINT cleanly tears down partial state (`bringUp`'s `AbortSignal` is honored).
- [ ] Bootstrap level for `start`: `app`.
- [ ] Test passes after the impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-003: `lando stop` brings down the running app

**Description:** As the user from US-002, I `lando stop` and both services are stopped, the per-app network is removed, and volumes are preserved.

**Acceptance Criteria:**
- [ ] Failing scenario test in `core/test/cli/stop.scenario.test.ts` (gated on `LANDO_TEST_PODMAN_SOCKET`; otherwise xfail) brings up the test app, runs `stop`, and asserts:
  - Exit code 0.
  - `pre-app-stop` and `post-app-stop` events were published.
  - `provider.bringDown(plan)` was called once.
  - `provider.inspect(plan)` shows both services in `state: stopped` (or absent — implementer's choice, but consistent).
  - Volumes mentioned in the plan still exist after stop.
- [ ] Test asserts running `stop` against an already-stopped app succeeds (idempotent — no error).
- [ ] Test asserts running `stop` outside an app dir fails with `LandofileNotFoundError`.
- [ ] Bootstrap level for `stop`: `app`.
- [ ] Test passes after the impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-004: `lando info` prints services + endpoints

**Description:** As the user from US-002, I run `lando info` and see a plain-text table of each service's name, state, and endpoints.

**Acceptance Criteria:**
- [ ] Failing scenario test in `core/test/cli/info.scenario.test.ts` (gated on `LANDO_TEST_PODMAN_SOCKET`; otherwise xfail) brings up the test app, runs `info`, captures stdout, and asserts:
  - Output contains the line `node` followed by `running` followed by an endpoint matching `http://localhost:<port>`.
  - Output contains the line `postgres` followed by `running` followed by an endpoint matching `postgresql://<user>@localhost:<port>/<db>`.
  - Output is plain text (no ANSI escape codes when stdout is not a TTY).
- [ ] Test asserts running `info` against a stopped app shows each service with `state: stopped` and no endpoints.
- [ ] Test asserts running `info` outside an app dir fails with `LandofileNotFoundError`.
- [ ] Bootstrap level for `info`: `app`.
- [ ] Test passes after the impl lands.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-005: `lando version` works at bootstrap level `none`

**Description:** As anything that runs `lando --version`, the command exits in <50ms without touching Effect.

**Acceptance Criteria:**
- [ ] PRD-02 US-003 already covers the `--version` / `-v` fast path. This story re-covers `lando version` (the OCLIF subcommand form) and ensures it routes through the same fast-path branch.
- [ ] Failing test in `core/test/cli/version.test.ts` runs `lando version` against the compiled binary, asserts exit code 0, asserts stdout matches `core/package.json` version, and asserts no `makeLandoRuntime` call happened.
- [ ] Test passes once the OCLIF `version` command body is replaced with a thin wrapper that defers to the fast-path branch (or, if simpler, the OCLIF dispatch never reaches the command — the fast path intercepts before OCLIF parses).
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-006: `lando shellenv` works at bootstrap level `none`

**Description:** As a user setting up shell integration, `lando shellenv` runs without any state.

**Acceptance Criteria:**
- [ ] PRD-02 US-004 covers the fast path; this story confirms the OCLIF `shellenv` command body either delegates to the fast path or duplicates the same output.
- [ ] Failing test in `core/test/cli/shellenv.test.ts` runs `lando shellenv` against the compiled binary, asserts stdout contains the `LANDO_INSTALL_DIR` and `PATH` integration lines, and asserts no Effect runtime was constructed.
- [ ] Test passes after the wiring is correct.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-007: Every non-MVP OCLIF command exits with a structured `NotImplementedError`

**Description:** As a user who runs a command not in MVP (e.g. `lando exec`, `apps:scratch:start`), I get a clean error pointing at the spec, not a stack trace.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/cli/not-implemented.test.ts` enumerates every OCLIF command in `core/src/cli/oclif/commands/` not in the MVP set (start, stop, info, version, shellenv, init), runs each, and asserts:
  - Exit code is non-zero (we're not pretending success).
  - Stderr contains a `NotImplementedError` tag.
  - The error message names the spec section that owns the command (e.g. `app:scratch:start` → `spec/19-scratch-apps.md`) so the user knows where to read.
- [ ] No test asserts the *message* text exactly — only the tag + non-empty remediation field.
- [ ] Test passes once every non-MVP command's `run()` body is replaced with a typed `Effect.fail(new NotImplementedError({ command, specSection }))`.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-008: `app:start` / `app:stop` / `app:info` aliases

**Description:** As the spec dictates, both `lando start` and `lando app:start` route to the same command. (OCLIF aliasing.)

**Acceptance Criteria:**
- [ ] Failing test in `core/test/cli/aliases.test.ts` runs `lando start` and `lando app:start` against the compiled binary (mocking out `bringUp`) and asserts both invoke the same command class.
- [ ] Same for `stop` / `app:stop` and `info` / `app:info`.
- [ ] OCLIF aliases are declared on the command class via `static aliases` (per OCLIF v4 conventions).
- [ ] Test passes after aliases are declared.
- [ ] Typecheck/lint/whole-workspace tests pass.

### US-009: End-to-end MVP exit-criteria smoke test

**Description:** As release engineering, I want a single-script reproduction of the roadmap's MVP exit criteria. Not gating CI (no CI yet at MVP), but runnable locally and gating PRD-06 acceptance.

**Acceptance Criteria:**
- [ ] Failing test in `core/test/scenario/mvp-exit-criteria.scenario.test.ts` (gated on `LANDO_TEST_PODMAN_SOCKET` and `process.platform === "linux" && process.arch === "x64"`; otherwise xfail) does the following in a temp dir:
  1. `bun install` (skipped if already installed — assertion is graph-shape, not network).
  2. `bun run codegen`.
  3. `bun test` (skipped — that's recursive; instead, asserts the typecheck + lint succeeded earlier).
  4. `bun run build`.
  5. `dist/lando init --full --name=mvp-exit && cd mvp-exit`.
  6. `../dist/lando start`.
  7. `../dist/lando info` — captures and asserts the output contains both services running.
  8. `../dist/lando stop`.
  9. Cleans up the temp dir + Podman state.
- [ ] Test passes once every prior story is green.
- [ ] Typecheck/lint/whole-workspace tests pass.

## Functional Requirements

- FR-1: Every MVP command's OCLIF class declares `static bootstrap: BootstrapLevel` with the level it needs (US-001 `commands`; US-002/3/4 `app`; US-5/6 `none` via fast path).
- FR-2: Every command's `run()` body is an Effect program that uses `yield*` against SDK service tags only — no direct imports of Live impls from plugin packages.
- FR-3: Every error surfaced to the user is rendered through the `Logger` Live (PRD-03 US-007); raw `console.error` is forbidden in command bodies.
- FR-4: Every error is one of the SDK tagged errors (PRD-01 US-005). The renderer maps `_tag` to a remediation message.
- FR-5: `lando init --full` consumes a hardcoded built-in recipe — no FS scan, no remote fetch.
- FR-6: Output to stdout is plain text only at MVP (no concurrent task tree, no first-paint banner — those are Alpha 1+).
- FR-7: SIGINT (and SIGTERM) cancels the running Effect via the `AbortSignal` plumbed through `bringUp` / `bringDown`.
- FR-8: `lando` invoked with no args prints the OCLIF help; this works at bootstrap level `commands` and does *not* require provider initialization.

## Non-Goals

- **No interactive prompts** in `init`. `--full --name=<name>` is the only path; everything else is Alpha 1 (`spec/08-cli-and-tooling.md` recipe prompts).
- **No `recipe.yml` parsing.** Hardcoded built-in recipe only.
- **No remote recipe sources** (`git`, `tarball`, `npm`, `registry`). Alpha 3.
- **No `apps:list`, `apps:poweroff`** at MVP — Alpha 1 (`apps:*` namespace).
- **No `meta:*` commands beyond what fast-paths handle.** `meta:config`, `meta:plugin:*`, `meta:setup`, `meta:doctor`, `meta:bun`, `meta:x` — all Alpha 1+.
- **No `apps:init` interactive prompt flow.** Alpha 1.
- **No `app:cache:refresh`, `app:includes:*`, `app:config:translate`.** Alpha 1+.
- **No tooling commands** (`lando exec`, `lando ssh`, `lando shell`, user-defined tooling). Alpha 1.
- **No `lando logs` command** at MVP. Alpha 1.
- **No JSON / lando / verbose renderers.** Plain text only.
- **No telemetry events on commands.** Beta 1.

## Technical Considerations

- The OCLIF init hook (PRD-02 US-002) is the only place that reads `static bootstrap`; commands themselves don't construct runtimes.
- `lando init` cannot use the provider — it runs at bootstrap `commands`. It writes files via `FileSystem` (PRD-03 US-003).
- Cancellation: when SIGINT fires, the OCLIF main wraps the command's Effect with an interrupt scope. PRD-04's `bringUp` honors the `AbortSignal`. The CLI shell installs the signal handlers per `installSignalHandlers: true` (PRD-02 US-001 default for CLI mode).
- Output: at MVP, `Logger.pretty` writes to stderr; command "data" output (e.g. `info` table) goes to stdout via `process.stdout.write` from inside the Effect program. Alpha 3 swaps this for a renderer.
- Built-in recipe location: `core/src/recipes/builtin/node-postgres/` keeps the recipe assets (the `.lando.yml` template, the skeleton `package.json`). At MVP, these are read from the filesystem of the source tree. Asset embedding into the compiled binary is Alpha 3 (`spec/15-binary-build-and-release.md`).
- The MVP exit-criteria scenario test (US-009) takes time to run — exclude it from default `bun test` via tag (`scenario.test.ts` suffix) and run explicitly with `bun test core/test/scenario/`. **CI runs it on every PR** via [PRD-07](./prd-mvp-07-ci-and-binaries.md)'s `provider-integration-linux-x64` job — failing this test blocks merge.

## Success Metrics

- Six commands work end-to-end on Linux x64 with Podman installed.
- Roadmap's verbatim exit-criteria command succeeds on a clean Linux x64 checkout.
- Every non-MVP command returns `NotImplementedError` with a usable remediation — no `Effect.die` panics in user-facing flows.
- Cancellation (Ctrl-C) cleans up state every time — zero orphaned containers after 50 consecutive `start; ^C` test cycles.

## Open Questions

- How does `lando init` decide the project skeleton beyond the `.lando.yml`? Default at MVP: a 3-file skeleton (`.lando.yml`, `package.json`, `README.md`). Larger skeletons (entry points, `tsconfig.json`, etc.) are recipe-content decisions deferred to Alpha 1.
- Should `info` print a JSON output if `--renderer=json` is passed? Default at MVP: no — `--renderer` flag is Alpha 1. The command always prints plain text.
- Is `lando` (no args) routed to OCLIF's default help, or do we ship a custom landing page? Default at MVP: OCLIF default help; custom landing is Alpha 3.
- The OCLIF v4-vs-v5 question is a roadmap "cross-cutting risk" — at MVP we stay on v4. Document the lock in `spec/14-appendices.md` only; this PRD does not include a v5 migration story.
