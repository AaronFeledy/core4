import { RemoteTestResult } from "@lando/sdk/schema";

import { appRemoteTest } from "@lando/engine/operations/remote";
import { renderRemoteTestResult } from "../../../commands/remote";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { remoteConfigFlags, remoteEnvArg, remoteTestOptionsFromInput } from "./common";

export const remoteTestSpec: LandoCommandSpec<RemoteTestResult> = {
  id: "app:remote:test",
  summary: "Test remote connectivity for the current app.",
  namespace: "app",
  bootstrap: "app",
  flags: remoteConfigFlags,
  args: { env: remoteEnvArg },
  resultSchema: RemoteTestResult,
  run: (input) => appRemoteTest(remoteTestOptionsFromInput(input)),
  render: (result, input, ctx) =>
    renderRemoteTestResult(result, remoteTestOptionsFromInput(input).format, ctx),
};
