import type { RuntimeProviderRegistry } from "@lando/sdk/services";

import { type DoctorResult, doctor, renderDoctorResult } from "../../../commands/doctor.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const metaDoctorSpec: LandoCommandSpec<DoctorResult, unknown, RuntimeProviderRegistry> = {
  id: "meta:doctor",
  summary: "Run diagnostics for app config, host/provider setup, and plugin-contributed checks.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "provider",
  run: () => doctor(),
  render: (result) => renderDoctorResult(result as DoctorResult),
};

export default class MetaDoctorCommand extends LandoCommandBase {
  static override description = metaDoctorSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaDoctorSpec)];
  static override landoSpec: LandoCommandSpec = metaDoctorSpec;
  static override bootstrap = metaDoctorSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaDoctorSpec);
  }
}
