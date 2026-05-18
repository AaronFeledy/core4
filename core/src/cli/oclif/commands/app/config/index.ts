import { type AppConfigResult, appConfig, renderAppConfigResult } from "../../../../commands/app-config.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

export const appConfigSpec: LandoCommandSpec<AppConfigResult> = {
  id: "app:config",
  summary: "Read the current app's Landofile.",
  namespace: "app",
  topLevelAlias: false,
  bootstrap: "app",
  run: () => appConfig(),
  render: (result) => renderAppConfigResult(result as AppConfigResult),
};

export default class AppConfigCommand extends LandoCommandBase {
  static override description = appConfigSpec.summary;
  static override aliases = [...resolveTopLevelAliases(appConfigSpec)];
  static override landoSpec: LandoCommandSpec = appConfigSpec;
  static override bootstrap = appConfigSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(appConfigSpec);
  }
}
