# `@lando/core` Instructions

Inherit root `AGENTS.md`; keep only core-specific traps here.

## Tests and Guides

- `core/test/cli/fixtures/*.json` is formatted by `bun run lint`. Renderer tests should compare `JSON.parse(output)` to `Bun.file(fixture).json()`, not raw compact JSON strings.
- Guide TDD specifics live in the root file. Use the core notes here only when changing the guide generator/runtime behavior, not for routine MDX edits.

## Recipe Sources

- `lando init --source=git` is acquisition-only: `core/src/recipes/git-source.ts` shallow-clones, publishes by commit SHA under `<userDataRoot>/recipe-cache/git/`, then falls through to the existing recipe render path. Do not assume non-bundled directory recipes scaffold end-to-end yet.
- `lando init --source=tarball` downloads through the resolver seam, SHA-256-verifies before extraction, uses the pure-JS tar(.gz) reader, and publishes under `<userDataRoot>/recipe-cache/tarball/<sha256>/`. `--checksum` hard-fails on mismatch; without it, verification/prompt handling belongs in `loadTarballRecipe` in `init.ts`, not the resolver.
- Keep remote-source CLI parsing centralized in `core/src/cli/commands/init-source.ts`; OCLIF init and compiled dispatch must share `--source`/`--url`/`--path`/`--checksum` acceptance and exact missing-url wording (`<git-url>` vs `<tarball-url>`). The default git cloner must stay non-interactive.

## Programmatic `recipe.ts`

- A local recipe directory may contain `recipe.ts` or `recipe.yml`, never both (`resolveLocal` rejects both). `recipe.ts` default-exports a `Recipe` object or async factory, loads through `loadRecipeTs`, reuses Landofile sandbox scanning, imports via Bun's TS loader, and times out via `LANDO_RECIPE_TS_TIMEOUT_MS`.
- `validateRecipeManifestObject` applies the same Beta rejection, strict decode, and semantic checks as YAML. `ResolvedRecipe.manifest` short-circuits `parseResolvedRecipe`, so the manifest must not be parsed twice.
- `defineRecipe` is a value export and must be listed under `sdk/API_COMPATIBILITY.md`'s asserted schema-export heading; `Recipe`/`RecipeContext`/`RecipeFactory` are erased types and must not be listed. No schema snapshot is needed unless `JSON_SCHEMA_REGISTRY` changes.
- Tests outside this repo should use plain `export default { ... }`; a `recipe.ts` importing `@lando/sdk` only resolves where that package is on the module path.

## Dynamic Prompt Choices

- `choicesFrom: { command, args?, parse }` runs in `core/src/recipes/prompts/choices-command.ts` behind `ChoicesCommandRunner`. Use `landoInvocationPrefix(execPath, argv)`: compiled binaries run as `[process.execPath]`, source mode uses `argv[1]`. Do not set `BUN_BE_BUN` here.
- `collectPrompts` expands `choicesFrom` at prompt time, not manifest validation time. A supplied `--answer` bypasses the command. Directory/remote recipes currently hit the Alpha render boundary before this path, so unit-test dynamic choices with an injected fake `choicesRunner`.

## Renderer Task Tree

- `core/src/cli/renderer/task-tree-tail.ts` owns `TaskDetailRing` and `LandoTreePainter`. The painter uses whole-frame redraw (`cursorUp` + `eraseDown` + repaint), so keep passthrough lines flowing through `painter.passthrough(line)`.
- The default `lando` renderer is assembled by bundled `@lando/renderer-lando`; core keeps painter/keybinding/formatter primitives and materializes the plugin factory via `bundled-renderers.ts`. Tests needing the Lando layer import `landoRenderer`, while pure painter behavior should assert `LandoTreePainter` directly.
- `RendererIO.isTTY` gates the painter: `true` uses TTY rendering, `undefined`/`false` stays plain line-per-event. `createBufferedRendererIO()` leaves `isTTY` unset; fake-TTY tests must set `{ isTTY: true }` explicitly.
- `task.tree.start` first-paints pending child placeholders and must not emit rewind bytes on that first frame; tests assert absence of `cursorUp`/`eraseDown`, not absence of all ANSI SGR.
- `--tail`/`--no-tail` is still deferred; do not wire a CLI flag. Expand/collapse events remain non-renderable in `format.ts` to avoid publish/consume echo loops.
- TTY key input is wired inside the renderer Live layer (`makeTaskTreeInputLive`), not command modules; fake input uses `createBufferedRendererIO({ isTTY: true, terminalRows }).injectKey(...)`.

## CLI Dispatch Parity

- Dual dispatch is structural: source mode uses OCLIF, compiled `$bunfs` mode uses `runCompiledCli`. A faithful compiled reproduction must run the binary outside the repo tree so `findRoot` cannot accidentally discover the source checkout.
- JSON renderer parity is byte-identical apart from normalized timestamps/temp paths; plain/`lando` stderr is allowed to differ in wrapping/prefixes but must preserve tagged-error fields.
- Host-safe `meta:setup` parity tests should force `PATH=/no-such-path`, isolated `LANDO_USER_*` roots, and `--provider=podman`; the default `lando` provider attempts a network bundle download.
- Compiled `meta:plugin:*` handlers must manually replicate OCLIF parse errors. `--renderer`/`--help`/`--version` are stripped before command dispatch, while command-scoped unknown flags still need exit-2 rejection.

## Machine-output gate

- `bun run check:machine-output` (`scripts/check-machine-output.ts`) is a TypeScript-AST boundary gate over `core/src/**`+`plugins/**`. It fails on a `JSON.stringify` whose argument is (recursively, with shallow same-file `const`/`let` alias resolution) a command-result envelope (direct keys `apiVersion`+`command`+`ok`+`result`|`error`) or a `{ _tag: "result", envelope }` stream frame; the only carve-out is `core/src/cli/result-encode.ts`. Serialize result envelopes only through `encodeCommandResult`/`encodeStreamResultFrame`; a synchronous `=> string` helper can route through them via `Effect.runSync(...)` with the exported `identityRedactor` when its payload carries no secret-bearing field (the doctor NDJSON renderers do this). The gate also flags a `LandoCommandSpec` object literal (annotated `: LandoCommandSpec` or shaped `id`+`summary`+`namespace`+`bootstrap`+`run`) missing a direct `resultSchema`; `EmptyResultSchema` counts as present.

## Downloader / HttpClient

- `DownloaderLive` issues every byte through core-private `HttpClient.stream`; it never calls `fetch` directly. Its `download()` `R` channel stays `Scope.Scope` because the live layer closes over `HttpClient` at construction.
- `HttpClient` in `core/src/http-client/service.ts` is provisional and not exported from `@lando/sdk/services` or `core/src/services/index.ts`. `HttpClientBasicLive` is the only `fetch` call site under `core/src/` until the full SDK HttpClient story lands.
- Reuse `@lando/sdk/verified-stream` for stream -> hash -> temp -> atomic rename; do not add another checksum/temp-file implementation.
- Bootstrap wiring is provided-only: the generator emits `DownloaderLive.pipe(Layer.provide(Layer.mergeAll(HttpClientBasicLive, EventServiceLive)))`. Edit `scripts/build-bootstrap-layers.ts` and regenerate, never hand-edit `core/src/runtime/generated/layers/minimal.ts`.
- Download progress/redaction/egress-fence contracts are not implemented yet; memory mode is verify-only and returns `path`, not `bytes`.
