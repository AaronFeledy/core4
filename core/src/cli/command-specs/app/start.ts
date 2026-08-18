import { type StartAppResult, StartAppResultSchema, startApp } from "@lando/engine/operations/start";
import { renderStartAppResult } from "../../commands/start-result";
/**
 * `lando app:start` — native command metadata adapter.
 */
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";

import { StreamFrame } from "@lando/sdk/schema";

export const startSpec: LandoCommandSpec<StartAppResult> = {
  resultSchema: StartAppResultSchema,
  id: "app:start",
  mcpAllowed: true,
  summary: "Start the current Lando app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  streaming: StreamFrame,
  run: (input) => {
    const signal = extractSpecAbortSignal(input);
    return startApp(signal === undefined ? {} : { signal });
  },
  render: (result) => renderStartAppResult(result as StartAppResult),
};
