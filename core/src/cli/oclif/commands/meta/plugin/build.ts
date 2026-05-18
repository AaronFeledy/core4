/**
 * `lando meta:plugin:build` — build the current plugin source (authoring
 * command, deferred to Beta).
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const pluginBuildSpec: LandoCommandSpec<never> = {
  id: "meta:plugin:build",
  summary: "Build the current plugin source (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: meta:plugin:build"),
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
