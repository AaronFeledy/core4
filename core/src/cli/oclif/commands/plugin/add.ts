/**
 * `lando plugin:add` — install a plugin via Bun.
 *
 * Resolves the plugin spec through the active `PluginSource` adapter
 * chain, validates the manifest against the Effect Schema, resolves
 * dependency + API compatibility, installs via
 * `Bun.spawn('bun', ['install', ...])`, and refreshes the OCLIF + Lando
 * plugin caches.
 *
 * Bootstrap: `plugins`.
 */
import { Args, Command, Flags } from "@oclif/core";

export default class PluginAddCommand extends Command {
  static override description = "Install a Lando plugin (uses Bun under the hood).";
  static override args = {
    spec: Args.string({
      description: "Plugin spec (registry name, git URL, tarball URL, or file: path).",
      required: true,
    }),
  };
  static override flags = {
    force: Flags.boolean({ description: "Re-install even if already present.", default: false }),
  };

  override async run(): Promise<void> {
    throw new Error("lando plugin:add: not yet implemented");
  }
}
