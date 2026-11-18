/** `lando destroy` result rendering. */
import type { DestroyAppResult } from "@lando/sdk/app";
import { builtImageCleanupLines, teardownLine, unchangedLine, volumesTrailer } from "./service-summary";
import { shutdownServiceRows } from "./shutdown-summary";

const destroyLine = (result: DestroyAppResult): string => {
  if (result.outcome === "unchanged") return unchangedLine(result.app);
  const trailer = volumesTrailer(result.volumesRemoved, result.snapshotsRemoved);
  if (result.servicesDestroyed.length === 0 && result.snapshotsRemoved > 0)
    return `destroyed: ${result.app} (${trailer})`;
  return teardownLine(
    "destroyed",
    result.app,
    shutdownServiceRows(result.servicesDestroyed, result.shutdownObservations),
    trailer,
  );
};

export const renderDestroyAppResult = (result: DestroyAppResult): string =>
  [destroyLine(result), ...builtImageCleanupLines(result.builtImages)].join("\n");
