import { type StartAppResult, startApp } from "../../commands/start.ts";
/**
 * `lando start` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const startSpec: LandoCommandSpec<StartAppResult> = {
  id: "start",
  summary: "Start the current Lando app.",
  bootstrap: "app",
  run: () => startApp(),
};

export default class StartCommand extends LandoCommandBase {
  static override description = startSpec.summary;
  static override landoSpec: LandoCommandSpec = startSpec;

  override async run(): Promise<void> {
    await this.runEffect(startSpec);
  }
}
