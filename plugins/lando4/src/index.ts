/**
 * `@lando/lando4` — the canonical v4 Landofile config translator.
 *
 * Contributes:
 *   - `configTranslators: ["lando4"]` — decodes a core-ordered set of canonical
 *     v4 YAML documents into authoring fragments and encodes authoring values
 *     back to tag-free block-style YAML through the canonical serializer.
 *
 * The factory is a lazy literal dynamic import so ordinary bootstrap, help,
 * version, loading, and tooling paths never construct the codec. Only an
 * explicit conversion request resolves this loader, and the literal specifier
 * stays traceable for `bun build --compile`.
 */
import { Schema } from "effect";

import { definePlugin } from "@lando/sdk/plugins";
import type { ConfigTranslatorLoader } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";

export const PLUGIN_NAME = "@lando/lando4" as const;

/** Translator id contributed by this plugin. */
export const LANDO4_TRANSLATOR_ID = "lando4";

/** Lazy translator factories, keyed by translator id. */
export const configTranslators: ReadonlyMap<string, ConfigTranslatorLoader> = new Map([
  [LANDO4_TRANSLATOR_ID, () => import("./translator.ts").then((module) => module.lando4ConfigTranslator)],
]);

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "Expression-aware canonical v4 Landofile config translator for Lando v4.",
  enabled: true,
  contributes: {
    configTranslators: [
      {
        id: LANDO4_TRANSLATOR_ID,
        module: "./src/translator.ts",
        inputKinds: [LANDO4_TRANSLATOR_ID],
        detects: ["**/.lando.yml", "**/.lando.*.yml"],
        summary: "Canonical v4 Landofile YAML decoder and expression-aware encoder.",
      },
    ],
  },
  entry: "./src/index.ts",
});

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  configTranslators,
});
