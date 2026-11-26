import { appRemoteSetup } from "@lando/engine/operations/remote";
import { RemoteTestResult } from "@lando/sdk/schema";
import { renderRemoteTestResult } from "../../../commands/remote";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { remoteEnvArg, remoteFormatFromInput, remoteSetupFlags, remoteSetupOptionsFromInput } from "./common";

export const remoteSetupSpec: LandoCommandSpec<RemoteTestResult> = {
  id: "app:remote:setup",
  onlineAcquisition: true,
  summary: "Run remote setup checks for the current app.",
  namespace: "app",
  bootstrap: "app",
  flags: remoteSetupFlags,
  args: { env: remoteEnvArg },
  resultSchema: RemoteTestResult,
  run: (input) => appRemoteSetup(remoteSetupOptionsFromInput(input)),
  render: (result, input, ctx) => renderRemoteTestResult(result, remoteFormatFromInput(input), ctx),
};
