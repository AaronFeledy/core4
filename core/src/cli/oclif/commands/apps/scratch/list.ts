import { Flags } from "@oclif/core";

import type { ScratchSummary } from "@lando/sdk/services";
import {
  ScratchListResultSchema,
  renderScratchListResult,
  scratchList,
  scratchListFormatFromInput,
} from "../../../../commands/scratch.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const appsScratchListSpec: LandoCommandSpec<ReadonlyArray<ScratchSummary>> = {
  resultSchema: ScratchListResultSchema,
  id: "apps:scratch:list",
  summary: "List scratch Lando apps.",
  namespace: "apps",
  topLevelAlias: "scratch:list",
  bootstrap: "scratch",
  run: () => scratchList(),
  render: (result, input, ctx) =>
    renderScratchListResult(result as ReadonlyArray<ScratchSummary>, scratchListFormatFromInput(input), ctx),
};

export default class AppsScratchListCommand extends LandoCommandBase {
  static override description = appsScratchListSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appsScratchListSpec)];
  static override flags = {
    format: Flags.string({ description: "Output format.", options: ["table", "json"], default: "table" }),
  };
  static override landoSpec: LandoCommandSpec = appsScratchListSpec;
  static override bootstrap = appsScratchListSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appsScratchListSpec);
  }
}
