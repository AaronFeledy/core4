/**
 */
import { Effect } from "effect";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const metaDoctorSpec: LandoCommandSpec<never> = {
  id: "meta:doctor",
  summary: "Run diagnostics for app config, host/provider setup, and plugin-contributed checks.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "plugins",
  run: () => Effect.die("not yet implemented: meta:doctor"),
};

export default class MetaDoctorCommand extends LandoCommandBase {
  static override description = metaDoctorSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaDoctorSpec)];
  static override landoSpec: LandoCommandSpec = metaDoctorSpec;

  override async run(): Promise<void> {
    await this.runEffect(metaDoctorSpec);
  }
}
