import { Flags } from "@oclif/core";

import {
  type ScratchStartResult,
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
  };
  static override landoSpec: LandoCommandSpec = appsScratchStartSpec;
  static override bootstrap = appsScratchStartSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appsScratchStartSpec);
  }
}
