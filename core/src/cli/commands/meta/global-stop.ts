import type { GlobalStopResult } from "@lando/engine/operations/global-stop";
import { teardownLine } from "../service-summary";

export const renderGlobalStopResult = (result: GlobalStopResult): string =>
  teardownLine(result.outcome, result.app, result.servicesStopped);
