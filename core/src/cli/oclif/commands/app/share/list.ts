import { Schema } from "effect";

import { TunnelSession, type TunnelSession as TunnelSessionType } from "@lando/sdk/schema";

import { appShareList, renderShareListResult } from "../../../../commands/share.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";
import { shareFormatFromInput, shareListFlags, shareListOptionsFromInput } from "./common.ts";

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

export default class ShareListCommand extends LandoCommandBase {
  static override description = shareListSpec.summary;
  static override aliases = [...resolveTopLevelAliases(shareListSpec)];
  static override flags = shareListFlags;
  static override landoSpec: LandoCommandSpec = shareListSpec;
  static override bootstrap = shareListSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(shareListSpec);
  }
}
