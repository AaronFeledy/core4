import { Effect } from "effect";

import {
  type PluginTestResult,
  PluginTestResultSchema,
  pluginTest,
  renderPluginTestResult,
} from "../../../../commands/plugin-test.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

const extractArgv = (input: unknown): ReadonlyArray<string> => {
  if (typeof input !== "object" || input === null || !("argv" in input)) return [];
  const argv = (input as { readonly argv: unknown }).argv;
  return Array.isArray(argv) ? argv.filter((entry): entry is string => typeof entry === "string") : [];
};

export const pluginTestSpec: LandoCommandSpec<PluginTestResult> = {
  resultSchema: PluginTestResultSchema,
  id: "meta:plugin:test",
  summary: "Run the current plugin's Bun test suite (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: (input) =>
    pluginTest({ argv: extractArgv(input) }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.exitCode !== 0) process.exitCode = result.exitCode;
        }),
      ),
    ),
  render: (result) => renderPluginTestResult(result as PluginTestResult),
};

export default class PluginTestCommand extends LandoCommandBase {
  static override description = pluginTestSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginTestSpec)];
  static override strict = false;
  static override landoSpec: LandoCommandSpec = pluginTestSpec;
  static override bootstrap = pluginTestSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginTestSpec);
  }
}
