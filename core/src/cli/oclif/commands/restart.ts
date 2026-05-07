import { type RestartAppResult, restartApp } from "../../commands/restart.ts";
/**
 * `lando restart` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const restartSpec: LandoCommandSpec<RestartAppResult> = {
  id: "restart",
  summary: "Restart the current app (stop + start).",
  bootstrap: "app",
  run: () => restartApp(),
};

export default class RestartCommand extends LandoCommandBase {
  static override description = restartSpec.summary;
  static override landoSpec: LandoCommandSpec = restartSpec;

  override async run(): Promise<void> {
    await this.runEffect(restartSpec);
  }
}
