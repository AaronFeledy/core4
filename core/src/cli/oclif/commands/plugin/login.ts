/**
 * `lando plugin:login` — write registry auth.
 *
 * `lando plugin:login` / `lando plugin:logout` write to
 * `<userConfRoot>/plugin-auth.json` and are consumed by the registry
 * plugin source for private packages.
 */
import { Command, Flags } from "@oclif/core";

export default class PluginLoginCommand extends Command {
  static override description = "Authenticate with a private plugin registry.";
  static override flags = {
    registry: Flags.string({ description: "Registry URL.", required: true }),
  };

  override async run(): Promise<void> {
    throw new Error("lando plugin:login: not yet implemented");
  }
}
