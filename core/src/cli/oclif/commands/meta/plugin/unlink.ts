import { Args } from "@oclif/core";
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const pluginUnlinkSpec: LandoCommandSpec<never> = {
  id: "meta:plugin:unlink",
  summary: "Remove a previously linked plugin (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "plugins",
  run: () => Effect.die("not yet implemented: meta:plugin:unlink"),
};

export default class PluginUnlinkCommand extends LandoCommandBase {
  static override description = pluginUnlinkSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginUnlinkSpec)];
  static override args = {
    name: Args.string({ description: "Plugin name.", required: true }),
  };
  static override landoSpec: LandoCommandSpec = pluginUnlinkSpec;
  static override bootstrap = pluginUnlinkSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginUnlinkSpec);
  }
}
