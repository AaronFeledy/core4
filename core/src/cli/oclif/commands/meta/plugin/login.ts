import { Effect } from "effect";
/**
 * `lando meta:plugin:login` — write registry auth.
 *
 * `lando plugin:login` / `lando plugin:logout` write to
 * `<userConfRoot>/plugin-auth.json` and are consumed by the registry
 * plugin source for private packages.
 */
import { Flags } from "../../../metadata";

import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../../command-base";

export const pluginLoginSpec: LandoCommandSpec<never> = {
  resultSchema: EmptyResultSchema,
  id: "meta:plugin:login",
  summary: "Authenticate with a plugin source.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  deferred: {
    phase: "4.1",
    summary: "Plugin registry login/logout are not available yet.",
    remediation: "Plugin registry login/logout are not available yet.",
  },
  run: () => Effect.die("not yet implemented: meta:plugin:login"),
};

export default class PluginLoginCommand extends LandoCommandBase {
  static override description = "Authenticate with a private plugin registry.";
  static override aliases = [...resolveTopLevelAliases(pluginLoginSpec)];
  static override flags = {
    registry: Flags.string({ description: "Registry URL.", required: true }),
  };
  static override landoSpec: LandoCommandSpec = pluginLoginSpec;
  static override bootstrap = pluginLoginSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginLoginSpec);
  }
}
