import { Args, Flags } from "../../../spec/metadata";

import {
  type GlobalUninstallOptions,
  type GlobalUninstallResult,
  GlobalUninstallResultSchema,
  globalUninstall,
  renderGlobalUninstallResult,
} from "../../../commands/meta/global-uninstall";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const globalUninstallOptionsFromInput = (input: unknown): GlobalUninstallOptions => {
  if (typeof input !== "object" || input === null) return {};
  const args = (input as { args?: Record<string, unknown> }).args ?? {};
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  return {
    ...(typeof args.plugin === "string" ? { plugin: args.plugin } : {}),
    purge: flags.purge === true,
  };
};

export const metaGlobalUninstallSpec: LandoCommandSpec<GlobalUninstallResult> = {
  resultSchema: GlobalUninstallResultSchema,
  id: "meta:global:uninstall",
  summary: "Clear generated services from the host-level global Lando app.",
  description: "Clear generated services from the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:uninstall",
  bootstrap: "global",
  args: {
    plugin: Args.string({
      description: "Plugin name for future global-service disablement.",
      required: false,
    }),
  },
  flags: {
    purge: Flags.boolean({
      description: "Also remove global service provider resources and data volumes before clearing services.",
      default: false,
    }),
  },
  run: (input) => globalUninstall(globalUninstallOptionsFromInput(input)),
  render: (result) => renderGlobalUninstallResult(result as GlobalUninstallResult),
};
