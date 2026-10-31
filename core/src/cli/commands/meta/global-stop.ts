import type { GlobalStopResult } from "@lando/engine/operations/global-stop";
import { teardownLine } from "../service-summary";
import { shutdownServiceRows } from "../shutdown-summary";

export const renderGlobalStopResult = (result: GlobalStopResult): string =>
  teardownLine(
    result.outcome,
    result.app,
    shutdownServiceRows(result.servicesStopped, result.shutdownObservations),
  );
