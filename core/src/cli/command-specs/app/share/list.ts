import { Schema } from "effect";

import { TunnelSession, type TunnelSession as TunnelSessionType } from "@lando/sdk/schema";

import { appShareList } from "@lando/engine/operations/share";
import { renderShareListResult } from "../../../commands/share";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { shareFormatFromInput, shareListFlags, shareListOptionsFromInput } from "./common";

export const shareListSpec: LandoCommandSpec<ReadonlyArray<TunnelSessionType>> = {
  id: "app:share:list",
  summary: "List public tunnel sessions for the current app.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "app",
  flags: shareListFlags,
  resultSchema: Schema.Array(TunnelSession),
  run: (input) => appShareList(shareListOptionsFromInput(input)),
  render: (result, input, ctx) =>
    renderShareListResult(result as ReadonlyArray<TunnelSessionType>, shareFormatFromInput(input), ctx),
};
