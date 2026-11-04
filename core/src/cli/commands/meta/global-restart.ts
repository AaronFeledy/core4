import type { GlobalRestartResult } from "@lando/engine/operations/global-restart";
import { lifecycleLine, serviceRowsText } from "../service-summary";

export const renderGlobalRestartResult = (result: GlobalRestartResult): string =>
  lifecycleLine("restarted", result.app, serviceRowsText(result.servicesStarted));
