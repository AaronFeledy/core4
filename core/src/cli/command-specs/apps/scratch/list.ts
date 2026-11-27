import type { ScratchSummary } from "@lando/sdk/services";
import {
  ScratchListResultSchema,
  renderScratchListResult,
  scratchList,
  scratchListFormatFromInput,
} from "../../../commands/scratch";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const appsScratchListSpec: LandoCommandSpec<ReadonlyArray<ScratchSummary>> = {
  resultSchema: ScratchListResultSchema,
  id: "apps:scratch:list",
  rendersTable: true,
  mcpAllowed: true,
  summary: "List scratch Lando apps.",
  namespace: "apps",
  topLevelAlias: "scratch:list",
  aliases: ["scratch:list"],
  bootstrap: "scratch",
  run: () => scratchList(),
  render: (result, input, ctx) => renderScratchListResult(result, scratchListFormatFromInput(input), ctx),
};
