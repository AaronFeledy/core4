import { Args, Flags } from "@oclif/core";

import type { ScratchInfo } from "@lando/sdk/services";
import {
  ScratchInfoResultSchema,
  renderScratchInfoResult,
  scratchIdFromInput,
  scratchInfo,
  scratchListFormatFromInput,
} from "../../../../commands/scratch.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const appsScratchInfoSpec: LandoCommandSpec<ScratchInfo> = {
  resultSchema: ScratchInfoResultSchema,
  id: "apps:scratch:info",
  summary: "Show information for a scratch Lando app.",
  namespace: "apps",
  topLevelAlias: "scratch:info",
  bootstrap: "scratch",
  run: (input) => scratchInfo(scratchIdFromInput(input)),
  render: (result, input) =>
    renderScratchInfoResult(result as ScratchInfo, scratchListFormatFromInput(input)),
};

export default class AppsScratchInfoCommand extends LandoCommandBase {
  static override description = appsScratchInfoSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appsScratchInfoSpec)];
  static override args = {
    id: Args.string({ description: "Scratch app id.", required: false }),
  };
  static override flags = {
    format: Flags.string({ description: "Output format.", options: ["table", "json"], default: "table" }),
  };
  static override landoSpec: LandoCommandSpec = appsScratchInfoSpec;
  static override bootstrap = appsScratchInfoSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appsScratchInfoSpec);
  }
}
