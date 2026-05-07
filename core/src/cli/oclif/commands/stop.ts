import { type StopAppResult, stopApp } from "../../commands/stop.ts";
/**
 * `lando stop` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const stopSpec: LandoCommandSpec<StopAppResult> = {
  id: "stop",
  summary: "Stop the current Lando app.",
  bootstrap: "app",
  run: () => stopApp(),
};

export default class StopCommand extends LandoCommandBase {
  static override description = stopSpec.summary;
  static override landoSpec: LandoCommandSpec = stopSpec;

  override async run(): Promise<void> {
    await this.runEffect(stopSpec);
  }
}
