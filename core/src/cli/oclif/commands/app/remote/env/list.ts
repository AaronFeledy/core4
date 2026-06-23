import {
  RemoteEnvListResultSchema,
  appRemoteEnvList,
  renderRemoteEnvListResult,
} from "../../../../../commands/remote.ts";
import { LandoCommandBase, type LandoCommandSpec } from "../../../../command-base.ts";
import { remoteConfigFlags, remoteEnvListOptionsFromInput } from "../common.ts";

export const remoteEnvListSpec: LandoCommandSpec = {
  id: "app:remote:env:list",
  summary: "List environments for a configured remote.",
  namespace: "app",
  bootstrap: "app",
  flags: remoteConfigFlags,
  resultSchema: RemoteEnvListResultSchema,
  run: (input) => appRemoteEnvList(remoteEnvListOptionsFromInput(input)),
  render: (result, input) =>
    renderRemoteEnvListResult(result as never, remoteEnvListOptionsFromInput(input).format),
};

export default class RemoteEnvListCommand extends LandoCommandBase {
  static override description = remoteEnvListSpec.summary;
  static override flags = remoteConfigFlags;
  static override landoSpec: LandoCommandSpec = remoteEnvListSpec;
  static override bootstrap = remoteEnvListSpec.bootstrap;

  override async run(): Promise<void> {
    const parsed = await this.parse(RemoteEnvListCommand);
    await this.runEffect({
      ...remoteEnvListSpec,
      render: (result) =>
        renderRemoteEnvListResult(result as never, remoteEnvListOptionsFromInput(parsed).format),
    });
  }
}
