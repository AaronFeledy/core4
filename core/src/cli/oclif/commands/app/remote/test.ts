import { RemoteTestResult } from "@lando/sdk/schema";

import { appRemoteTest, renderRemoteTestResult } from "../../../../commands/remote.ts";
import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";
import { remoteConfigFlags, remoteEnvArg, remoteTestOptionsFromInput } from "./common.ts";

export const remoteTestSpec: LandoCommandSpec = {
  id: "app:remote:test",
  summary: "Test remote connectivity for the current app.",
  namespace: "app",
  bootstrap: "app",
  flags: remoteConfigFlags,
  args: { env: remoteEnvArg },
  resultSchema: RemoteTestResult,
  run: (input) => appRemoteTest(remoteTestOptionsFromInput(input)),
  render: (result, input) =>
    renderRemoteTestResult(result as never, remoteTestOptionsFromInput(input).format),
};

export default class RemoteTestCommand extends LandoCommandBase {
  static override description = remoteTestSpec.summary;
  static override flags = remoteConfigFlags;
  static override args = { env: remoteEnvArg };
  static override landoSpec: LandoCommandSpec = remoteTestSpec;
  static override bootstrap = remoteTestSpec.bootstrap;

  override async run(): Promise<void> {
    const parsed = await this.parse(RemoteTestCommand);
    await this.runEffect({
      ...remoteTestSpec,
      render: (result) => renderRemoteTestResult(result as never, remoteTestOptionsFromInput(parsed).format),
    });
  }
}
