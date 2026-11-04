import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { Schema } from "effect";
import packageJson from "../package.json";

export const PLUGIN_NAME = "@lando/github-actions" as const;

const { entry: _entry, ...descriptorManifest } = packageJson.landoPlugin;
export const manifest = Schema.decodeUnknownSync(PluginManifest)(descriptorManifest);

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  commands: new Map([["github-actions:list", () => import("./command.ts").then((module) => module.spec)]]),
});
