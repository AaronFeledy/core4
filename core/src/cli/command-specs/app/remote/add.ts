import { RemoteMutationResultSchema, appRemoteAdd } from "@lando/engine/operations/remote";
import { renderRemoteMutationResult } from "../../../commands/remote";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { remoteAddFlags, remoteAddOptionsFromInput, remoteNameArg, remoteSourceArg } from "./common";

export const remoteAddSpec: LandoCommandSpec = {
  id: "app:remote:add",
  summary: "Add a remote to the current app Landofile.",
  namespace: "app",
  bootstrap: "app",
  flags: remoteAddFlags,
  args: { name: remoteNameArg, source: remoteSourceArg },
  resultSchema: RemoteMutationResultSchema,
  run: (input) => appRemoteAdd(remoteAddOptionsFromInput(input)),
  render: (result, input, ctx) =>
    renderRemoteMutationResult(result as never, "added", remoteAddOptionsFromInput(input).format, ctx),
};
