import { RemoteMutationResultSchema, appRemoteAdd } from "@lando/engine/operations/remote";
import { renderRemoteMutationResult } from "../../../../commands/remote";
import { LandoCommandBase, type LandoCommandSpec } from "../../../../spec/command-base";
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

export default class RemoteAddCommand extends LandoCommandBase {
  static override description = remoteAddSpec.summary;
  static override flags = remoteAddFlags;
  static override args = { name: remoteNameArg, source: remoteSourceArg };
  static override landoSpec: LandoCommandSpec = remoteAddSpec;
  static override bootstrap = remoteAddSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(remoteAddSpec);
  }
}
