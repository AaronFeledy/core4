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

  // Renderer plugins own their default renderer as a `RendererContribution`
  // (resolved via the bundled-renderer registry), not as a runtime `Layer`, so
  // their bundled-table `layer` slot carries `Layer.empty`. That requires a
  // value import of `Layer`.
  const usesLayerValue = entries.some((entry) => entry.contributes?.renderers !== undefined);
  const imports: Array<string> = [
    usesLayerValue
      ? 'import { Effect, Layer } from "effect";'
      : 'import { Effect, type Layer } from "effect";',
    "",
    'import type { PluginManifest, ServiceConfig } from "@lando/sdk/schema";',
    'import type { AppFeatureDefinition, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";',
    'import type { TemplateEngine } from "@lando/sdk/template";',
    "",
  ];
  const pluginImports: Array<{ readonly name: string; readonly statement: string }> = [];
  const tableRows: Array<string> = [];

  entries.forEach((entry, index) => {
    const moduleName = `plugin${index}`;
    pluginImports.push({ name: entry.name, statement: `import * as ${moduleName} from "${entry.name}";` });
    const layerValue =
      entry.contributes?.renderers !== undefined ? "Layer.empty" : `${moduleName}.${layerExportFor(entry)}`;
    tableRows.push(
      [
        "  {",
        `    name: "${entry.name}",`,
        `    layer: ${layerValue},`,
        `    manifest: ${moduleName}.manifest,`,
        `    ...serviceTypesFrom({ ...${moduleName} }),`,
        `    ...serviceFeaturesFrom({ ...${moduleName} }),`,
        `    ...appFeaturesFrom({ ...${moduleName} }),`,
        `    ...globalServicesFrom({ ...${moduleName} }),`,
        `    ...templateEnginesFrom({ ...${moduleName} }),`,
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
    "const isServiceType = (value: unknown): value is ServiceType =>",
    '  typeof value === "object" &&',
    "  value !== null &&",
    '  "id" in value &&',
    '  typeof value.id === "string" &&',
    '  "resolve" in value &&',
    '  typeof value.resolve === "function";',
    "",
    "const isServiceTypeMap = (value: unknown): value is ReadonlyMap<string, ServiceType> =>",
    "  value instanceof Map && [...value.values()].every(isServiceType);",
    "",
    "const serviceTypesFrom = (",
    "  module: BundledPluginModule,",
    "): { readonly serviceTypes?: ReadonlyMap<string, ServiceType> } =>",
    "  isServiceTypeMap(module.serviceTypes) ? { serviceTypes: module.serviceTypes } : {};",
    "",
    "const isServiceFeature = (value: unknown): value is ServiceFeatureDefinition =>",
    '  typeof value === "object" &&',
    "  value !== null &&",
    '  "id" in value &&',
    '  typeof value.id === "string" &&',
    '  "priority" in value &&',
    '  typeof value.priority === "number" &&',
    '  "apply" in value &&',
    '  typeof value.apply === "function";',
    "",
    "const isServiceFeatureMap = (value: unknown): value is ReadonlyMap<string, ServiceFeatureDefinition> =>",
    "  value instanceof Map && [...value.values()].every(isServiceFeature);",
    "",
    "const serviceFeaturesFrom = (",
    "  module: BundledPluginModule,",
    "): { readonly serviceFeatures?: ReadonlyMap<string, ServiceFeatureDefinition> } =>",
    "  isServiceFeatureMap(module.serviceFeatures) ? { serviceFeatures: module.serviceFeatures } : {};",
    "",
    "const isAppFeature = (value: unknown): value is AppFeatureDefinition =>",
    '  typeof value === "object" &&',
    "  value !== null &&",
    '  "id" in value &&',
    '  typeof value.id === "string" &&',
    '  "priority" in value &&',
    '  typeof value.priority === "number" &&',
    '  "apply" in value &&',
    '  typeof value.apply === "function";',
    "",
    "const isAppFeatureMap = (value: unknown): value is ReadonlyMap<string, AppFeatureDefinition> =>",
    "  value instanceof Map && [...value.values()].every(isAppFeature);",
    "",
    "const appFeaturesFrom = (",
    "  module: BundledPluginModule,",
    "): { readonly appFeatures?: ReadonlyMap<string, AppFeatureDefinition> } =>",
    "  isAppFeatureMap(module.appFeatures) ? { appFeatures: module.appFeatures } : {};",
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
    "const isTemplateEngine = (value: unknown): value is TemplateEngine =>",
    '  typeof value === "object" &&',
    "  value !== null &&",
    '  "id" in value &&',
    '  typeof value.id === "string" &&',
    '  "compile" in value &&',
    '  typeof value.compile === "function" &&',
    '  "render" in value &&',
    '  typeof value.render === "function";',
    "",
    "const isTemplateEngineMap = (value: unknown): value is ReadonlyMap<string, TemplateEngine> =>",
    "  value instanceof Map && [...value.values()].every(isTemplateEngine);",
    "",
    "const templateEnginesFrom = (",
    "  module: BundledPluginModule,",
    "): { readonly templateEngines?: ReadonlyMap<string, TemplateEngine> } =>",
    "  isTemplateEngineMap(module.templateEngines) ? { templateEngines: module.templateEngines } : {};",
    "",
    "export const BUNDLED_PLUGINS: ReadonlyArray<{",
    "  readonly name: string;",
    "  readonly layer: BundledLayer;",
    "  readonly manifest: PluginManifest;",
    "  readonly serviceTypes?: ReadonlyMap<string, ServiceType>;",
    "  readonly serviceFeatures?: ReadonlyMap<string, ServiceFeatureDefinition>;",
    "  readonly appFeatures?: ReadonlyMap<string, AppFeatureDefinition>;",
    "  readonly globalServices?: ReadonlyMap<string, GlobalServiceEffect>;",
    "  readonly templateEngines?: ReadonlyMap<string, TemplateEngine>;",
    "}> = [",
    tableRows.join("\n"),
    "];",
    "",
  ].join("\n");
};

const layerExportFor = (
  entry: (typeof buildConfig.bundledPlugins)[number],
): "provider" | "services" | "logger" | "renderer" | "engine" | "proxy" | "templateEngine" => {
  if (entry.contributes?.providers !== undefined) return "provider";
  if (entry.contributes?.serviceTypes !== undefined) return "services";
  if (entry.contributes?.loggers !== undefined) return "logger";
  if (entry.contributes?.renderers !== undefined) return "renderer";
  if (entry.contributes?.fileSyncEngines !== undefined) return "engine";
  if (entry.contributes?.proxies !== undefined) return "proxy";
  if (entry.contributes?.templateEngines !== undefined) return "templateEngine";

  throw new Error(`Bundled plugin ${entry.name} does not declare a supported layer contribution.`);
};

const main = async (): Promise<void> => {
  const body = renderModuleBody(buildConfig.bundledPlugins);
  const out = `${HEADER}\n${body}`;

  await writeFormattedOutput(OUTPUT, out);
  console.log(`[build-bundled-plugins] wrote ${OUTPUT} (${buildConfig.bundledPlugins.length} entries)`);
};

await main();
