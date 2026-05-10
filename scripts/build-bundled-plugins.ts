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
      "export const BUNDLED_PLUGINS: ReadonlyArray<{",
      "  readonly id: string;",
      "  readonly layer: Layer.Layer<unknown, unknown, never>;",
      "}> = [];",
      "",
    ].join("\n");
  }

  const imports: Array<string> = ['import type { Layer } from "effect";', ""];
  const tableRows: Array<string> = [];

  entries.forEach((entry, idx) => {
    const alias = `plugin${idx}`;
    imports.push(`import ${alias} from "${entry.name}";`);
    tableRows.push(`  { id: "${entry.name}", layer: ${alias} as Layer.Layer<unknown, unknown, never> },`);
  });

  return [
    imports.join("\n"),
    "",
    "export const BUNDLED_PLUGINS: ReadonlyArray<{",
    "  readonly id: string;",
    "  readonly layer: Layer.Layer<unknown, unknown, never>;",
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
