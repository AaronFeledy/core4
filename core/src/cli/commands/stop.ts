/** `lando stop` result rendering. */
import type { StopAppResult } from "@lando/sdk/app";

export const renderStopAppResult = (result: StopAppResult): string => {
  const services = result.servicesStopped.length === 0 ? "no services" : result.servicesStopped.join(", ");
  return `stopped: ${result.app} - ${services}`;
};
