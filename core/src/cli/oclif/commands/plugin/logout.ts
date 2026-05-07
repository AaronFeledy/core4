/**
 * `lando plugin:logout` — clear registry auth.
 */
import { Command, Flags } from "@oclif/core";

export default class PluginLogoutCommand extends Command {
  static override description = "Sign out of a private plugin registry.";
  static override flags = {
    registry: Flags.string({ description: "Registry URL." }),
  };

  override async run(): Promise<void> {
    throw new Error("lando plugin:logout: not yet implemented");
  }
}
