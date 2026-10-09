/** `lando stop` result rendering. */
import type { StopAppResult } from "@lando/sdk/app";
import { teardownLine, unchangedLine } from "./service-summary";

export const renderStopAppResult = (result: StopAppResult): string => {
  if (result.outcome === "unchanged") return unchangedLine(result.app);
  return teardownLine("stopped", result.app, result.servicesStopped);
};
