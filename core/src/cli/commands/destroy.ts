/** `lando destroy` result rendering. */
import type { DestroyAppResult } from "@lando/sdk/app";
import { teardownLine, unchangedLine, volumesTrailer } from "./service-summary";

export const renderDestroyAppResult = (result: DestroyAppResult): string => {
  if (result.outcome === "unchanged") return unchangedLine(result.app);
  const trailer = volumesTrailer(result.volumesRemoved, result.snapshotsRemoved);
  if (result.servicesDestroyed.length === 0 && result.snapshotsRemoved > 0)
    return `destroyed: ${result.app} (${trailer})`;
  return teardownLine("destroyed", result.app, result.servicesDestroyed, trailer);
};
