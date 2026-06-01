import { Args, Flags } from "@oclif/core";

import {
  type GlobalUninstallOptions,
  type GlobalUninstallResult,
  globalUninstall,
  renderGlobalUninstallResult,
} from "../../../../commands/meta/global-uninstall.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

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
  id: "meta:global:uninstall",
  summary: "Clear generated services from the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:uninstall",
  bootstrap: "global",
  run: (input) => globalUninstall(globalUninstallOptionsFromInput(input)),
  render: (result) => renderGlobalUninstallResult(result as GlobalUninstallResult),
};

export default class MetaGlobalUninstallCommand extends LandoCommandBase {
  static override description = metaGlobalUninstallSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalUninstallSpec)];
  static override args = {
    plugin: Args.string({
      description: "Plugin name for future global-service disablement.",
      required: false,
    }),
  };
  static override flags = {
    purge: Flags.boolean({
      description: "Also remove global service provider resources and data volumes before clearing services.",
      default: false,
    }),
  };
  static override landoSpec: LandoCommandSpec = metaGlobalUninstallSpec;
  static override bootstrap = metaGlobalUninstallSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaGlobalUninstallSpec);
  }
}
