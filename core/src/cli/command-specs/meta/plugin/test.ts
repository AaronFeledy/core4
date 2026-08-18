import {
  type PluginTestResult,
  PluginTestResultSchema,
  pluginTest,
  renderPluginTestResult,
} from "../../../commands/plugin-test";
import type { LandoCommandSpec } from "../../../spec/command-base";

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
  strict: false,
  run: (input) => pluginTest({ argv: extractArgv(input) }),
  successExitCode: (result) => (result.exitCode === 0 ? undefined : result.exitCode),
  render: (result) => renderPluginTestResult(result as PluginTestResult),
};
