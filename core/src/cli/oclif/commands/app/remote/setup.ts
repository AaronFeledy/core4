import { RemoteTestResult } from "@lando/sdk/schema";

import { appRemoteSetup, renderRemoteTestResult } from "../../../../commands/remote.ts";
import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";
import { remoteEnvArg, remoteSetupFlags, remoteSetupOptionsFromInput } from "./common.ts";

export const remoteSetupSpec: LandoCommandSpec = {
  id: "app:remote:setup",
  summary: "Run remote setup checks for the current app.",
  namespace: "app",
  bootstrap: "app",
  flags: remoteSetupFlags,
  args: { env: remoteEnvArg },
  resultSchema: RemoteTestResult,
  run: (input) => appRemoteSetup(remoteSetupOptionsFromInput(input)),
  render: (result, input, ctx) =>
    renderRemoteTestResult(result as never, remoteSetupOptionsFromInput(input).format, ctx),
};

export default class RemoteSetupCommand extends LandoCommandBase {
  static override description = remoteSetupSpec.summary;
  static override flags = remoteSetupFlags;
  static override args = { env: remoteEnvArg };
  static override landoSpec: LandoCommandSpec = remoteSetupSpec;
  static override bootstrap = remoteSetupSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(remoteSetupSpec);
  }
}
