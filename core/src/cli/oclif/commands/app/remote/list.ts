import {
  RemoteListResultSchema,
  appRemoteList,
  renderRemoteListResult,
} from "../../../../commands/remote.ts";
import { LandoCommandBase, type LandoCommandSpec } from "../../../command-base.ts";
import { remoteConfigFlags, remoteListOptionsFromInput } from "./common.ts";

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

export default class RemoteListCommand extends LandoCommandBase {
  static override description = remoteListSpec.summary;
  static override flags = remoteConfigFlags;
  static override landoSpec: LandoCommandSpec = remoteListSpec;
  static override bootstrap = remoteListSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(remoteListSpec);
  }
}
