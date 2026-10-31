import {
  type GlobalRestartResult,
  GlobalRestartResultSchema,
  globalRestart,
} from "@lando/engine/operations/global-restart";
import { renderGlobalRestartResult } from "../../../commands/meta/global-restart";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../../spec/command-base";

export const metaGlobalRestartSpec: LandoCommandSpec<GlobalRestartResult> = {
  resultSchema: GlobalRestartResultSchema,
  id: "meta:global:restart",
  summary: "Restart the host-level global Lando app (stop + start).",
  description: "Restart the host-level global Lando app (stop + start).",
  namespace: "meta",
  topLevelAlias: "global:restart",
  bootstrap: "global",
  run: (input) => {
    const signal = extractSpecAbortSignal(input);
    return globalRestart(signal === undefined ? {} : { signal });
  },
  render: (result) => renderGlobalRestartResult(result),
};
