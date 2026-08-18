import { Args } from "../../../spec/metadata";

import {
  type ScratchLogsResult,
  ScratchLogsResultSchema,
  renderScratchLogsResult,
  scratchIdFromInput,
  scratchLogs,
} from "../../../commands/scratch";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const appsScratchLogsSpec: LandoCommandSpec<ScratchLogsResult> = {
  resultSchema: ScratchLogsResultSchema,
  id: "apps:scratch:logs",
  summary: "Show logs for a scratch Lando app.",
  namespace: "apps",
  topLevelAlias: "scratch:logs",
  aliases: ["scratch:logs"],
  bootstrap: "scratch",
  args: {
    id: Args.string({ description: "Scratch app id.", required: false }),
  },
  run: (input) => scratchLogs(scratchIdFromInput(input)),
  render: (result) => renderScratchLogsResult(result as ScratchLogsResult),
};
