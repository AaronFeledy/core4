import type { GlobalStopResult } from "@lando/engine/operations/global-stop";
import { renderStopAppResult } from "../stop";

/** A global stop reads like an app stop, including which containers were already stopped. */
export const renderGlobalStopResult = (result: GlobalStopResult): string => renderStopAppResult(result);
