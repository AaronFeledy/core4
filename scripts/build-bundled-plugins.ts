#!/usr/bin/env bun
/**
 * Regenerate bundled plugin descriptor tables from `core/build.config.ts`.
 *
 * Outputs:
 *   - `core/src/plugins/generated/bundled.ts`
 *   - `core/src/plugins/generated/renderers.ts`
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { Schema } from "effect";

import { buildConfig } from "../core/build.config.ts";
import { PluginManifest } from "../sdk/src/schema/index.ts";
import { writeFormattedOutput } from "./_codegen-output.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = resolve(REPO_ROOT, "core/src/plugins/generated");
const BUNDLED_OUTPUT = resolve(OUTPUT_DIR, "bundled.ts");
const RENDERERS_OUTPUT = resolve(OUTPUT_DIR, "renderers.ts");

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

type BundledPluginEntry = (typeof buildConfig.bundledPlugins)[number];

const renderDescriptorTable = (
  entries: ReadonlyArray<BundledPluginEntry>,
  exportName: "BUNDLED_PLUGIN_MODULES" | "BUNDLED_RENDERER_MODULES",
): string => {
  const imports = entries.map((entry, index) => `import { plugin as plugin${index} } from "${entry.name}";`);
  const descriptors = entries.map((_entry, index) => `  plugin${index},`);

  return `${HEADER}
import type { LandoPluginModule } from "@lando/sdk/plugins";

${imports.join("\n")}

export const ${exportName}: ReadonlyArray<LandoPluginModule> = [
${descriptors.join("\n")}
];
`;
};

const readsManifest = async (entry: BundledPluginEntry): Promise<PluginManifest> => {
  const loaded: unknown = await import(entry.name);
  return Schema.decodeUnknownSync(Schema.Struct({ manifest: PluginManifest }))(loaded).manifest;
};

const main = async (): Promise<void> => {
  const entries = buildConfig.bundledPlugins;
  const manifests = await Promise.all(entries.map(readsManifest));
  const rendererEntries = entries.filter(
    (_entry, index) => manifests[index]?.contributes?.renderers !== undefined,
  );

  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFormattedOutput(BUNDLED_OUTPUT, renderDescriptorTable(entries, "BUNDLED_PLUGIN_MODULES")),
    writeFormattedOutput(
      RENDERERS_OUTPUT,
      renderDescriptorTable(rendererEntries, "BUNDLED_RENDERER_MODULES"),
    ),
  ]);
  console.log(
    `[build-bundled-plugins] wrote ${BUNDLED_OUTPUT} (${entries.length} entries) and ${RENDERERS_OUTPUT} (${rendererEntries.length} entries)`,
  );
};

await main();
