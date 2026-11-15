import type { GlobalDestroyResult } from "@lando/engine/operations/global-destroy";
import { builtImageCleanupLines, teardownLine, volumesTrailer } from "../service-summary";
import { shutdownServiceRows } from "../shutdown-summary";

export const renderGlobalDestroyResult = (result: GlobalDestroyResult): string =>
  [
    teardownLine(
      result.outcome,
      result.app,
      shutdownServiceRows(result.servicesDestroyed, result.shutdownObservations),
      volumesTrailer(result.volumesRemoved),
    ),
    ...builtImageCleanupLines(result.builtImages, "--purge"),
  ].join("\n");
