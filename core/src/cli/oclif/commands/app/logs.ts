import { type LogsAppResult, logsApp, renderLogsAppResult } from "../../../commands/logs.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const logsSpec: LandoCommandSpec<LogsAppResult> = {
  id: "app:logs",
  summary: "Stream logs from the current app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => logsApp(),
  render: (result) => renderLogsAppResult(result as LogsAppResult),
};

export default class LogsCommand extends LandoCommandBase {
  static override description = logsSpec.summary;
  static override aliases = [...resolveTopLevelAliases(logsSpec)];
  static override landoSpec: LandoCommandSpec = logsSpec;
  static override bootstrap = logsSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(logsSpec);
  }
}
