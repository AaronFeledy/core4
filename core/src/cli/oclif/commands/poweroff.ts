import { type PoweroffResult, poweroff } from "../../commands/poweroff.ts";
/**
 * `lando poweroff` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const poweroffSpec: LandoCommandSpec<PoweroffResult> = {
  id: "poweroff",
  summary: "Stop every Lando-managed service across apps.",
  bootstrap: "provider",
  run: () => poweroff(),
};

export default class PoweroffCommand extends LandoCommandBase {
  static override description = poweroffSpec.summary;
  static override landoSpec: LandoCommandSpec = poweroffSpec;

  override async run(): Promise<void> {
    await this.runEffect(poweroffSpec);
  }
}
