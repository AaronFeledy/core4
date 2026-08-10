import { type StopAppResult, StopAppResultSchema, stopApp } from "@lando/engine/operations/stop";
import { renderStopAppResult } from "../../commands/stop";
/**
 * `lando app:stop` — native command metadata adapter.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../spec/command-base";

export const stopSpec: LandoCommandSpec<StopAppResult> = {
  resultSchema: StopAppResultSchema,
  id: "app:stop",
  mcpAllowed: true,
  summary: "Stop the current Lando app.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => stopApp(),
  render: (result) => renderStopAppResult(result as StopAppResult),
};

export default class StopCommand extends LandoCommandBase {
  static override description = stopSpec.summary;
  static override aliases = [...resolveTopLevelAliases(stopSpec)];
  static override landoSpec: LandoCommandSpec = stopSpec;
  static override bootstrap = stopSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(stopSpec);
  }
}
