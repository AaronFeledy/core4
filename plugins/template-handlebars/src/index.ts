/**
 * `@lando/template-handlebars` — Handlebars whole-file template engine.
 *
 * Contributes:
 *   - `templateEngines: ["handlebars"]` — a whole-file `TemplateEngine` used to
 *     render a Landofile (or any template site) before YAML parse.
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

import handlebarsEngine from "./engine.ts";

export const PLUGIN_NAME = "@lando/template-handlebars" as const;

/** TemplateEngine Layer slot. The engine is a pure contribution; no Layer wiring. */
export const templateEngine = Layer.empty;

/** Static template-engine contributions, keyed by engine id. */
export const templateEngines: ReadonlyMap<string, TemplateEngine> = new Map([
  ["handlebars", handlebarsEngine],
]);

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  description: "Handlebars whole-file template engine for Lando v4.",
  enabled: true,
  contributes: {
    templateEngines: ["handlebars"],
  },
  entry: "./src/index.ts",
});
