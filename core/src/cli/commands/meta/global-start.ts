import type { GlobalStartResult } from "@lando/engine/operations/global-start";
import { joinServiceRows, lifecycleLine } from "../service-summary";
import { renderGlobalServiceRow } from "./global-common";

export const renderGlobalStartResult = (result: GlobalStartResult): string => {
  const services = joinServiceRows(result.servicesStarted.map(renderGlobalServiceRow));
  return lifecycleLine("ready", result.app, services);
};
