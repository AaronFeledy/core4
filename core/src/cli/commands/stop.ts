/** `lando stop` result rendering. */
import type { StopAppResult } from "@lando/sdk/app";
import { teardownLine, unchangedLine } from "./service-summary";
import { shutdownServiceRows } from "./shutdown-summary";

export const renderStopAppResult = (result: StopAppResult): string => {
  if (result.runtimeState === "idle" && result.servicesStopped.length === 0)
    return `${result.outcome ?? "stopped"}: ${result.app} (runtime idle; nothing was running)`;
  if (result.outcome === "unchanged") return unchangedLine(result.app);
  return teardownLine(
    "stopped",
    result.app,
    shutdownServiceRows(result.servicesStopped, result.shutdownObservations),
  );
};
