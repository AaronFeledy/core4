import { Args } from "@oclif/core";

import type { ScratchHandle } from "@lando/sdk/services";
import { renderScratchInfoResult, scratchIdFromInput, scratchInfo } from "../../../../commands/scratch.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const appsScratchInfoSpec: LandoCommandSpec<ScratchHandle> = {
  id: "apps:scratch:info",
  summary: "Show information for a scratch Lando app.",
  namespace: "apps",
  topLevelAlias: "scratch:info",
  bootstrap: "scratch",
  run: (input) => scratchInfo(scratchIdFromInput(input)),
  render: (result) => renderScratchInfoResult(result as ScratchHandle),
};

export default class AppsScratchInfoCommand extends LandoCommandBase {
  static override description = appsScratchInfoSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appsScratchInfoSpec)];
  static override args = {
    id: Args.string({ description: "Scratch app id.", required: false }),
  };
  static override landoSpec: LandoCommandSpec = appsScratchInfoSpec;
  static override bootstrap = appsScratchInfoSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appsScratchInfoSpec);
  }
}
