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
    commands: [
      { id: "db:import", summary: "Import a database dump into a service." },
      { id: "db:export", summary: "Export a database dump from a service." },
      { id: "db:snapshot", summary: "Create a named snapshot of a database service." },
      { id: "db:snapshots", summary: "List database snapshots and recovery points.", mcpAllowed: true },
      { id: "db:snapshots:prune", summary: "Preview or apply database snapshot retention." },
      { id: "db:restore", summary: "Restore a database service from a snapshot." },
      { id: "db:reset", summary: "Reset a database service to an empty state." },
      { id: "db:seed", summary: "Seed a fresh database from a dump, snapshot, or running app." },
    ],
  },
});

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  commands: new Map([
    ["db:import", () => import("./commands/import.ts").then((module) => module.spec)],
    ["db:export", () => import("./commands/export.ts").then((module) => module.spec)],
    ["db:snapshot", () => import("./commands/snapshot.ts").then((module) => module.spec)],
    ["db:snapshots", () => import("./commands/snapshots.ts").then((module) => module.spec)],
    ["db:snapshots:prune", () => import("./commands/prune.ts").then((module) => module.spec)],
    ["db:restore", () => import("./commands/restore.ts").then((module) => module.spec)],
    ["db:reset", () => import("./commands/reset.ts").then((module) => module.spec)],
    ["db:seed", () => import("./commands/seed.ts").then((module) => module.spec)],
  ]),
});
