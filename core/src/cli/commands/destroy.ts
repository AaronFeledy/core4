/** `lando destroy` result rendering. */
import type { DestroyAppResult } from "@lando/sdk/app";
import { teardownLine, unchangedLine, volumesTrailer } from "./service-summary";

export const renderDestroyAppResult = (result: DestroyAppResult): string => {
  if (result.outcome === "unchanged") return unchangedLine(result.app);
  return teardownLine(
    "destroyed",
    result.app,
    result.servicesDestroyed,
    volumesTrailer(result.volumesRemoved),
  );
};
