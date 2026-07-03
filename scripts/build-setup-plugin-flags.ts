#!/usr/bin/env bun
/**
 * Regenerate `core/src/cli/oclif/generated/setup-plugin-flags.ts` from the
 * bundled plugins' `contributes.setup.flags`.
 *
 * Inputs:
 *   - `core/build.config.ts` (the "ship list")
 *   - each bundled plugin's `manifest.contributes.setup.flags`
 *
 * Output:
 *   - `core/src/cli/oclif/generated/setup-plugin-flags.ts` — plain literal
 *     data (no plugin/Effect imports) that the `meta:setup` command merges into
 *     its flag surface. Keeping this a literal-data module means importing it
 *     from the setup command never pulls the bundled plugin Layers (and the
 *     whole compiled CLI command graph) into scope.
 *
 * Drift gate: `bun run codegen` re-runs this generator and
 * `git diff --exit-code` fails if the output drifts.
 */
import { resolve } from "node:path";

import type { PluginManifest, PluginSetupFlagContribution } from "@lando/sdk/schema";

import { buildConfig } from "../core/build.config.ts";
import { writeFormattedOutput } from "./_codegen-output.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "core/src/cli/oclif/generated/setup-plugin-flags.ts");

const HEADER = `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`bun run scripts/build-setup-plugin-flags.ts\`.
 *
 * Source of truth: bundled plugins' \`contributes.setup.flags\` (the ship list in
 * \`core/build.config.ts\`).
 *
 * This is deliberately a literal-data module with no plugin or Effect imports,
 * so the \`meta:setup\` command can merge these contributions into its flag
 * surface without pulling the bundled plugin Layers into the compiled CLI
 * command graph (a cold-start regression).
 */`;

interface Contribution {
  readonly plugin: string;
  readonly providers: ReadonlyArray<string>;
  readonly flag: PluginSetupFlagContribution;
}

const renderFlag = (flag: PluginSetupFlagContribution): string => {
  const parts: string[] = [`name: ${JSON.stringify(flag.name)}`, `type: ${JSON.stringify(flag.type)}`];
  if (flag.description !== undefined) parts.push(`description: ${JSON.stringify(flag.description)}`);
  if (flag.options !== undefined) parts.push(`options: ${JSON.stringify(flag.options)}`);
  if (flag.deprecated !== undefined) parts.push(`deprecated: ${JSON.stringify(flag.deprecated)}`);
  return `{ ${parts.join(", ")} }`;
};

const renderContribution = (contribution: Contribution): string =>
  `  {\n    plugin: ${JSON.stringify(contribution.plugin)},\n    providers: ${JSON.stringify(
    contribution.providers,
  )},\n    flag: ${renderFlag(contribution.flag)},\n  },`;

const renderModule = (contributions: ReadonlyArray<Contribution>): string => {
  const body = contributions.length === 0 ? "" : `\n${contributions.map(renderContribution).join("\n")}\n`;
  return [
    HEADER,
    "",
    'import type { PluginSetupFlagContribution } from "@lando/sdk/schema";',
    "",
    "export interface BundledSetupFlagContribution {",
    "  /** Bundled plugin package that contributes the flag. */",
    "  readonly plugin: string;",
    "  /** Provider ids the contributing plugin registers. */",
    "  readonly providers: ReadonlyArray<string>;",
    "  /** The contributed setup flag. */",
    "  readonly flag: PluginSetupFlagContribution;",
    "}",
    "",
    `export const BUNDLED_SETUP_FLAG_CONTRIBUTIONS: ReadonlyArray<BundledSetupFlagContribution> = [${body}];`,
    "",
  ].join("\n");
};

const main = async (): Promise<void> => {
  const contributions: Contribution[] = [];
  for (const entry of buildConfig.bundledPlugins) {
    const module = (await import(entry.name)) as { readonly manifest?: PluginManifest };
    const manifest = module.manifest;
    if (manifest === undefined) continue;
    const flags = manifest.contributes?.setup?.flags ?? [];
    if (flags.length === 0) continue;
    const providers = manifest.contributes?.providers ?? [];
    for (const flag of flags) {
      contributions.push({ plugin: entry.name, providers: [...providers], flag });
    }
  }

  await writeFormattedOutput(OUTPUT, renderModule(contributions));
  console.log(`[build-setup-plugin-flags] wrote ${OUTPUT} (${contributions.length} contributions)`);
};

await main();
