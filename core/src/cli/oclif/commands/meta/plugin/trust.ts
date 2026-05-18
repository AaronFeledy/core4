/**
 * `lando meta:plugin:trust` — manage in-memory plugin trust (Alpha) /
 * persistent trust store (Beta).
 *
 * Deferred surface: Alpha exposes the structured remediation via the
 * generic non-MVP guard so users see the planned Beta behavior without
 * the command silently exiting 0.
 */
import { Args } from "@oclif/core";
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const pluginTrustSpec: LandoCommandSpec<never> = {
  id: "meta:plugin:trust",
  summary: "Trust an installed plugin (persistent trust deferred to Beta).",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: meta:plugin:trust"),
};

export default class PluginTrustCommand extends LandoCommandBase {
  static override description = pluginTrustSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pluginTrustSpec)];
  static override args = {
    name: Args.string({ description: "Plugin name.", required: true }),
  };
  static override landoSpec: LandoCommandSpec = pluginTrustSpec;
  static override bootstrap = pluginTrustSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pluginTrustSpec);
  }
}
