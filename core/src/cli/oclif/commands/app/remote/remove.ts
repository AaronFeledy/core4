import {
  RemoteMutationResultSchema,
  appRemoteRemove,
  renderRemoteMutationResult,
} from "../../../../commands/remote.ts";
import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";
import { remoteConfigFlags, remoteNameArg, remoteRemoveOptionsFromInput } from "./common.ts";

export const remoteRemoveSpec: LandoCommandSpec = {
  id: "app:remote:remove",
  summary: "Remove a remote from the current app Landofile.",
  namespace: "app",
  bootstrap: "app",
  flags: remoteConfigFlags,
  args: { name: remoteNameArg },
  resultSchema: RemoteMutationResultSchema,
  run: (input) => appRemoteRemove(remoteRemoveOptionsFromInput(input)),
  render: (result, input) =>
    renderRemoteMutationResult(result as never, "removed", remoteRemoveOptionsFromInput(input).format),
};

export default class RemoteRemoveCommand extends LandoCommandBase {
  static override description = remoteRemoveSpec.summary;
  static override flags = remoteConfigFlags;
  static override args = { name: remoteNameArg };
  static override landoSpec: LandoCommandSpec = remoteRemoveSpec;
  static override bootstrap = remoteRemoveSpec.bootstrap;

  override async run(): Promise<void> {
    const parsed = await this.parse(RemoteRemoveCommand);
    await this.runEffect({
      ...remoteRemoveSpec,
      render: (result) =>
        renderRemoteMutationResult(result as never, "removed", remoteRemoveOptionsFromInput(parsed).format),
    });
  }
}
