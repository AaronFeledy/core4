/**
 * `lando meta:plugin:new` — scaffold a new plugin (authoring command,
 * deferred to Beta).
 */
import { Args } from "@oclif/core";
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const pluginNewSpec: LandoCommandSpec<never> = {
  id: "meta:plugin:new",
  summary: "Scaffold a new plugin from a built-in template (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: meta:plugin:new"),
};

export default class PluginNewCommand extends LandoCommandBase {
  static override description = pluginNewSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginNewSpec)];
  static override args = {
    name: Args.string({ description: "New plugin name.", required: true }),
  };
  static override landoSpec: LandoCommandSpec = pluginNewSpec;
  static override bootstrap = pluginNewSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginNewSpec);
  }
}
