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
      'import { Layer } from "effect";',
      'import { Schema } from "effect";',
      "",
      'import { type PluginManifest, PluginManifest as PluginManifestSchema } from "@lando/sdk/schema";',
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
    "",
  ];
  const tableRows: Array<string> = [];

  for (const entry of entries) {
    tableRows.push(
      `  { name: "${entry.name}", layer: Layer.empty, manifest: makeManifest("${entry.name}") },`,
    );
  }

  return [
    imports.join("\n"),
    "const makeManifest = (name: string): PluginManifest =>",
    "  Schema.decodeSync(PluginManifestSchema)({",
    "    name,",
    '    version: "0.0.0",',
    "    api: 4,",
    "    bundled: true,",
    "  });",
    "",
    "export const BUNDLED_PLUGINS: ReadonlyArray<{",
    "  readonly name: string;",
    "  readonly layer: Layer.Layer<never, never, never>;",
    "  readonly manifest: PluginManifest;",
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
