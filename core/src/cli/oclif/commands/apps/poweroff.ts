import { type PoweroffResult, poweroff } from "../../../commands/poweroff.ts";
/**
 * `lando apps:poweroff` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const poweroffSpec: LandoCommandSpec<PoweroffResult> = {
  id: "apps:poweroff",
  summary: "Stop every Lando-managed service across apps.",
  namespace: "apps",
  topLevelAlias: true,
  bootstrap: "provider",
  run: () => poweroff(),
};

export default class PoweroffCommand extends LandoCommandBase {
  static override description = poweroffSpec.summary;
  static override aliases = [...resolveTopLevelAliases(poweroffSpec)];
  static override landoSpec: LandoCommandSpec = poweroffSpec;

  override async run(): Promise<void> {
    await this.runEffect(poweroffSpec);
  }
}
