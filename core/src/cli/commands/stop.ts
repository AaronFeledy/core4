/** `lando stop` result rendering. */
import type { StopAppResult } from "@lando/sdk/app";

export const renderStopAppResult = (result: StopAppResult): string => {
  if (result.outcome === "unchanged") return `unchanged: ${result.app} - no services`;
  const services = result.servicesStopped.length === 0 ? "no services" : result.servicesStopped.join(", ");
  return `stopped: ${result.app} - ${services}`;
};
