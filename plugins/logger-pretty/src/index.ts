/**
 * `@lando/logger-pretty` — pretty-printed Logger plugin.
 *
 * Status: MVP no-op. Effect's default pretty logger is already installed by
 * core, so this package only exercises bundled logger plugin discovery.
 */
import { Layer, Schema } from "effect";

import { PluginManifest } from "@lando/sdk/schema";

export const PLUGIN_NAME = "@lando/logger-pretty" as const;

export const logger = Layer.empty;

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  description: "Pretty-printed Logger plugin.",
  enabled: true,
  contributes: { loggers: ["pretty"] },
  entry: "./src/index.ts",
});
