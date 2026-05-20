/**
 * `lando apps:init` — interactive scaffolding for new Lando apps.
 *
 * **Interactive only** — not exported as a function from
 * `@lando/core/cli`; embedding hosts drive `InitSource` directly if needed.
 */
import { Flags } from "@oclif/core";
import { Effect } from "effect";

import { RendererSelectionError } from "@lando/sdk/errors";

import { parseAnswerFlags } from "../../../../recipes/prompts/index.ts";
import { formatBugReport } from "../../../bug-report.ts";
import { type InitAppOptions, type InitAppResult, initApp } from "../../../commands/init.ts";
import { resolveRendererMode } from "../../../renderer-selection.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

interface InitFlags {
  readonly full: boolean;
  readonly name?: string;
  readonly recipe?: string;
  readonly answer?: ReadonlyArray<string>;
  readonly "no-interactive"?: boolean;
  readonly yes?: boolean;
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
    yes: Flags.boolean({ description: "Accept every prompt's default without asking.", default: false }),
    "no-interactive": Flags.boolean({
      description:
        "Disable interactive prompting. Missing required answers fail with RecipeMissingAnswerError.",
      default: false,
    }),
    answer: Flags.string({
      description: "Recipe answer in key=value form (repeatable).",
      multiple: true,
    }),
    option: Flags.string({
      description: "Recipe option in key=value form (repeatable).",
      multiple: true,
    }),
  };
  static override landoSpec: LandoCommandSpec = initSpec;
  static override bootstrap = initSpec.bootstrap;

  override async run(): Promise<void> {
    // Remove --renderer before parsing because this command overrides run() and
    // never passes through runEffect, so the flag would be rejected.
    let rendererMode: "lando" | "json" | "plain";
    try {
      const resolution = resolveRendererMode({ argv: this.argv, env: process.env });
      rendererMode = resolution.mode;
      this.argv.length = 0;
      this.argv.push(...resolution.remainingArgv);
    } catch (error) {
      if (error instanceof RendererSelectionError) {
        const text = formatBugReport({
          error,
          context: { commandId: "cli:renderer-selection" },
          rendererMode: "plain",
        });
        throw new Error(text);
      }
      throw error;
    }

    const { flags } = (await this.parse(InitCommand)) as { readonly flags: InitFlags };
    const answers = parseAnswerFlags(flags.answer ?? []);
    const options: InitAppOptions = {
      cwd: process.cwd(),
      full: flags.full,
      answers,
      yes: flags.yes === true,
      nonInteractive: flags["no-interactive"] === true,
      ...(flags.name === undefined ? {} : { name: flags.name }),
      ...(flags.recipe === undefined ? {} : { recipe: flags.recipe }),
    };

    let result: InitAppResult;
    try {
      result = await initApp(options);
    } catch (error) {
      const text = formatBugReport({
        error,
        context: { commandId: "apps:init" },
        rendererMode,
      });
      if (rendererMode === "json") {
        process.stderr.write(`${text}\n`);
        process.exitCode = 1;
        return;
      }
      throw new Error(text);
    }
    this.log(`Created ${result.appName} at ${result.directory}`);
  }
}
