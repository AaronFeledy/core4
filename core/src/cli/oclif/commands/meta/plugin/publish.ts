import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const pluginPublishSpec: LandoCommandSpec<never> = {
  id: "meta:plugin:publish",
  summary: "Publish the current plugin (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: meta:plugin:publish"),
};

export default class PluginPublishCommand extends LandoCommandBase {
  static override description = pluginPublishSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginPublishSpec)];
  static override landoSpec: LandoCommandSpec = pluginPublishSpec;
  static override bootstrap = pluginPublishSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginPublishSpec);
  }
}
