/**
 * `@lando/lando3` — the Lando 3 Landofile document-set frontend.
 *
 * Contributes:
 *   - `configTranslators: ["lando3"]` — a decode-only frontend that reads a
 *     core-ordered set of Lando 3 layers in the source-preserving `LEGACY`
 *     dialect and lowers it to Lando 4 authoring fragments.
 *
 * The factory is a lazy literal dynamic import so ordinary bootstrap, help,
 * version, loading, and tooling paths never construct the frontend. Only an
 * explicit conversion request resolves this loader, and the literal specifier
 * stays traceable for `bun build --compile`.
 *
 * `makeLando3Plugin` exists so a host can inject real ports — recipe
 * decomposition comes from the host, never from a second recipe expansion
 * inside this package. The bundled `plugin` is the same factory with the
 * package's own defaults, which keeps the generated composition table a plain
 * value import.
 */
import { Schema } from "effect";

import { definePlugin } from "@lando/sdk/plugins";
import type { ConfigTranslatorLoader, LandoPluginModule } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";

import { LANDO3_TRANSLATOR_ID, type Lando3TranslatorPorts } from "./contract.ts";

export const PLUGIN_NAME = "@lando/lando3" as const;

export { LANDO3_TRANSLATOR_ID };
export type { Lando3TranslatorPorts };

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "Source-preserving Lando 3 Landofile document-set frontend for Lando v4.",
  enabled: true,
  contributes: {
    configTranslators: [
      {
        id: LANDO3_TRANSLATOR_ID,
        module: "./src/translator.ts",
        inputKinds: [LANDO3_TRANSLATOR_ID],
        detects: ["**/.lando.yml", "**/.lando.*.yml"],
        summary: "Decode-only Lando 3 Landofile set frontend.",
      },
    ],
  },
  entry: "./src/index.ts",
});

/**
 * Builds the plugin module. `ports` is optional only so the bundled value can
 * exist before a host composes one; the loader resolves the package defaults
 * inside the dynamic import, which keeps redaction and decomposer wiring off
 * the module graph that the composition table imports eagerly.
 */
export const makeLando3Plugin = (ports?: Lando3TranslatorPorts): LandoPluginModule =>
  definePlugin({
    name: manifest.name,
    manifest,
    configTranslators: makeConfigTranslators(ports),
  });

export const makeConfigTranslators = (
  ports?: Lando3TranslatorPorts,
): ReadonlyMap<string, ConfigTranslatorLoader> =>
  new Map([
    [
      LANDO3_TRANSLATOR_ID,
      () =>
        import("./translator.ts").then(({ makeLando3ConfigTranslator, defaultLando3Ports }) =>
          makeLando3ConfigTranslator(ports ?? defaultLando3Ports()),
        ),
    ],
  ]);

export const configTranslators: ReadonlyMap<string, ConfigTranslatorLoader> = makeConfigTranslators();

export const plugin = makeLando3Plugin();
