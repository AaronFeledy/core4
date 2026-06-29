import { Args } from "@oclif/core";

import {
  type GlobalInstallOptions,
  type GlobalInstallResult,
  GlobalInstallResultSchema,
  globalInstall,
  renderGlobalInstallResult,
} from "../../../../commands/meta/global-install.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const globalInstallOptionsFromInput = (input: unknown): GlobalInstallOptions => {
  if (typeof input !== "object" || input === null) return {};
  const args = (input as { args?: Record<string, unknown> }).args ?? {};
  return typeof args.plugin === "string" ? { plugin: args.plugin } : {};
};

export const metaGlobalInstallSpec: LandoCommandSpec<GlobalInstallResult> = {
  resultSchema: GlobalInstallResultSchema,
  id: "meta:global:install",
  summary: "Materialize the host-level global Lando app Landofile stack.",
  namespace: "meta",
  topLevelAlias: "global:install",
  bootstrap: "global",
  run: (input) => globalInstall(globalInstallOptionsFromInput(input)),
  render: (result) => renderGlobalInstallResult(result as GlobalInstallResult),
};

export default class MetaGlobalInstallCommand extends LandoCommandBase {
  static override description = metaGlobalInstallSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalInstallSpec)];
  static override args = {
    plugin: Args.string({
      description: "Plugin name for future global-service enablement.",
      required: false,
    }),
  };
  static override landoSpec: LandoCommandSpec = metaGlobalInstallSpec;
  static override bootstrap = metaGlobalInstallSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaGlobalInstallSpec);
  }
}
