import { Effect } from "effect";

import {
  type PluginBuildResult,
  pluginBuild,
  renderPluginBuildResult,
} from "../../../../commands/plugin-build.ts";
import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../../command-base.ts";

export const pluginBuildSpec: LandoCommandSpec<PluginBuildResult> = {
  resultSchema: EmptyResultSchema,
  id: "meta:plugin:build",
  summary: "Build the current plugin source (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: () =>
    pluginBuild().pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.exitCode !== 0) process.exitCode = result.exitCode;
        }),
      ),
    ),
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
