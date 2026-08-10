import { Effect } from "effect";
/**
 * `lando meta:plugin:logout` — clear registry auth.
 */
import { Flags } from "../../../spec/metadata";

import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../../spec/command-base";

export const pluginLogoutSpec: LandoCommandSpec<never> = {
  resultSchema: EmptyResultSchema,
  id: "meta:plugin:logout",
  summary: "Forget plugin source authentication.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  deferred: {
    phase: "4.1",
    summary: "Plugin registry login/logout are not available yet.",
    remediation: "Plugin registry login/logout are not available yet.",
  },
  run: () => Effect.die("not yet implemented: meta:plugin:logout"),
};

export default class PluginLogoutCommand extends LandoCommandBase {
  static override description = "Sign out of a private plugin registry.";
  static override aliases = [...resolveTopLevelAliases(pluginLogoutSpec)];
  static override flags = {
    registry: Flags.string({ description: "Registry URL." }),
  };
  static override landoSpec: LandoCommandSpec = pluginLogoutSpec;
  static override bootstrap = pluginLogoutSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginLogoutSpec);
  }
}
