# `@lando/renderer-lando` Instructions

Inherit root `AGENTS.md`. Keep only package-specific facts agents would miss.

## Design

- Read, follow, and update `DESIGN.md` before any renderer visual, design, color, layout, or motion work.
- `DESIGN.md` is the TTY rail contract. Do not invent tokens, glyphs, or motion outside it.
- plain, JSON, verbose, non-TTY, and CI stay undecorated. Do not leak rail chrome, glyphs, or colors into machine modes.
- All narration, live regions, prompts, and OSC notifications use stderr. Event consumers receive `RendererNarrationIO`, without stdout writers. Services receive full `RendererIO`; result TTY metadata is `stdoutIsTTY`/`stdoutColumns`. Terminal stdout payloads suspend/erase the stderr region, write to stdout, then repaint; redirected payloads never interact with the region.

## Gotchas

- Pink (`csi.pink`, SGR 95) is rail chrome, the active moving spinner glyph, and the opt-in brand icon. Running labels, static dot, wrap continuations, durations, and footers stay off pink.
- Paint segmented bodies through `styleBodyFrameSegments` and existing `csi` tokens. Do not add color tokens or raw ANSI literals.
- Default live region is inline at the cursor. OpenTUI is full-tail only.
- `@opentui/core` is pinned exactly to 0.8.0, the last release whose native packages are MIT only; 0.8.1+ statically link LGPL FFmpeg and fail `check:compiled-binary-notices`. Bump it only with a video-free native library (https://github.com/anomalyco/opentui/issues/2088), and keep the pin in `scripts/build-opentui-native-stubs.ts` and `.github/dependabot.yml` in step.
- OpenTUI terminal transitions are asynchronous: `destroy()` restores the terminal later, and `suspend()`/`resume()` return promises that reject while another transition is pending. Await `renderer.closed` before anything else writes to that terminal, and run full-tail steps through the controller's `TransitionQueue` (`opentui/live-region-transitions.ts`).
- Only `opentui/prompt-driver.ts` and `opentui/live-region-substrate.ts` may import `@opentui/core`, and only as a literal `import()`. Every other `src/**` file reaches it through the structural `*Like` seams in `opentui/*-types.ts`, type positions included: the boundary gates count `import type` and `typeof import(...)` as module edges.
