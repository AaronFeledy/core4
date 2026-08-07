/** `lando stop` result rendering. The operation lives in `core/src/operations/stop.ts`. */
import type { StopAppResult } from "@lando/sdk/app";

export const renderStopAppResult = (result: StopAppResult): string => {
  const services = result.servicesStopped.length === 0 ? "no services" : result.servicesStopped.join(", ");
  return `stopped: ${result.app} - ${services}`;
};
