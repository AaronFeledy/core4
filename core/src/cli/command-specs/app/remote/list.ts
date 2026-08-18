import { RemoteListResultSchema, appRemoteList } from "@lando/engine/operations/remote";
import { renderRemoteListResult } from "../../../commands/remote";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { remoteConfigFlags, remoteListOptionsFromInput } from "./common";

export const remoteListSpec: LandoCommandSpec = {
  id: "app:remote:list",
  summary: "List remotes configured for the current app.",
  namespace: "app",
  bootstrap: "app",
  flags: remoteConfigFlags,
  resultSchema: RemoteListResultSchema,
  run: (input) => appRemoteList(remoteListOptionsFromInput(input)),
  render: (result, input, ctx) =>
    renderRemoteListResult(result as never, remoteListOptionsFromInput(input).format, ctx),
};
