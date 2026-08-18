import { Flags } from "../../../spec/metadata";

import {
  type ScratchStartResult,
  ScratchStartResultSchema,
  renderScratchStartResult,
  scratchStart,
  scratchStartOptionsFromInput,
} from "../../../commands/scratch";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const appsScratchStartSpec: LandoCommandSpec<ScratchStartResult> = {
  resultSchema: ScratchStartResultSchema,
  id: "apps:scratch:start",
  summary: "Start a scratch Lando app.",
  namespace: "apps",
  topLevelAlias: ["scratch:start", "scratch"],
  aliases: ["scratch:start", "scratch"],
  bootstrap: "scratch",
  flags: {
    fork: Flags.boolean({ description: "Use the current app as the scratch source.", default: false }),
    from: Flags.string({ description: "Recipe reference to materialize as a scratch app." }),
    detach: Flags.boolean({ description: "Return after acquiring the scratch app.", default: false }),
    name: Flags.string({ description: "Base name for the generated scratch id." }),
    answer: Flags.string({ description: "Recipe answer in key=value form (repeatable).", multiple: true }),
    option: Flags.string({
      description: "Alias for --answer in key=value form (repeatable).",
      multiple: true,
    }),
    answers: Flags.string({ description: "Path to a JSON answers file." }),
    yes: Flags.boolean({
      char: "y",
      description: "Accept every recipe prompt's default without asking.",
      default: false,
    }),
    interactive: Flags.boolean({
      description: "Force interactive prompting even when stdin is not detected as a TTY.",
      default: false,
    }),
    "no-interactive": Flags.boolean({
      aliases: ["non-interactive"],
      description: "Never prompt; recipe prompts must be satisfied by defaults or --answer.",
      default: false,
    }),
    isolate: Flags.string({
      options: ["none", "full", "baked", "cwd"],
      description: "Scratch isolation mode; 'none' is a legacy alias for 'cwd'.",
    }),
    "mount-cwd": Flags.string({
      helpValue: "container-path",
      description: "Mount the current working directory into the scratch app's primary service.",
    }),
    "share-global-storage": Flags.boolean({
      default: false,
      description: "Join the shared cross-app network and expose the global app's storage scope.",
    }),
  },
  run: (input) => scratchStart(scratchStartOptionsFromInput(input)),
  render: (result) => renderScratchStartResult(result as ScratchStartResult),
};
