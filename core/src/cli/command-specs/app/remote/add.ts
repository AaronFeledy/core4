import { appRemoteAdd } from "@lando/engine/operations/remote";
import { AppRemoteMutationResult } from "@lando/sdk/schema";
import { renderRemoteMutationResult } from "../../../commands/remote";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { remoteAddFlags, remoteAddOptionsFromInput, remoteNameArg, remoteSourceArg } from "./common";

export const remoteAddSpec: LandoCommandSpec<AppRemoteMutationResult> = {
  id: "app:remote:add",
  summary: "Add a remote to the current app Landofile.",
  namespace: "app",
  bootstrap: "app",
  flags: remoteAddFlags,
  args: { name: remoteNameArg, source: remoteSourceArg },
  resultSchema: AppRemoteMutationResult,
  run: (input) => appRemoteAdd(remoteAddOptionsFromInput(input)),
  render: (result, input, ctx) =>
    renderRemoteMutationResult(result, "added", remoteAddOptionsFromInput(input).format, ctx),
};
