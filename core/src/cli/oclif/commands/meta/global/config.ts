import { Flags } from "@oclif/core";

import {
  type GlobalConfigResult,
  globalConfig,
  renderGlobalConfigResult,
} from "../../../../commands/meta/global-config.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

const extractFormat = (input: unknown): "json" | "table" => {
  if (typeof input !== "object" || input === null) return "table";
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  return flags.format === "json" ? "json" : "table";
};

export const metaGlobalConfigSpec: LandoCommandSpec<GlobalConfigResult> = {
  id: "meta:global:config",
  summary: "Read the host-level global Lando app Landofile stack.",
  namespace: "meta",
  topLevelAlias: "global:config",
  bootstrap: "global",
  run: () => globalConfig(),
  render: (result, input) => renderGlobalConfigResult(result as GlobalConfigResult, extractFormat(input)),
};

export default class MetaGlobalConfigCommand extends LandoCommandBase {
  static override description = metaGlobalConfigSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalConfigSpec)];
  static override flags = {
    format: Flags.string({
      description: "Output format.",
      options: ["table", "json"],
      default: "table",
    }),
  };
  static override landoSpec: LandoCommandSpec = metaGlobalConfigSpec;
  static override bootstrap = metaGlobalConfigSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaGlobalConfigSpec);
  }
}
