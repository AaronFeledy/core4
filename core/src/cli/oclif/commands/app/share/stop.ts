import { type ShareStopResult, ShareStopResultSchema, appShareStop } from "@lando/engine/operations/share";
import { renderShareStopResult } from "../../../../commands/share";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base";
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

export default class ShareStopCommand extends LandoCommandBase {
  static override description = shareStopSpec.summary;
  static override aliases = [...resolveTopLevelAliases(shareStopSpec)];
  static override flags = shareStopFlags;
  static override landoSpec: LandoCommandSpec = shareStopSpec;
  static override bootstrap = shareStopSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(shareStopSpec);
  }
}
