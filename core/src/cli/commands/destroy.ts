/** `lando destroy` result rendering. */
import type { DestroyAppResult } from "@lando/sdk/app";

export const renderDestroyAppResult = (result: DestroyAppResult): string => {
  if (result.outcome === "unchanged") return `unchanged: ${result.app} - no services`;
  const services =
    result.servicesDestroyed.length === 0 ? "no services" : result.servicesDestroyed.join(", ");
  const trailer = result.volumesRemoved ? "volumes removed" : "volumes preserved";
  return `destroyed: ${result.app} - ${services} (${trailer})`;
};
