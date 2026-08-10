import { SyncResult, type SyncResult as SyncResultType } from "@lando/sdk/schema";

import { confirmRemoteSyncWithInteraction } from "@lando/engine/app/remote-confirmation";
import { appPull } from "@lando/engine/operations/remote";
import { renderSyncResult } from "../../commands/remote";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../spec/command-base";
import {
  remoteEnvArg,
  remoteFormatFromInput,
  remoteSkeletonFlags,
  remoteSyncOptionsFromInput,
} from "./remote/common";

export const pullSpec: LandoCommandSpec<SyncResultType> = {
  id: "app:pull",
  summary: "Pull remote datasets into the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  flags: remoteSkeletonFlags,
  args: { env: remoteEnvArg },
  resultSchema: SyncResult,
  run: (input) => appPull(remoteSyncOptionsFromInput(input), undefined, confirmRemoteSyncWithInteraction),
  render: (result, input, ctx) =>
    renderSyncResult(result as SyncResultType, remoteFormatFromInput(input), ctx),
};

export default class PullCommand extends LandoCommandBase {
  static override description = pullSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pullSpec)];
  static override flags = remoteSkeletonFlags;
  static override args = { env: remoteEnvArg };
  static override landoSpec: LandoCommandSpec = pullSpec;
  static override bootstrap = pullSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pullSpec);
  }
}
