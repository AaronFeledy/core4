import { Flags } from "@oclif/core";

import type { ConfigService, RuntimeProviderRegistry } from "@lando/sdk/services";

import {
  type DoctorReport,
  doctorReport,
  renderDoctorReport,
  renderDoctorReportAsNdjson,
} from "../../../commands/doctor-report.ts";
import type { DoctorOptions } from "../../../commands/doctor.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const inputDoctorOptions = (input: unknown): DoctorOptions => {
  if (typeof input !== "object" || input === null) return {};
  const flags = (input as { flags?: { provider?: unknown; fix?: unknown; app?: unknown } }).flags;
  const provider = typeof flags?.provider === "string" ? flags.provider : undefined;
  const fix = flags?.fix === true;
  const app = flags?.app === true;
  return {
    ...(provider === undefined || provider.length === 0 ? {} : { flagProviderId: provider }),
    ...(fix ? { fix: true } : {}),
    ...(app ? { app: true } : {}),
  };
};

export const metaDoctorSpec: LandoCommandSpec<
  DoctorReport,
  unknown,
  ConfigService | RuntimeProviderRegistry
> = {
  id: "meta:doctor",
  summary: "Run diagnostics for app config, host/provider setup, and plugin-contributed checks.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "provider",
  run: (input) => doctorReport(inputDoctorOptions(input)),
  render: (result, input) => {
    const report = result as DoctorReport;
    const rendererMode = (input as { readonly rendererMode?: unknown } | undefined)?.rendererMode;
    return rendererMode === "json" ? renderDoctorReportAsNdjson(report) : renderDoctorReport(report);
  },
};

export default class MetaDoctorCommand extends LandoCommandBase {
  static override description = metaDoctorSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaDoctorSpec)];
  static override flags = {
    provider: Flags.string({
      description: "Report what would be selected if `--provider=…` were used (e.g. lando, docker, podman).",
    }),
    fix: Flags.boolean({
      description: "Re-run the setup step of each degraded subsystem whose recovery is safe to automate.",
      default: false,
    }),
    app: Flags.boolean({
      description: "Also lint the current app's Landofile against the canonical schema.",
      default: false,
    }),
  };
  static override landoSpec: LandoCommandSpec = metaDoctorSpec;
  static override bootstrap = metaDoctorSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaDoctorSpec);
  }
}
