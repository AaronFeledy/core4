import { Flags } from "@oclif/core";

import type { ConfigService, RuntimeProviderRegistry } from "@lando/sdk/services";

import {
  type DoctorReport,
  doctorReport,
  renderDoctorReport,
  renderDoctorReportAsJson,
  renderDoctorReportAsNdjson,
  renderDoctorReportAsYaml,
} from "../../../commands/doctor-report.ts";
import type { DoctorOptions } from "../../../commands/doctor.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const inputDoctorOptions = (input: unknown): DoctorOptions => {
  if (typeof input !== "object" || input === null) return {};
  const flags = (
    input as {
      flags?: { provider?: unknown; fix?: unknown; app?: unknown; deprecations?: unknown; format?: unknown };
    }
  ).flags;
  const provider = typeof flags?.provider === "string" ? flags.provider : undefined;
  const fix = flags?.fix === true;
  const app = flags?.app === true;
  const deprecations = flags?.deprecations === true;
  const format =
    flags?.format === "json" || flags?.format === "yaml" || flags?.format === "text"
      ? flags.format
      : undefined;
  return {
    ...(provider === undefined || provider.length === 0 ? {} : { flagProviderId: provider }),
    ...(fix ? { fix: true } : {}),
    ...(app ? { app: true } : {}),
    ...(deprecations ? { deprecations: true } : {}),
    ...(format === undefined ? {} : { format }),
  };
};

const renderDoctorReportForInput = (report: DoctorReport, input: unknown): string => {
  const options = inputDoctorOptions(input);
  if (options.format === "json") return renderDoctorReportAsJson(report);
  if (options.format === "yaml") return renderDoctorReportAsYaml(report);
  const rendererMode = (input as { readonly rendererMode?: unknown } | undefined)?.rendererMode;
  return rendererMode === "json" ? renderDoctorReportAsNdjson(report) : renderDoctorReport(report);
};

const suppressDeprecationDiagnosticsForInput = (input: unknown): boolean => {
  const options = inputDoctorOptions(input);
  return options.format === "json" || options.format === "yaml";
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
  render: (result, input) => renderDoctorReportForInput(result as DoctorReport, input),
  suppressDeprecationDiagnostics: suppressDeprecationDiagnosticsForInput,
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
    deprecations: Flags.boolean({
      description: "Also report deprecated surfaces used by the current app and loaded plugins.",
      default: false,
    }),
    format: Flags.string({
      description: "Output format for doctor reports.",
      options: ["text", "json", "yaml"],
      default: "text",
    }),
  };
  static override landoSpec: LandoCommandSpec = metaDoctorSpec;
  static override bootstrap = metaDoctorSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaDoctorSpec);
  }
}
