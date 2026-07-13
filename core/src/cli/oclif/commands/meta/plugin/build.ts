import {
  type PluginBuildResult,
  PluginBuildResultSchema,
  pluginBuild,
  renderPluginBuildResult,
} from "../../../../commands/plugin-build.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

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

export default class PluginBuildCommand extends LandoCommandBase {
  static override description = pluginBuildSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginBuildSpec)];
  static override landoSpec: LandoCommandSpec = pluginBuildSpec;
  static override bootstrap = pluginBuildSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginBuildSpec);
  }
}
