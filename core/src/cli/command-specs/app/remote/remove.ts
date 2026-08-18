import { RemoteMutationResultSchema, appRemoteRemove } from "@lando/engine/operations/remote";
import { renderRemoteMutationResult } from "../../../commands/remote";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { remoteConfigFlags, remoteNameArg, remoteRemoveOptionsFromInput } from "./common";

export const remoteRemoveSpec: LandoCommandSpec = {
  id: "app:remote:remove",
  summary: "Remove a remote from the current app Landofile.",
  namespace: "app",
  bootstrap: "app",
  flags: remoteConfigFlags,
  args: { name: remoteNameArg },
  resultSchema: RemoteMutationResultSchema,
  run: (input) => appRemoteRemove(remoteRemoveOptionsFromInput(input)),
  render: (result, input, ctx) =>
    renderRemoteMutationResult(result as never, "removed", remoteRemoveOptionsFromInput(input).format, ctx),
};
