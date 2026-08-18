import { RemoteTestResult } from "@lando/sdk/schema";

import { appRemoteSetup } from "@lando/engine/operations/remote";
import { renderRemoteTestResult } from "../../../commands/remote";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { remoteEnvArg, remoteSetupFlags, remoteSetupOptionsFromInput } from "./common";

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
