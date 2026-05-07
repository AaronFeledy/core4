/**
 * `lando plugin:remove` — uninstall a plugin.
 */
import { Args, Command } from "@oclif/core";

export default class PluginRemoveCommand extends Command {
  static override description = "Remove an installed Lando plugin.";
  static override args = {
    name: Args.string({ description: "Plugin name.", required: true }),
  };

  override async run(): Promise<void> {
    throw new Error("lando plugin:remove: not yet implemented");
  }
}
