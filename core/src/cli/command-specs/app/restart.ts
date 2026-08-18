import { type RestartAppResult, RestartAppResultSchema, restartApp } from "@lando/engine/operations/restart";
import { renderRestartAppResult } from "../../commands/restart";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";

export const restartSpec: LandoCommandSpec<RestartAppResult> = {
  resultSchema: RestartAppResultSchema,
  id: "app:restart",
  mcpAllowed: true,
  summary: "Restart the current app (stop + start).",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: (input) => {
    const signal = extractSpecAbortSignal(input);
    return restartApp(signal === undefined ? {} : { signal });
  },
  render: (result) => renderRestartAppResult(result as RestartAppResult),
};
