import { SyncResult, type SyncResult as SyncResultType } from "@lando/sdk/schema";

import { confirmRemoteSyncWithInteraction } from "@lando/engine/app/remote-confirmation";
import { appPush } from "@lando/engine/operations/remote";
import { renderSyncResult } from "../../commands/remote";
import type { LandoCommandSpec } from "../../spec/command-base";
import {
  remoteEnvArg,
  remoteFormatFromInput,
  remoteSkeletonFlags,
  remoteSyncOptionsFromInput,
} from "./remote/common";

export const pushSpec: LandoCommandSpec<SyncResultType> = {
  id: "app:push",
  summary: "Push local datasets to a remote.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  flags: remoteSkeletonFlags,
  args: { env: remoteEnvArg },
  resultSchema: SyncResult,
  run: (input) => appPush(remoteSyncOptionsFromInput(input), undefined, confirmRemoteSyncWithInteraction),
  render: (result, input, ctx) =>
    renderSyncResult(result as SyncResultType, remoteFormatFromInput(input), ctx),
};
