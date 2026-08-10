import { type RestartAppResult, RestartAppResultSchema, restartApp } from "@lando/engine/operations/restart";
import { renderRestartAppResult } from "../../commands/restart";
import {
  LandoCommandBase,
  type LandoCommandSpec,
  extractSpecAbortSignal,
  resolveTopLevelAliases,
} from "../../spec/command-base";

export const restartSpec: LandoCommandSpec<RestartAppResult> = {
  resultSchema: RestartAppResultSchema,
  id: "app:restart",
  mcpAllowed: true,
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
