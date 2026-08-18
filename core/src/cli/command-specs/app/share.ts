import { Effect } from "effect";

import { TunnelSession, type TunnelSession as TunnelSessionType } from "@lando/sdk/schema";

import { appShare } from "@lando/engine/operations/share";
import { renderShareResult } from "../../commands/share";
import type { LandoCommandSpec } from "../../spec/command-base";
import { shareFlags, shareFormatFromInput, shareOptionsFromInput } from "./share/common";

export const shareSpec: LandoCommandSpec<TunnelSessionType> = {
  id: "app:share",
  summary: "Start a public tunnel for the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  flags: shareFlags,
  resultSchema: TunnelSession,
  run: (input) => Effect.scoped(appShare(shareOptionsFromInput(input))),
  render: (result, input, ctx) =>
    renderShareResult(result as TunnelSessionType, shareFormatFromInput(input), ctx),
};
