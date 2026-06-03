/**
 * `@lando/template-mustache` — Mustache whole-file template engine.
 *
 * Contributes:
 *   - `templateEngines: ["mustache"]` — a logic-less whole-file `TemplateEngine`
 *     used to render a Landofile (or any template site) before YAML parse.
 *
 * The `templateEngines` map is the static, compiled-binary-safe contribution
 * surface: core resolves an engine by id from this map (captured in the
 * generated `BUNDLED_PLUGINS` table) instead of dynamically importing the
 * manifest `module:` path, which cannot resolve in a `bun build --compile`
 * binary. The manifest still records `module:` for documentation and the
 * non-bundled (future) dynamic-import fallback.
 */
import { Layer, Schema } from "effect";

import { PluginManifest } from "@lando/sdk/schema";
import type { TemplateEngine } from "@lando/sdk/template";

import mustacheEngine from "./engine.ts";

export const PLUGIN_NAME = "@lando/template-mustache" as const;

/** TemplateEngine Layer slot. The engine is a pure contribution; no Layer wiring. */
export const templateEngine = Layer.empty;

/** Static template-engine contributions, keyed by engine id. */
export const templateEngines: ReadonlyMap<string, TemplateEngine> = new Map([["mustache", mustacheEngine]]);

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  description: "Mustache whole-file template engine for Lando v4.",
  enabled: true,
  contributes: {
    templateEngines: ["mustache"],
  },
  entry: "./src/index.ts",
});
