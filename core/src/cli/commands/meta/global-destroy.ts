import type { GlobalDestroyResult } from "@lando/engine/operations/global-destroy";
import { teardownLine, volumesTrailer } from "../service-summary";
import { shutdownServiceRows } from "../shutdown-summary";

export const renderGlobalDestroyResult = (result: GlobalDestroyResult): string =>
  teardownLine(
    result.outcome,
    result.app,
    shutdownServiceRows(result.servicesDestroyed, result.shutdownObservations),
    volumesTrailer(result.volumesRemoved),
  );
