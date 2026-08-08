import { RemoteMutationResultSchema, appRemoteRemove } from "@lando/engine/operations/remote";
import { renderRemoteMutationResult } from "../../../../commands/remote";
import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base";
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

export default class RemoteRemoveCommand extends LandoCommandBase {
  static override description = remoteRemoveSpec.summary;
  static override flags = remoteConfigFlags;
  static override args = { name: remoteNameArg };
  static override landoSpec: LandoCommandSpec = remoteRemoveSpec;
  static override bootstrap = remoteRemoveSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(remoteRemoveSpec);
  }
}
