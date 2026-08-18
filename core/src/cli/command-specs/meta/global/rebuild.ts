import {
  type GlobalRebuildResult,
  GlobalRebuildResultSchema,
  globalRebuild,
  renderGlobalRebuildResult,
} from "../../../commands/meta/global-rebuild";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../../spec/command-base";

export const metaGlobalRebuildSpec: LandoCommandSpec<GlobalRebuildResult> = {
  resultSchema: GlobalRebuildResultSchema,
  id: "meta:global:rebuild",
  summary: "Rebuild the host-level global Lando app.",
  description: "Rebuild the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:rebuild",
  bootstrap: "global",
  run: (input) => {
    const signal = extractSpecAbortSignal(input);
    return globalRebuild(signal === undefined ? {} : { signal });
  },
  render: (result) => renderGlobalRebuildResult(result as GlobalRebuildResult),
};
