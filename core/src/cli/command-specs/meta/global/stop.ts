import {
  type GlobalStopResult,
  GlobalStopResultSchema,
  globalStop,
  renderGlobalStopResult,
} from "../../../commands/meta/global-stop";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const metaGlobalStopSpec: LandoCommandSpec<GlobalStopResult> = {
  resultSchema: GlobalStopResultSchema,
  id: "meta:global:stop",
  summary: "Stop the host-level global Lando app.",
  description: "Stop the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:stop",
  bootstrap: "global",
  run: () => globalStop(),
  render: (result) => renderGlobalStopResult(result as GlobalStopResult),
};
