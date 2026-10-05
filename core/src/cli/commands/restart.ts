/** `lando restart` result rendering. */
import type { RestartAppResult } from "@lando/sdk/app";
import { joinServiceRows, serviceStateRow } from "./service-summary";

export const renderRestartAppResult = (result: RestartAppResult): string => {
  const services = joinServiceRows(
    result.servicesStarted.map((service) => serviceStateRow(service.name, service.state, service.endpoints)),
  );
  return `restarted: ${result.app}${services.length === 0 ? "" : ` - ${services}`}`;
};
