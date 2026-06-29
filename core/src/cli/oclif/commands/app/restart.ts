import {
  type RestartAppResult,
  RestartAppResultSchema,
  renderRestartAppResult,
  restartApp,
} from "../../../commands/restart.ts";
import {
  LandoCommandBase,
  type LandoCommandSpec,
  extractSpecAbortSignal,
  resolveTopLevelAliases,
} from "../../command-base.ts";

export const restartSpec: LandoCommandSpec<RestartAppResult> = {
  resultSchema: RestartAppResultSchema,
  id: "app:restart",
  summary: "Restart the current app (stop + start).",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: (input) => {
    const signal = extractSpecAbortSignal(input);
    return restartApp(signal === undefined ? {} : { signal });
  },
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
