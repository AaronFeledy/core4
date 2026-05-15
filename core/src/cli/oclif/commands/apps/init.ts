/**
 * `lando apps:init` — interactive scaffolding for new Lando apps.
 *
 * **Interactive only** — not exported as a function from
 * `@lando/core/cli`; embedding hosts drive `InitSource` directly if needed.
 */
import { Flags } from "@oclif/core";
import { Effect } from "effect";

import { InitTargetExistsError } from "@lando/sdk/errors";

import { type InitAppResult, initApp } from "../../../commands/init.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

interface InitFlags {
  readonly full: boolean;
  readonly name?: string;
}

export const initSpec: LandoCommandSpec<never> = {
  id: "apps:init",
  summary: "Generate a new Lando app.",
  namespace: "apps",
  topLevelAlias: true,
  bootstrap: "commands",
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
    const { flags } = (await this.parse(InitCommand)) as { readonly flags: InitFlags };
    let result: InitAppResult;
    try {
      result =
        flags.name === undefined
          ? await initApp({ cwd: process.cwd(), full: flags.full })
          : await initApp({ cwd: process.cwd(), full: flags.full, name: flags.name });
    } catch (error) {
      if (error instanceof InitTargetExistsError) {
        throw new Error(`${error.message}\n${error.remediation}`);
      }
      throw error;
    }
    this.log(`Created ${result.appName} at ${result.directory}`);
  }
}
