import { Schema } from "effect";

import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";

export const PLUGIN_NAME = "@lando/sql" as const;

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "Bundled database import, export, snapshot, restore, and reset commands.",
  enabled: true,
  entry: "./src/index.ts",
  contributes: {
    commands: ["db:import", "db:export", "db:snapshot", "db:restore", "db:reset"],
  },
});

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  commands: new Map([
    ["db:import", () => import("./commands/import.ts").then((module) => module.spec)],
    ["db:export", () => import("./commands/export.ts").then((module) => module.spec)],
    ["db:snapshot", () => import("./commands/snapshot.ts").then((module) => module.spec)],
    ["db:restore", () => import("./commands/restore.ts").then((module) => module.spec)],
    ["db:reset", () => import("./commands/reset.ts").then((module) => module.spec)],
  ]),
});
