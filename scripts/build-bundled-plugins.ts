#!/usr/bin/env bun
/**
 * Regenerate `core/src/plugins/bundled.ts` from `core/build.config.ts`.
 *
 * Inputs:
 *   - `plugins/` workspace
 *   - `core/build.config.ts` (the "ship list")
 *
 * Output:
 *   - `core/src/plugins/bundled.ts` — a static `import` graph the compiled
 *     binary can use without dynamic `import()`.
 *
 * Drift gate: `bun run build:check` re-runs this generator and
 * `git diff --exit-code` fails if the output drifts.
 */
import { resolve } from "node:path";

import { buildConfig } from "../core/build.config.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "core/src/plugins/bundled.ts");

const HEADER = `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`bun run scripts/build-bundled-plugins.ts\`.
 *
 * Source of truth: \`core/build.config.ts\` (the "ship list").
 *
 * The default Lando v4 binary is built with \`bun build --compile\`.
 * Compiled binaries cannot dynamically \`import()\` arbitrary files at
 * runtime, so bundled plugins are statically imported here. Library consumers
 * do not receive bundled plugins by default — they must opt into bundled
 * discovery or contribute their own Layers.
 */
`;

const renderModuleBody = (entries: typeof buildConfig.bundledPlugins): string => {
  if (entries.length === 0) {
    return [
      'import type { Layer } from "effect";',
      "",
      'import type { PluginManifest } from "@lando/sdk/schema";',
      "",
      "export const BUNDLED_PLUGINS: ReadonlyArray<{",
      "  readonly name: string;",
      "  readonly layer: Layer.Layer<never, never, never>;",
      "  readonly manifest: PluginManifest;",
      "}> = [];",
      "",
    ].join("\n");
  }

  const imports: Array<string> = [
    'import { Layer } from "effect";',
    'import { Schema } from "effect";',
    "",
    'import { type PluginManifest, PluginManifest as PluginManifestSchema } from "@lando/sdk/schema";',
    'import type { ServiceTypeShape } from "@lando/sdk/services";',
    "",
  ];
  const pluginImports: Array<{ readonly name: string; readonly statement: string }> = [];
  const tableRows: Array<string> = [];

  entries.forEach((entry, index) => {
    const moduleName = `plugin${index}`;
    pluginImports.push({ name: entry.name, statement: `import * as ${moduleName} from "${entry.name}";` });
    const contributes =
      entry.contributes === undefined
        ? "undefined"
        : `{ ${Object.entries(entry.contributes)
            .map(([key, value]) => `${key}: ${JSON.stringify(value).replaceAll('","', '", "')}`)
            .join(", ")} }`;
    tableRows.push(
      [
        "  {",
        `    name: "${entry.name}",`,
        `    layer: layerFrom({ ...${moduleName} }),`,
        `    manifest: makeManifest("${entry.name}", ${contributes}),`,
        `    ...serviceTypesFrom({ ...${moduleName} }),`,
        "  },",
      ].join("\n"),
    );
  });

  return [
    [
      ...imports,
      ...pluginImports
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => entry.statement),
    ].join("\n"),
    'const makeManifest = (name: string, contributes?: PluginManifest["contributes"]): PluginManifest =>',
    "  Schema.decodeSync(PluginManifestSchema)({",
    "    name,",
    '    version: "0.0.0",',
    "    api: 4,",
    "    bundled: true,",
    "    ...(contributes === undefined ? {} : { contributes }),",
    "  });",
    "",
    "interface BundledPluginModule {",
    "  readonly [key: string]: unknown;",
    "}",
    "",
    "type BundledLayer = Layer.Layer<unknown, unknown, unknown> | Layer.Layer<never, never, never>;",
    "",
    "const isBundledLayer = (value: unknown): value is BundledLayer => Layer.isLayer(value);",
    "",
    "const layerFrom = (module: BundledPluginModule): BundledLayer => {",
    "  if (isBundledLayer(module.provider)) return module.provider;",
    "  if (isBundledLayer(module.services)) return module.services;",
    "  if (isBundledLayer(module.logger)) return module.logger;",
    "  return Layer.empty;",
    "};",
    "",
    "const isServiceTypeShape = (value: unknown): value is ServiceTypeShape =>",
    '  typeof value === "object" &&',
    "  value !== null &&",
    '  "id" in value &&',
    '  typeof value.id === "string" &&',
    '  "toServicePlan" in value &&',
    '  typeof value.toServicePlan === "function";',
    "",
    "const isServiceTypeMap = (value: unknown): value is ReadonlyMap<string, ServiceTypeShape> =>",
    "  value instanceof Map && [...value.values()].every(isServiceTypeShape);",
    "",
    "const serviceTypesFrom = (",
    "  module: BundledPluginModule,",
    "): { readonly serviceTypes?: ReadonlyMap<string, ServiceTypeShape> } =>",
    "  isServiceTypeMap(module.serviceTypes) ? { serviceTypes: module.serviceTypes } : {};",
    "",
    "export const BUNDLED_PLUGINS: ReadonlyArray<{",
    "  readonly name: string;",
    "  readonly layer: BundledLayer;",
    "  readonly manifest: PluginManifest;",
    "  readonly serviceTypes?: ReadonlyMap<string, ServiceTypeShape>;",
    "}> = [",
    tableRows.join("\n"),
    "];",
    "",
  ].join("\n");
};

const main = async (): Promise<void> => {
  const body = renderModuleBody(buildConfig.bundledPlugins);
  const out = `${HEADER}\n${body}`;

  await Bun.write(OUTPUT, out);
  console.log(`[build-bundled-plugins] wrote ${OUTPUT} (${buildConfig.bundledPlugins.length} entries)`);
};

await main();
