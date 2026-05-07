/**
 * **GENERATED FILE** — bundled plugin static imports.
 *
 * The default Lando v4 binary is built with `bun build --compile`. Compiled
 * binaries cannot dynamically `import()` arbitrary files at runtime, so
 * bundled plugins are statically imported here. The build step
 * (`scripts/build-bundled-plugins.ts`, TBD) regenerates this file from the
 * bundle set declared at build time.
 *
 * Library consumers do **not** receive bundled plugins by default — they
 * must opt into bundled discovery or contribute their own Layers.
 *
 * Status: stub. The bundled set is empty until the bundled plugin packages
 * (`plugins/service-lando`, `plugins/provider-docker`, etc.) are
 * implemented.
 */

import type { Layer } from "effect";

/**
 * Statically-imported bundled plugin Layers.
 *
 * Each entry is a `{ id, layer }` pair so the runtime can route them through
 * the same selection precedence as runtime-discovered plugins.
 */
export const BUNDLED_PLUGINS: ReadonlyArray<{
  readonly id: string;
  readonly layer: Layer.Layer<unknown, unknown, never>;
}> = [
  // TODO: regenerate from `scripts/build-bundled-plugins.ts`.
];
