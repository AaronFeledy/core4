import { Args } from "../../../spec/metadata";

import type { ScratchHandle } from "@lando/sdk/services";
import {
  ScratchHandleResultSchema,
  renderScratchStopResult,
  scratchIdFromInput,
  scratchStop,
} from "../../../commands/scratch";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const appsScratchStopSpec: LandoCommandSpec<ScratchHandle> = {
  resultSchema: ScratchHandleResultSchema,
  id: "apps:scratch:stop",
  summary: "Stop a scratch Lando app.",
  namespace: "apps",
  topLevelAlias: "scratch:stop",
  aliases: ["scratch:stop"],
  bootstrap: "scratch",
  args: {
    id: Args.string({ description: "Scratch app id.", required: true }),
  },
  run: (input) => scratchStop(scratchIdFromInput(input)),
  render: (result) => renderScratchStopResult(result as ScratchHandle),
};
