# core/AGENTS.md

Inherit the root `AGENTS.md` instructions for all core package work.

## Executable Guide TDD

- Use `bun run dev:guides` from the repo root as the dev-time TDD loop for executable guides. It regenerates guide scenarios, typechecks the generated path, and re-runs the affected guide scenario tests on changes to guide MDX, core/sdk/plugin source, or the scenario generator.
- Use `bun run dev:guides docs/guides/<path>.mdx` for a focused single-guide loop, and add `--once` for a single non-watching pass.

## Test fixtures

- `core/test/cli/fixtures/*.json` is NOT in biome's ignore list, so committed JSON fixtures get reformatted to pretty-printed JSON by `bun run lint`. A renderer that emits compact JSON (e.g. `JSON.stringify(value)`) therefore cannot be string-compared against its committed fixture — assert `JSON.parse(rendererOutput)` deep-equals `Bun.file(fixture).json()` instead, so biome formatting of the fixture never diverges from the renderer's whitespace.

## Git recipe source

- `lando init --source=git` is acquisition-only: it shallow-clones through `core/src/recipes/git-source.ts`, publishes by commit SHA under `<userDataRoot>/recipe-cache/git/`, and then uses the existing recipe render path. Non-bundled directory recipe rendering is still the shared Alpha boundary, so do not assume git recipes scaffold end-to-end yet.
- `lando init --source=tarball` mirrors git acquisition in `core/src/recipes/tarball-source.ts`: it downloads via an injectable `fetcher` (default = global `fetch`, which accepts `file://` for tests), SHA-256-verifies, extracts via a pure-JS tar(.gz) reader (no host `tar` dependency at runtime), and publishes under `<userDataRoot>/recipe-cache/tarball/<sha256>/`. `--checksum` makes verification hard-fail (`checksum-mismatch`, computed BEFORE any extraction); without it the resolver warns once with the computed digest and, when an interactive `confirmUnverified` seam is supplied (i.e. not `--yes`/`--no-interactive`), prompts once — a decline aborts with `checksum-unverified`. The verify/prompt seam lives in `loadTarballRecipe` (`init.ts`), not the resolver, so the resolver stays pure/injectable.
- Keep remote-source CLI parsing centralized in `core/src/cli/commands/init-source.ts`; both OCLIF init and the compiled dispatcher must accept/reject `--source`/`--url`/`--path`/`--checksum` identically (preserve the exact per-source missing-url wording — `<git-url>` vs `<tarball-url>` — to keep the parity tests green), and the default git cloner must keep interactive prompts disabled.

## Recipe prompts — dynamic `choicesFrom:`

- A `select`/`multiselect` prompt can source choices from a canonical Lando command via `choicesFrom: { command, args?, parse: "json"|"lines" }`. Execution lives in `core/src/recipes/prompts/choices-command.ts` behind an injectable `ChoicesCommandRunner`. The default runner re-invokes Lando as a child process using `landoInvocationPrefix(execPath, argv)`: compiled (`bun build --compile`) binaries embed the entry under `$bunfs` so `process.execPath` IS `lando` (prefix `[execPath]`); source mode prefixes `argv[1]` (the CLI entry). Do NOT set `BUN_BE_BUN` here — choicesFrom wants normal lando dispatch, not bun-mode (unlike `bun-self-runner.ts`).
- The dynamic-choices flow is implemented in `collectPrompts` (`runtime.ts`), not the manifest layer: it expands `choicesFrom` into `choices` at resolve time. A supplied `--answer` for a dynamic prompt is taken verbatim and never spawns the command. Command failure (exit ≠ 0 / spawn error / unparseable / empty) falls back to a manual free-text prompt when interactive, or uses the recipe default / fails with `RecipeChoicesError` when non-interactive. Because directory/remote recipes bail at the "rendering not implemented" boundary before `collectPrompts`, a full `lando init` never runs the dynamic-choices path yet — cover runtime behavior with an injected fake `choicesRunner` in unit tests.

## Renderer task-tree tail (interactive Lando renderer)

- The interactive (TTY) Lando renderer's per-task detail tail lives in `core/src/cli/renderer/task-tree-tail.ts`: `TaskDetailRing` (fixed-capacity, oldest-out) plus `LandoTreePainter`, a pure state machine driven by `task.*` events that returns the CSI byte chunk to write. It uses a **whole-frame redraw** model — it tracks how many rows the previous frame occupied, rewinds the cursor (`ESC[<n>A`), erases downward (`ESC[0J`), and repaints the entire active tree — rather than per-panel cursor accounting, so concurrent stacked sibling panels and collapsing frames work without bespoke choreography. Non-task-tree events route through `painter.passthrough(line)` so plain lines scroll above the live frame without corrupting the cursor.
- `makeLandoRendererLive(io)` branches on `RendererIO.isTTY`: `true` engages the painter; `undefined`/`false` falls back to `makePlainRendererLive` (the `[taskId] line` line-per-event contract). `createBufferedRendererIO()` leaves `isTTY` unset on purpose so existing buffered renderer tests stay on the plain path. Assert painter CSI bytes on the pure `LandoTreePainter` directly; assert renderer selection via a `{ ...createBufferedRendererIO(), isTTY: true }` double.
- The `--tail` / `--no-tail` toggle stays deferred in `core/src/cli/renderer-deferred.ts` (the ring buffer is fixed-on at depth 4 for Beta); do not wire a CLI flag for it.
