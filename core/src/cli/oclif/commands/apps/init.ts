/**
 * `lando apps:init` — interactive scaffolding for new Lando apps.
 *
 * **Interactive only** — not exported as a function from
 * `@lando/core/cli`; embedding hosts drive `InitSource` directly if needed.
 */
import { Flags } from "@oclif/core";
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const initSpec: LandoCommandSpec<never> = {
  id: "apps:init",
  summary: "Generate a new Lando app.",
  namespace: "apps",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: () => Effect.die("not yet implemented: apps:init"),
};

export default class InitCommand extends LandoCommandBase {
  static override description = initSpec.summary;
  static override aliases = [...resolveTopLevelAliases(initSpec)];
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
  static override landoSpec: LandoCommandSpec = initSpec;
  static override bootstrap = initSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(initSpec);
  }
}
