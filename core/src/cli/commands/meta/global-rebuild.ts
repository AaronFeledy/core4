import type { GlobalRebuildResult } from "@lando/engine/operations/global-rebuild";
import { joinServiceRows, lifecycleLine } from "../service-summary";
import { renderGlobalServiceRow } from "./global-common";

export const renderGlobalRebuildResult = (result: GlobalRebuildResult): string => {
  if (!result.materialized) return "global app is not installed";
  const services = joinServiceRows(result.servicesRebuilt.map(renderGlobalServiceRow));
  return lifecycleLine("rebuilt", result.app, services.length === 0 ? "no services" : services);
};
