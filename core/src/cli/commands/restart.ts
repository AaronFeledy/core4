/** `lando restart` result rendering. */
import type { RestartAppResult } from "@lando/sdk/app";
import { lifecycleLine, serviceRowsText } from "./service-summary";

export const renderRestartAppResult = (result: RestartAppResult): string => {
  return lifecycleLine("restarted", result.app, serviceRowsText(result.servicesStarted));
};
