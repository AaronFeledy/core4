import type { GlobalUninstallResult } from "@lando/engine/operations/global-uninstall";

export {
  type GlobalUninstallOptions,
  type GlobalUninstallResult,
  GlobalUninstallResultSchema,
  globalUninstall,
} from "@lando/engine/operations/global-uninstall";

export const renderGlobalUninstallResult = (result: GlobalUninstallResult): string => {
  const services =
    result.contributionsDisabled.length === 0 ? "none" : result.contributionsDisabled.join(", ");
  return [
    "Global service contributions disabled.",
    `Generated dist Landofile: ${result.dist.path} (${result.dist.status})`,
    `Services disabled: ${services}`,
    "Named volumes preserved.",
  ].join("\n");
};
