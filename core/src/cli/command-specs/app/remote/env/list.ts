import { RemoteEnvListResultSchema, appRemoteEnvList } from "@lando/engine/operations/remote";
import { renderRemoteEnvListResult } from "../../../../commands/remote";
import type { LandoCommandSpec } from "../../../../spec/command-base";
import { remoteConfigFlags, remoteEnvListOptionsFromInput } from "../common";

export const remoteEnvListSpec: LandoCommandSpec = {
  id: "app:remote:env:list",
  summary: "List environments for a configured remote.",
  namespace: "app",
  bootstrap: "app",
  flags: remoteConfigFlags,
  resultSchema: RemoteEnvListResultSchema,
  run: (input) => appRemoteEnvList(remoteEnvListOptionsFromInput(input)),
  render: (result, input, ctx) =>
    renderRemoteEnvListResult(result as never, remoteEnvListOptionsFromInput(input).format, ctx),
};
