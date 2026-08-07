/** `lando destroy` result rendering. The operation lives in `core/src/operations/destroy.ts`. */
import type { DestroyAppResult } from "@lando/sdk/app";

export const renderDestroyAppResult = (result: DestroyAppResult): string => {
  const services =
    result.servicesDestroyed.length === 0 ? "no services" : result.servicesDestroyed.join(", ");
  const trailer = result.volumesRemoved ? "volumes removed" : "volumes preserved";
  return `destroyed: ${result.app} - ${services} (${trailer})`;
};
