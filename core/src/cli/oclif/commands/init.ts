/**
 * `lando init` — interactive scaffolding for new Lando apps.
 *
 * **Interactive only** — not exported as a function from
 * `@lando/core/cli`; embedding hosts drive `InitSource` directly if needed.
 */
import { Command, Flags } from "@oclif/core";

export default class InitCommand extends Command {
  static override description = "Initialize a new Lando app from a recipe or source.";
  static override flags = {
    name: Flags.string({ description: "App name (slugified for the project id)." }),
    source: Flags.string({ description: "Init source id (cwd, git, tarball, template)." }),
    recipe: Flags.string({ description: "Recipe to apply." }),
    destination: Flags.string({ description: "Target directory." }),
    full: Flags.boolean({ description: "Use full recipe defaults instead of prompts." }),
    yes: Flags.boolean({ description: "Skip confirmation prompts.", default: false }),
    option: Flags.string({
      description: "Recipe option in key=value form (repeatable).",
      multiple: true,
    }),
  };

  override async run(): Promise<void> {
    throw new Error("lando init: not yet implemented");
  }
}
