/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-bundled-plugins.ts`.
 *
 * Source of truth: `core/build.config.ts` (the "ship list").
 *
 * The default Lando v4 binary is built with `bun build --compile`.
 * Compiled binaries cannot dynamically `import()` arbitrary files at
 * runtime, so bundled plugins are statically imported here. Library consumers
 * do not receive bundled plugins by default — they must opt into bundled
 * discovery or contribute their own Layers.
 */

import { Layer } from "effect";
import { Schema } from "effect";

import { type PluginManifest, PluginManifest as PluginManifestSchema } from "@lando/sdk/schema";

const makeManifest = (name: string, contributes?: PluginManifest["contributes"]): PluginManifest =>
  Schema.decodeSync(PluginManifestSchema)({
    name,
    version: "0.0.0",
    api: 4,
    bundled: true,
    ...(contributes === undefined ? {} : { contributes }),
  });

export const BUNDLED_PLUGINS: ReadonlyArray<{
  readonly name: string;
  readonly layer: Layer.Layer<never, never, never>;
  readonly manifest: PluginManifest;
}> = [
  {
    name: "@lando/provider-lando",
    layer: Layer.empty,
    manifest: makeManifest("@lando/provider-lando", { providers: ["lando"] }),
  },
  {
    name: "@lando/provider-docker",
    layer: Layer.empty,
    manifest: makeManifest("@lando/provider-docker", { providers: ["docker"] }),
  },
  {
    name: "@lando/service-lando",
    layer: Layer.empty,
    manifest: makeManifest("@lando/service-lando", { serviceTypes: ["lando"] }),
  },
  {
    name: "@lando/logger-pretty",
    layer: Layer.empty,
    manifest: makeManifest("@lando/logger-pretty", { loggers: ["pretty"] }),
  },
];
