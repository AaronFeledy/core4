import { Args, Flags } from "../../../spec/metadata";

import type { ScratchInfo } from "@lando/sdk/services";
import {
  ScratchInfoResultSchema,
  renderScratchInfoResult,
  scratchIdFromInput,
  scratchInfo,
  scratchListFormatFromInput,
} from "../../../commands/scratch";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const appsScratchInfoSpec: LandoCommandSpec<ScratchInfo> = {
  resultSchema: ScratchInfoResultSchema,
  id: "apps:scratch:info",
  summary: "Show information for a scratch Lando app.",
  namespace: "apps",
  topLevelAlias: "scratch:info",
  aliases: ["scratch:info"],
  bootstrap: "scratch",
  args: {
    id: Args.string({ description: "Scratch app id.", required: false }),
  },
  flags: {
    format: Flags.string({ description: "Output format.", options: ["table", "json"], default: "table" }),
  },
  run: (input) => scratchInfo(scratchIdFromInput(input)),
  render: (result, input) =>
    renderScratchInfoResult(result as ScratchInfo, scratchListFormatFromInput(input)),
};
