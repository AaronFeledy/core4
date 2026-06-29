import { Flags } from "@oclif/core";

import {
  type AppConfigResult,
  AppConfigResultSchema,
  appConfig,
  renderAppConfigResult,
} from "../../../../commands/app-config.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const appConfigSpec: LandoCommandSpec<AppConfigResult> = {
  resultSchema: AppConfigResultSchema,
  id: "app:config",
  summary: "Read the current app's Landofile.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "app",
  run: () => appConfig(),
  render: (result) => renderAppConfigResult(result as AppConfigResult, "table"),
};

export default class AppConfigCommand extends LandoCommandBase {
  static override description = appConfigSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appConfigSpec)];
  static override flags = {
    format: Flags.string({
      description: "Output format.",
      options: ["table", "json"],
      default: "table",
    }),
  };
  static override landoSpec: LandoCommandSpec = appConfigSpec;
  static override bootstrap = appConfigSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appConfigSpec);
  }
}
