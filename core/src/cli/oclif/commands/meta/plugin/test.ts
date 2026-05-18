/**
 * `lando meta:plugin:test` — run the current plugin's test suite
 * (authoring command, deferred to Beta).
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const pluginTestSpec: LandoCommandSpec<never> = {
  id: "meta:plugin:test",
  summary: "Run the current plugin's tests (authoring command).",
  namespace: "meta",
  topLevelAlias: false,
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: meta:plugin:test"),
};

export default class PluginTestCommand extends LandoCommandBase {
  static override description = pluginTestSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginTestSpec)];
  static override landoSpec: LandoCommandSpec = pluginTestSpec;
  static override bootstrap = pluginTestSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginTestSpec);
  }
}
