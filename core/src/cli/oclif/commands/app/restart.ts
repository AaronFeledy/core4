import { type RestartAppResult, renderRestartAppResult, restartApp } from "../../../commands/restart.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const restartSpec: LandoCommandSpec<RestartAppResult> = {
  id: "app:restart",
  summary: "Restart the current app (stop + start).",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => restartApp(),
  render: (result) => renderRestartAppResult(result as RestartAppResult),
};

export default class RestartCommand extends LandoCommandBase {
  static override description = restartSpec.summary;
  static override aliases = [...resolveTopLevelAliases(restartSpec)];
  static override landoSpec: LandoCommandSpec = restartSpec;
  static override bootstrap = restartSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(restartSpec);
  }
}
