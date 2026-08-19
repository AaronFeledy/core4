import {
  type PluginBuildResult,
  PluginBuildResultSchema,
  pluginBuild,
  renderPluginBuildResult,
} from "../../../commands/plugin-build";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const pluginBuildSpec: LandoCommandSpec<PluginBuildResult> = {
  resultSchema: PluginBuildResultSchema,
  id: "meta:plugin:build",
  summary: "Build the current plugin source (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: () => pluginBuild(),
  successExitCode: (result) => (result.exitCode === 0 ? undefined : result.exitCode),
  render: (result) => renderPluginBuildResult(result as PluginBuildResult),
};
