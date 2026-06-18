import { Layer, Schema } from "effect";

import { PluginManifest } from "@lando/sdk/schema";

export const PLUGIN_NAME = "@lando/renderer-lando" as const;

export const renderer = Layer.empty;

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "Bundled default Lando Renderer plugin.",
  enabled: true,
  contributes: { renderers: ["lando"] },
  entry: "./src/index.ts",
});
