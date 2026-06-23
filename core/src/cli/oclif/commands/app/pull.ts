import { SyncResult, type SyncResult as SyncResultType } from "@lando/sdk/schema";

import { appPull, renderSyncResult } from "../../../commands/remote.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";
import { remoteEnvArg, remoteSkeletonFlags, remoteSyncOptionsFromInput } from "./remote/common.ts";

export const pullSpec: LandoCommandSpec<SyncResultType> = {
  id: "app:pull",
  summary: "Pull remote datasets into the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  flags: remoteSkeletonFlags,
  args: { env: remoteEnvArg },
  resultSchema: SyncResult,
  run: (input) => appPull(remoteSyncOptionsFromInput(input)),
  render: (result, input) =>
    renderSyncResult(
      result as SyncResultType,
      remoteSkeletonFlags.format.default === "json" ? "json" : formatFromInput(input),
    ),
};

const formatFromInput = (input: unknown): "text" | "json" => {
  const flags = typeof input === "object" && input !== null && "flags" in input ? input.flags : undefined;
  return typeof flags === "object" && flags !== null && "format" in flags && flags.format === "json"
    ? "json"
    : "text";
};

export default class PullCommand extends LandoCommandBase {
  static override description = pullSpec.summary;
  static override aliases = [...resolveTopLevelAliases(pullSpec)];
  static override flags = remoteSkeletonFlags;
  static override args = { env: remoteEnvArg };
  static override landoSpec: LandoCommandSpec = pullSpec;
  static override bootstrap = pullSpec.bootstrap;

  override async run(): Promise<void> {
    const parsed = await this.parse(PullCommand);
    await this.runEffect({
      ...pullSpec,
      render: (result) => renderSyncResult(result as SyncResultType, formatFromInput(parsed)),
    });
  }
}
