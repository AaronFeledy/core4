import { Effect } from "effect";

import { TunnelSession, type TunnelSession as TunnelSessionType } from "@lando/sdk/schema";

import { appShare, renderShareResult } from "../../../commands/share.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";
import { shareFlags, shareFormatFromInput, shareOptionsFromInput } from "./share/common.ts";

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

export default class ShareCommand extends LandoCommandBase {
  static override description = shareSpec.summary;
  static override aliases = [...resolveTopLevelAliases(shareSpec)];
  static override flags = shareFlags;
  static override landoSpec: LandoCommandSpec = shareSpec;
  static override bootstrap = shareSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(shareSpec);
  }
}
