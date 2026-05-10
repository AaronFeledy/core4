/**
 * `lando meta:plugin:add` — install a plugin via Bun.
 *
 * Resolves the plugin spec through the active `PluginSource` adapter
 * chain, validates the manifest against the Effect Schema, resolves
 * dependency + API compatibility, installs via
 * `Bun.spawn('bun', ['install', ...])`, and refreshes the OCLIF + Lando
 * plugin caches.
 *
 * Bootstrap: `plugins`.
 */
import { Args, Flags } from "@oclif/core";
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const pluginAddSpec: LandoCommandSpec<never> = {
  id: "meta:plugin:add",
  summary: "Install a plugin.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "plugins",
  run: () => Effect.die("not yet implemented: meta:plugin:add"),
};

export default class PluginAddCommand extends LandoCommandBase {
  static override description = "Install a Lando plugin (uses Bun under the hood).";
  static override aliases = [...resolveTopLevelAliases(pluginAddSpec)];
  static override args = {
    spec: Args.string({
      description: "Plugin spec (registry name, git URL, tarball URL, or file: path).",
      required: true,
    }),
  };
  static override flags = {
    force: Flags.boolean({ description: "Re-install even if already present.", default: false }),
  };
  static override landoSpec: LandoCommandSpec = pluginAddSpec;

  override async run(): Promise<void> {
    await this.runEffect(pluginAddSpec);
  }
}
