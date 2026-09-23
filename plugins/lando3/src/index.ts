/**
 * `@lando/lando3` — the Lando 3 Landofile document-set frontend.
 *
 * Contributes:
 *   - `configTranslators: ["lando3"]` — a decode-only frontend that reads a
 *     core-ordered set of Lando 3 layers in the source-preserving `LEGACY`
 *     dialect and lowers it to Lando 4 authoring fragments.
 *   - `doctorChecks` — read-only Lando 3 resource and PATH observations.
 *
 * The factories use lazy literal dynamic imports so ordinary bootstrap, help,
 * version, loading, and tooling paths never construct the frontend. Only an
 * explicit conversion or doctor request resolves its loader, and each literal specifier
 * stays traceable for `bun build --compile`.
 *
 * `makeLando3Plugin` exists so a host can inject real ports — recipe
 * decomposition comes from the host, never from a second recipe expansion
 * inside this package. The standalone `plugin` uses the package defaults;
 * hosts can pass a lazy ports provider at their composition root.
 */
import { Effect, Schema } from "effect";

import { definePlugin } from "@lando/sdk/plugins";
import type {
  ConfigTranslatorLoader,
  LandoPluginModule,
  PluginDoctorCheckContribution,
} from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";

import { LANDO3_TRANSLATOR_ID, type Lando3TranslatorPorts } from "./contract.ts";

export const PLUGIN_NAME = "@lando/lando3" as const;

export { LANDO3_TRANSLATOR_ID };
export type { Lando3TranslatorPorts };

type Lando3PortsProvider =
  | Lando3TranslatorPorts
  | (() => Lando3TranslatorPorts | Promise<Lando3TranslatorPorts>);

export const lando3LeftoversCheck: PluginDoctorCheckContribution = {
  id: "lando3-leftovers",
  run: (input) =>
    Effect.promise(() => import("./doctor.ts")).pipe(
      Effect.flatMap(({ runLando3Leftovers }) => runLando3Leftovers(input)),
    ),
};

export const lando3ShadowCheck: PluginDoctorCheckContribution = {
  id: "lando3-shadow",
  run: (input) =>
    Effect.promise(() => import("./doctor.ts")).pipe(
      Effect.flatMap(({ runLando3Shadow }) => runLando3Shadow(input)),
    ),
};

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
export const makeLando3Plugin = (ports?: Lando3PortsProvider): LandoPluginModule =>
  definePlugin({
    name: manifest.name,
    manifest,
    configTranslators: makeConfigTranslators(ports),
    doctorChecks: [lando3LeftoversCheck, lando3ShadowCheck],
  });

export const makeConfigTranslators = (
  ports?: Lando3PortsProvider,
): ReadonlyMap<string, ConfigTranslatorLoader> =>
  new Map([
    [
      LANDO3_TRANSLATOR_ID,
      () =>
        import("./translator.ts").then(async ({ makeLando3ConfigTranslator, defaultLando3Ports }) =>
          makeLando3ConfigTranslator(
            typeof ports === "function" ? await ports() : (ports ?? defaultLando3Ports()),
          ),
        ),
    ],
  ]);

export const configTranslators: ReadonlyMap<string, ConfigTranslatorLoader> = makeConfigTranslators();

export const plugin = makeLando3Plugin();
