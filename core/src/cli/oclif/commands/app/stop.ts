import { type StopAppResult, renderStopAppResult, stopApp } from "../../../commands/stop.ts";
/**
 * `lando app:stop` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const stopSpec: LandoCommandSpec<StopAppResult> = {
  id: "app:stop",
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
