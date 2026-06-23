import { SyncResult, type SyncResult as SyncResultType } from "@lando/sdk/schema";

import { appPush, renderSyncResult } from "../../../commands/remote.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";
import {
  remoteEnvArg,
  remoteFormatFromInput,
  remoteSkeletonFlags,
  remoteSyncOptionsFromInput,
} from "./remote/common.ts";

export const pushSpec: LandoCommandSpec<SyncResultType> = {
  id: "app:push",
  summary: "Push local datasets to a remote.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  flags: remoteSkeletonFlags,
  args: { env: remoteEnvArg },
  resultSchema: SyncResult,
  run: (input) => appPush(remoteSyncOptionsFromInput(input)),
  render: (result, input, ctx) =>
    renderSyncResult(result as SyncResultType, remoteFormatFromInput(input), ctx),
};

export default class PushCommand extends LandoCommandBase {
  static override description = pushSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pushSpec)];
  static override flags = remoteSkeletonFlags;
  static override args = { env: remoteEnvArg };
  static override landoSpec: LandoCommandSpec = pushSpec;
  static override bootstrap = pushSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(pushSpec);
  }
}
