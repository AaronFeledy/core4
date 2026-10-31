import { stopApp } from "@lando/engine/operations/stop";
import { StopAppResult } from "@lando/sdk/schema";
import { renderStopAppResult } from "../../commands/stop";
import type { LandoCommandSpec } from "../../spec/command-base";

/**
 * `lando app:stop` — native command metadata adapter.
 */

export const stopSpec: LandoCommandSpec<StopAppResult> = {
  resultSchema: StopAppResult,
  id: "app:stop",
  helpGroup: "common",
  mcpAllowed: true,
  summary: "Stop the current Lando app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => stopApp(),
  render: (result) => renderStopAppResult(result as StopAppResult),
};
