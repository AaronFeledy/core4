import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { Schema } from "effect";

import { scheduleCompileFeature } from "./app-feature.ts";

export const PLUGIN_NAME = "@lando/schedule" as const;

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "Bundled per-service scheduled jobs for Lando.",
  enabled: true,
  entry: "./src/index.ts",
  contributes: {
    appFeatures: [scheduleCompileFeature.id],
    commands: [
      { id: "schedule:list", summary: "List scheduled jobs and their next run times.", mcpAllowed: true },
      { id: "schedule:run", summary: "Run a scheduled job once, now, in the sidecar that schedules it." },
    ],
  },
});

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  appFeatures: new Map([[scheduleCompileFeature.id, scheduleCompileFeature]]),
  commands: new Map([
    ["schedule:list", () => import("./commands/list.ts").then((module) => module.spec)],
    ["schedule:run", () => import("./commands/run.ts").then((module) => module.spec)],
  ]),
});
