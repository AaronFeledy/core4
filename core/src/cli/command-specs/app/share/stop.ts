import { type ShareStopResult, ShareStopResultSchema, appShareStop } from "@lando/engine/operations/share";
import { renderShareStopResult } from "../../../commands/share";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { shareFormatFromInput, shareStopFlags, shareStopOptionsFromInput } from "./common";

export const shareStopSpec: LandoCommandSpec = {
  id: "app:share:stop",
  summary: "Stop a public tunnel session.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "app",
  flags: shareStopFlags,
  resultSchema: ShareStopResultSchema,
  run: (input) => appShareStop(shareStopOptionsFromInput(input)),
  render: (result, input, ctx) =>
    renderShareStopResult(result as ShareStopResult, shareFormatFromInput(input), ctx),
};
