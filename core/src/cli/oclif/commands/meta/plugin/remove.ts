/**
 * `lando meta:plugin:remove` — uninstall a plugin.
 */
import { Args } from "@oclif/core";
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const pluginRemoveSpec: LandoCommandSpec<never> = {
  id: "meta:plugin:remove",
  summary: "Remove a plugin.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "plugins",
  run: () => Effect.die("not yet implemented: meta:plugin:remove"),
};

export default class PluginRemoveCommand extends LandoCommandBase {
  static override description = "Remove an installed Lando plugin.";
  static override aliases = [...resolveTopLevelAliases(pluginRemoveSpec)];
  static override args = {
    name: Args.string({ description: "Plugin name.", required: true }),
  };
  static override landoSpec: LandoCommandSpec = pluginRemoveSpec;
  static override bootstrap = pluginRemoveSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginRemoveSpec);
  }
}
