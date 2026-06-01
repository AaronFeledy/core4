import { Flags } from "@oclif/core";

import {
  type ScratchStartResult,
  normalizeScratchStartArgv,
  renderScratchStartResult,
  scratchStart,
  scratchStartOptionsFromInput,
} from "../../../../commands/scratch.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const appsScratchStartSpec: LandoCommandSpec<ScratchStartResult> = {
  id: "apps:scratch:start",
  summary: "Start a scratch Lando app.",
  namespace: "apps",
  topLevelAlias: ["scratch:start", "scratch"],
  bootstrap: "scratch",
  run: (input) => scratchStart(scratchStartOptionsFromInput(input)),
  render: (result) => renderScratchStartResult(result as ScratchStartResult),
};

export default class AppsScratchStartCommand extends LandoCommandBase {
  static override description = appsScratchStartSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appsScratchStartSpec)];
  static override flags = {
    fork: Flags.boolean({ description: "Use the current app as the scratch source.", default: false }),
    from: Flags.string({ description: "Recipe reference to materialize as a scratch app." }),
    detach: Flags.boolean({ description: "Return after acquiring the scratch app.", default: false }),
    name: Flags.string({ description: "Base name for the generated scratch id." }),
    answer: Flags.string({ description: "Recipe answer in key=value form (repeatable).", multiple: true }),
    option: Flags.string({
      description: "Alias for --answer in key=value form (repeatable).",
      multiple: true,
    }),
    yes: Flags.boolean({
      char: "y",
      description: "Accept every recipe prompt's default without asking.",
      default: false,
    }),
    "no-interactive": Flags.boolean({
      aliases: ["non-interactive"],
      description: "Never prompt; recipe prompts must be satisfied by defaults or --answer.",
      default: false,
    }),
    isolate: Flags.string({
      options: ["none", "full"],
      description: "Fork isolation: 'none' shares the source app root, 'full' uses a content copy.",
    }),
    "mount-cwd": Flags.string({
      helpValue: "container-path",
      description: "Mount the current working directory into the scratch app's primary service.",
    }),
    "share-global-storage": Flags.boolean({
      default: false,
      description: "Join the shared cross-app network and expose the global app's storage scope.",
    }),
  };
  static override landoSpec: LandoCommandSpec = appsScratchStartSpec;
  static override bootstrap = appsScratchStartSpec.bootstrap;

  override async run(): Promise<void> {
    // `--mount-cwd` takes an optional value (`--mount-cwd[=<container-path>]`); oclif's string
    // flag rejects the bare form, so rewrite it to the empty-value form before parsing.
    this.argv = [...normalizeScratchStartArgv(this.argv)];
    await this.runEffect(appsScratchStartSpec);
  }
}
