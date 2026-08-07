/** `lando restart` result rendering. The operation lives in `core/src/operations/restart.ts`. */
import type { RestartAppResult } from "@lando/sdk/app";

export const renderRestartAppResult = (result: RestartAppResult): string => {
  const services = result.servicesStarted
    .map((service) => {
      const endpoints = service.endpoints.length === 0 ? "no endpoints" : service.endpoints.join(", ");
      return `${service.name} (${service.state}) ${endpoints}`;
    })
    .join("; ");
  return `restarted: ${result.app}${services.length === 0 ? "" : ` - ${services}`}`;
};
