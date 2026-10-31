import { Args } from "../../../spec/metadata";

import {
  type GlobalUninstallOptions,
  type GlobalUninstallResult,
  GlobalUninstallResultSchema,
  globalUninstall,
  renderGlobalUninstallResult,
} from "../../../commands/meta/global-uninstall";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { specArgsOf } from "../../../spec/input-coercion";

export const globalUninstallOptionsFromInput = (input: unknown): GlobalUninstallOptions => {
  if (typeof input !== "object" || input === null) return {};
  const args = specArgsOf(input);
  return {
    ...(typeof args.plugin === "string" ? { plugin: args.plugin } : {}),
  };
};

export const metaGlobalUninstallSpec: LandoCommandSpec<GlobalUninstallResult> = {
  resultSchema: GlobalUninstallResultSchema,
  id: "meta:global:uninstall",
  summary: "Disable global service contributions and stop their containers, preserving named volumes.",
  description: "Disable global service contributions and stop their containers, preserving named volumes.",
  namespace: "meta",
  topLevelAlias: "global:uninstall",
  bootstrap: "global",
  args: {
    plugin: Args.string({
      description: "Plugin package name or contribution id to disable; omit to disable all contributions.",
      required: false,
    }),
  },
  run: (input) => globalUninstall(globalUninstallOptionsFromInput(input)),
  render: (result) => renderGlobalUninstallResult(result),
};
