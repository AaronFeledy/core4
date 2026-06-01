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
import { writeFormattedOutput } from "./_codegen-output.ts";

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
    'import { Effect, type Layer } from "effect";',
    "",
    'import type { PluginManifest, ServiceConfig } from "@lando/sdk/schema";',
    'import type { ServiceTypeShape } from "@lando/sdk/services";',
    "",
  ];
  const pluginImports: Array<{ readonly name: string; readonly statement: string }> = [];
  const tableRows: Array<string> = [];

  entries.forEach((entry, index) => {
    const moduleName = `plugin${index}`;
    pluginImports.push({ name: entry.name, statement: `import * as ${moduleName} from "${entry.name}";` });
    const layerExport = layerExportFor(entry);
    tableRows.push(
      [
        "  {",
        `    name: "${entry.name}",`,
        `    layer: ${moduleName}.${layerExport},`,
        `    manifest: ${moduleName}.manifest,`,
        `    ...serviceTypesFrom({ ...${moduleName} }),`,
        `    ...globalServicesFrom({ ...${moduleName} }),`,
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
    "interface BundledPluginModule {",
    "  readonly [key: string]: unknown;",
    "}",
    "",
    "type BundledLayer = Layer.Layer<never, unknown, unknown>;",
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
    "type GlobalServiceEffect = Effect.Effect<ServiceConfig, unknown, never>;",
    "",
    "const isGlobalServiceMap = (value: unknown): value is ReadonlyMap<string, GlobalServiceEffect> =>",
    "  value instanceof Map && [...value.values()].every((entry) => Effect.isEffect(entry));",
    "",
    "const globalServicesFrom = (",
    "  module: BundledPluginModule,",
    "): { readonly globalServices?: ReadonlyMap<string, GlobalServiceEffect> } =>",
    "  isGlobalServiceMap(module.globalServices) ? { globalServices: module.globalServices } : {};",
    "",
    "export const BUNDLED_PLUGINS: ReadonlyArray<{",
    "  readonly name: string;",
    "  readonly layer: BundledLayer;",
    "  readonly manifest: PluginManifest;",
    "  readonly serviceTypes?: ReadonlyMap<string, ServiceTypeShape>;",
    "  readonly globalServices?: ReadonlyMap<string, GlobalServiceEffect>;",
    "}> = [",
    tableRows.join("\n"),
    "];",
    "",
  ].join("\n");
};

const layerExportFor = (
  entry: (typeof buildConfig.bundledPlugins)[number],
): "provider" | "services" | "logger" | "engine" | "proxy" => {
  if (entry.contributes?.providers !== undefined) return "provider";
  if (entry.contributes?.serviceTypes !== undefined) return "services";
  if (entry.contributes?.loggers !== undefined) return "logger";
  if (entry.contributes?.fileSyncEngines !== undefined) return "engine";
  if (entry.contributes?.proxies !== undefined) return "proxy";

  throw new Error(`Bundled plugin ${entry.name} does not declare a supported layer contribution.`);
};

const main = async (): Promise<void> => {
  const body = renderModuleBody(buildConfig.bundledPlugins);
  const out = `${HEADER}\n${body}`;

  await writeFormattedOutput(OUTPUT, out);
  console.log(`[build-bundled-plugins] wrote ${OUTPUT} (${buildConfig.bundledPlugins.length} entries)`);
};

await main();
