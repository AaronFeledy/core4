import { Flags } from "../../../spec/metadata";

import type { DoctorOptions } from "../../../commands/doctor";
import { resilientDoctorReport } from "../../../commands/doctor-bootstrap";
import {
  type DoctorReport,
  DoctorReportSchema,
  renderDoctorReport,
  renderDoctorReportAsNdjson,
  renderDoctorReportAsYaml,
} from "../../../commands/doctor-report";
import type { RenderContext } from "../../../renderer-boundary";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../spec/command-base";

export const inputDoctorOptions = (input: unknown): DoctorOptions => {
  if (typeof input !== "object" || input === null) return {};
  const signal = (input as { readonly signal?: unknown }).signal;
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
    ...(signal instanceof AbortSignal ? { signal } : {}),
  };
};

const renderDoctorReportForInput = (report: DoctorReport, input: unknown, ctx?: RenderContext): string => {
  const options = inputDoctorOptions(input);
  const format = ctx?.format ?? options.format;
  if (format === "ndjson") return renderDoctorReportAsNdjson(report);
  if (format === "yaml") return renderDoctorReportAsYaml(report);
  return renderDoctorReport(report, ctx);
};

const suppressDeprecationDiagnosticsForInput = (input: unknown): boolean => {
  const options = inputDoctorOptions(input);
  return options.format === "json" || options.format === "yaml";
};

/**
 * Doctor bootstraps at `none` and builds the `provider` runtime inside its own
 * program (see `doctor-bootstrap.ts`) so a bootstrap failure is reported as a
 * self check instead of leaving the user with no diagnostics.
 */
export const metaDoctorSpec: LandoCommandSpec<DoctorReport, unknown, never> = {
  resultSchema: DoctorReportSchema,
  id: "meta:doctor",
  mcpAllowed: true,
  summary: "Run diagnostics for app config, host/provider setup, and plugin-contributed checks.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "none",
  run: (input) => resilientDoctorReport(inputDoctorOptions(input)),
  render: (result, input, ctx) => renderDoctorReportForInput(result as DoctorReport, input, ctx),
  // A `self` check means doctor could not complete a section, which must not
  // look like a clean run to a script or agent reading the exit code.
  successExitCode: (result) => ((result as DoctorReport).self === undefined ? undefined : 1),
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
