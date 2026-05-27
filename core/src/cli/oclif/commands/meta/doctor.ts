import { Flags } from "@oclif/core";

import type { ConfigService, RuntimeProviderRegistry } from "@lando/sdk/services";

import {
  type DoctorOptions,
  type DoctorResult,
  doctor,
  renderDoctorResult,
} from "../../../commands/doctor.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

const inputDoctorOptions = (input: unknown): DoctorOptions => {
  if (typeof input !== "object" || input === null) return {};
  if (!("flags" in input)) return {};
  const flags = (input as { flags?: unknown }).flags;
  if (typeof flags !== "object" || flags === null) return {};
  const provider =
    "provider" in flags && typeof (flags as { provider?: unknown }).provider === "string"
      ? (flags as { provider: string }).provider
      : undefined;
  return provider === undefined || provider.length === 0 ? {} : { flagProviderId: provider };
};

export const metaDoctorSpec: LandoCommandSpec<
  DoctorResult,
  unknown,
  ConfigService | RuntimeProviderRegistry
> = {
  id: "meta:doctor",
  summary: "Run diagnostics for app config, host/provider setup, and plugin-contributed checks.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "provider",
  run: (input) => doctor(inputDoctorOptions(input)),
  render: (result) => renderDoctorResult(result as DoctorResult),
};

export default class MetaDoctorCommand extends LandoCommandBase {
  static override description = metaDoctorSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaDoctorSpec)];
  static override flags = {
    provider: Flags.string({
      description: "Report what would be selected if `--provider=…` were used (e.g. lando, docker, podman).",
    }),
  };
  static override landoSpec: LandoCommandSpec = metaDoctorSpec;
  static override bootstrap = metaDoctorSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaDoctorSpec);
  }
}
