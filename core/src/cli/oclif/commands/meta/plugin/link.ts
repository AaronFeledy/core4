import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const pluginLinkSpec: LandoCommandSpec<never> = {
  id: "meta:plugin:link",
  summary: "Symlink the current plugin into the user-global plugin store (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "plugins",
  run: () => Effect.die("not yet implemented: meta:plugin:link"),
};

export default class PluginLinkCommand extends LandoCommandBase {
  static override description = pluginLinkSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginLinkSpec)];
  static override landoSpec: LandoCommandSpec = pluginLinkSpec;
  static override bootstrap = pluginLinkSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginLinkSpec);
  }
}
