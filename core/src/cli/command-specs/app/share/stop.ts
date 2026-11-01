import { appShareStop } from "@lando/engine/operations/share";
import { ShareStopAppResult } from "@lando/sdk/schema";
import { renderShareStopResult } from "../../../commands/share";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { Args } from "../../../spec/metadata";
import { shareFormatFromInput, shareStopFlags, shareStopOptionsFromInput } from "./common";

export const shareStopSpec: LandoCommandSpec<ShareStopAppResult> = {
  id: "app:share:stop",
  summary: "Stop a public tunnel session.",
  namespace: "app",
  topLevelAlias: "share:stop",
  aliases: ["share:stop"],
  bootstrap: "app",
  args: {
    session: Args.string({ description: "Tunnel session id." }),
  },
  flags: shareStopFlags,
  resultSchema: ShareStopAppResult,
  run: (input) => appShareStop(shareStopOptionsFromInput(input)),
  render: (result, input, ctx) => renderShareStopResult(result, shareFormatFromInput(input), ctx),
};
