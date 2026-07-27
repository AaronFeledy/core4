/**
 * `@lando/logger-pretty` — pretty-printed Logger plugin.
 *
 * Status: MVP no-op. Effect's default pretty logger is already installed by
 * core, so this package only exercises bundled logger plugin discovery.
 */
import { Layer, Schema } from "effect";

import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";

export const PLUGIN_NAME = "@lando/logger-pretty" as const;

export const logger = Layer.empty;

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "Pretty-printed Logger plugin.",
  enabled: true,
  contributes: { loggers: ["pretty"] },
  entry: "./src/index.ts",
});

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  layer: logger,
  loggers: new Map([["pretty", logger]]),
});
