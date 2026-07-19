import { Schema } from "effect";

import type { RendererContribution } from "@lando/sdk/renderer";
import { PluginManifest } from "@lando/sdk/schema";

import { landoRendererContribution } from "./renderer-runtime.ts";
export { makeLandoNotificationConsumer as makeNotificationConsumer } from "./renderer-runtime.ts";

export const PLUGIN_NAME = "@lando/renderer-lando" as const;

/**
 * The default TTY renderer, owned by this plugin: the task-tree painter, event
 * consumer, `Renderer` service, and non-TTY plain fallback. Core resolves this
 * contribution through the bundled-renderer registry instead of assembling the
 * renderer from parts.
 */
export const renderer: RendererContribution = landoRendererContribution;

export const loadInteractivePromptDriver = async (): Promise<{
  readRaw: (request: unknown, signal?: AbortSignal) => Promise<string>;
}> => {
  const mod = await import("./opentui/prompt-driver.ts");
  return mod.createOpenTuiPromptDriver();
};

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
