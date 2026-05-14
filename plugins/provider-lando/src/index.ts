/**
 * `@lando/provider-lando` — Lando-managed RuntimeProvider.
 *
 * Status: stub. Provider implementation lands at `./src/provider.ts`.
 */
import { Layer, Schema } from "effect";

import { PluginManifest } from "@lando/sdk/schema";

export const PLUGIN_NAME = "@lando/provider-lando" as const;

export const provider = Layer.empty;

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  description: "Reference Lando-managed RuntimeProvider implementation.",
  enabled: true,
  contributes: { providers: ["lando"] },
  entry: "./src/index.ts",
});
