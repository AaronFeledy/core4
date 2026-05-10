/**
 * `lando meta:plugin:logout` — clear registry auth.
 */
import { Flags } from "@oclif/core";
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const pluginLogoutSpec: LandoCommandSpec<never> = {
  id: "meta:plugin:logout",
  summary: "Forget plugin source authentication.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: meta:plugin:logout"),
};

export default class PluginLogoutCommand extends LandoCommandBase {
  static override description = "Sign out of a private plugin registry.";
  static override aliases = [...resolveTopLevelAliases(pluginLogoutSpec)];
  static override flags = {
    registry: Flags.string({ description: "Registry URL." }),
  };
  static override landoSpec: LandoCommandSpec = pluginLogoutSpec;

  override async run(): Promise<void> {
    await this.runEffect(pluginLogoutSpec);
  }
}
