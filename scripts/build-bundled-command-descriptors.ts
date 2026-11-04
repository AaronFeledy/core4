import { resolve } from "node:path";
import { Effect } from "effect";
import { loadPluginSpec } from "../core/src/cli/event-command-target.ts";
import { pluginFlagDefinitions } from "../core/src/cli/plugin-flag-definitions.ts";
import { BUNDLED_PLUGIN_MODULES } from "../core/src/plugins/generated/bundled.ts";
import { writeFormattedOutput } from "./_codegen-output.ts";

const output = resolve(import.meta.dirname, "../core/src/cli/generated/bundled-command-descriptors.ts");
const main = async () => {
  const commands = [];
  for (const plugin of BUNDLED_PLUGIN_MODULES) {
    for (const descriptor of plugin.manifest.contributes?.commands ?? []) {
      const load = plugin.commands?.get(descriptor.id);
      if (load === undefined) throw new Error(`Missing bundled loader ${descriptor.id}`);
      const spec = await Effect.runPromise(loadPluginSpec(descriptor.id, plugin.name, load, descriptor));
      commands.push({
        ...descriptor,
        pluginName: plugin.name,
        source: "bundled",
        flags: pluginFlagDefinitions(spec),
        args: spec.args ?? {},
      });
    }
  }
  await writeFormattedOutput(
    output,
    [
      "/**\n * **GENERATED FILE** — do not edit by hand.\n *\n * Regenerate via `bun run codegen:bundled-command-descriptors`.\n */",
      "",
      'import type { PluginManifest, CommandContribution } from "@lando/sdk/schema";',
      'import type { ExecutableCommandArgSpec } from "@lando/sdk/plugins";',
      'import type { OclifFlagDefinition } from "../compiled-argv";',
      'export interface BundledCommandDescriptor extends CommandContribution { readonly pluginName: string; readonly source: "bundled"; readonly flags: Readonly<Record<string, OclifFlagDefinition & { readonly default?: string | number | boolean }>>; readonly args: Readonly<Record<string, ExecutableCommandArgSpec>>; }',
      `export const BUNDLED_COMMAND_DESCRIPTORS: readonly BundledCommandDescriptor[] = ${JSON.stringify(commands)};`,
      `export const BUNDLED_PLUGIN_MANIFESTS: readonly (typeof PluginManifest.Encoded)[] = ${JSON.stringify(BUNDLED_PLUGIN_MODULES.map((plugin) => plugin.manifest))};`,
    ].join("\n"),
  );
};
if (import.meta.main) await main();
