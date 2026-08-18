import { Flags } from "../../../spec/metadata";

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
  mcpAllowed: true,
  summary: "List scratch Lando apps.",
  namespace: "apps",
  topLevelAlias: "scratch:list",
  aliases: ["scratch:list"],
  bootstrap: "scratch",
  flags: {
    format: Flags.string({ description: "Output format.", options: ["table", "json"], default: "table" }),
  },
  run: () => scratchList(),
  render: (result, input, ctx) =>
    renderScratchListResult(result as ReadonlyArray<ScratchSummary>, scratchListFormatFromInput(input), ctx),
};
