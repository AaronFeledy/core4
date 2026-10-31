import { appRemoteRemove } from "@lando/engine/operations/remote";
import { AppRemoteMutationResult } from "@lando/sdk/schema";
import { renderRemoteMutationResult } from "../../../commands/remote";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { nonPromptingYesFlag } from "../../../spec/confirmation-flag";
import { remoteConfigFlags, remoteNameArg, remoteRemoveOptionsFromInput } from "./common";

export const remoteRemoveSpec: LandoCommandSpec = {
  id: "app:remote:remove",
  summary: "Remove a remote from the current app Landofile.",
  namespace: "app",
  bootstrap: "app",
  flags: { ...remoteConfigFlags, yes: nonPromptingYesFlag },
  args: { name: remoteNameArg },
  resultSchema: AppRemoteMutationResult,
  run: (input) => appRemoteRemove(remoteRemoveOptionsFromInput(input)),
  render: (result, input, ctx) =>
    renderRemoteMutationResult(result as never, "removed", remoteRemoveOptionsFromInput(input).format, ctx),
};
