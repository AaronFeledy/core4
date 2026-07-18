import { Schema } from "effect";

import { PluginManifest } from "@lando/sdk/schema";

export const PLUGIN_NAME = "@lando/notify-lando" as const;

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "Bundled Lando desktop-notification policy plugin.",
  enabled: true,
  entry: "./src/index.ts",
  subscribers: [
    {
      id: "notify-command-terminal",
      selectors: [{ family: "cli-command-terminal" }],
      module: "./src/notify.ts",
      priority: 900,
      configKey: "notify",
    },
  ],
});
