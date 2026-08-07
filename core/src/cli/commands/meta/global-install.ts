import type { GlobalInstallResult } from "../../../operations/global-install.ts";

export const renderGlobalInstallResult = (result: GlobalInstallResult): string =>
  [
    "Global app Landofile stack materialized.",
    `Generated dist Landofile: ${result.dist.path} (${result.dist.status})`,
    `User Landofile: ${result.paths.userLandofile} (${result.userLandofileCreated ? "created" : "preserved"})`,
    `Global services: ${result.dist.serviceIds.length === 0 ? "none" : result.dist.serviceIds.join(", ")}`,
  ].join("\n");
