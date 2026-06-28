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
import type { RenderContext } from "../../../renderer-boundary.ts";

import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../command-base.ts";

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

const renderDoctorReportForInput = (report: DoctorReport, input: unknown, ctx?: RenderContext): string => {
  const options = inputDoctorOptions(input);
  const format = ctx?.format ?? options.format;
  if (format === "json") return renderDoctorReportAsJson(report);
  if (format === "ndjson") return renderDoctorReportAsNdjson(report);
  if (format === "yaml") return renderDoctorReportAsYaml(report);
  return renderDoctorReport(report, ctx);
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
  resultSchema: EmptyResultSchema,
  id: "meta:doctor",
  summary: "Run diagnostics for app config, host/provider setup, and plugin-contributed checks.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "provider",
  run: (input) => doctorReport(inputDoctorOptions(input)),
  render: (result, input, ctx) => renderDoctorReportForInput(result as DoctorReport, input, ctx),
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
