import { type StopAppResult, StopAppResultSchema, stopApp } from "@lando/engine/operations/stop";
import { renderStopAppResult } from "../../commands/stop";
/**
 * `lando app:stop` — native command metadata adapter.
 */
import type { LandoCommandSpec } from "../../spec/command-base";

export const stopSpec: LandoCommandSpec<StopAppResult> = {
  resultSchema: StopAppResultSchema,
  id: "app:stop",
  mcpAllowed: true,
  summary: "Stop the current Lando app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => stopApp(),
  render: (result) => renderStopAppResult(result as StopAppResult),
};
