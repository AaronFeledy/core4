/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-bundled-plugins.ts`.
 *
 * Source of truth: `core/build.config.ts` (the "ship list").
 *
 * The default Lando v4 binary is built with `bun build --compile` (SPEC: §17.1
 * stage 7). Compiled binaries cannot dynamically `import()` arbitrary files at
 * runtime, so bundled plugins are statically imported here. Library consumers
 * do not receive bundled plugins by default — they must opt into bundled
 * discovery or contribute their own Layers.
 */

import type { Layer } from "effect";

export const BUNDLED_PLUGINS: ReadonlyArray<{
  readonly id: string;
  readonly layer: Layer.Layer<unknown, unknown, never>;
}> = [];
