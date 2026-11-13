import type { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import { MalformedCliFlagValueError } from "@lando/sdk/errors";
import { Effect } from "effect";
import type { DoctorOptions } from "../../commands/doctor";
import { resilientDoctorReport } from "../../commands/doctor-bootstrap";
import { DOCTOR_SECTION_IDS } from "../../commands/doctor-contract";
import {
  type DoctorReport,
  DoctorReportSchema,
  doctorCompletion,
  renderDoctorReport,
  renderDoctorReportAsNdjson,
} from "../../commands/doctor-report";
import type { RenderContext } from "../../renderer-boundary";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";
import { specFlagsOf, stringArrayFlag, stringFlag } from "../../spec/input-coercion";
import { Flags } from "../../spec/metadata";

export const inputDoctorOptions = (input: unknown): DoctorOptions => {
  const signal = extractSpecAbortSignal(input);
  const flags = specFlagsOf(input);
  const sections = stringArrayFlag(flags, "section");
  if (sections.some((id) => !DOCTOR_SECTION_IDS.some((valid) => valid === id)))
    throw new MalformedCliFlagValueError({
      message: "--section has a malformed value.",
      flag: "section",
      issue: "invalid_option",
      remediation: `Supply --section with one of: ${DOCTOR_SECTION_IDS.join(", ")}.`,
    });
  const provider = stringFlag(flags, "provider");
  const fix = flags?.fix === true;
  const app = flags?.app === true;
  const deprecations = flags?.deprecations === true;
  const all = flags?.all === true;
  const format =
    flags?.format === "json" || flags?.format === "yaml" || flags?.format === "text"
      ? flags.format
      : undefined;
  return {
    ...(sections.length === 0 ? {} : { sections }),
    ...(provider === undefined || provider.length === 0 ? {} : { flagProviderId: provider }),
    ...(fix ? { fix: true } : {}),
    ...(app ? { app: true } : {}),
    ...(deprecations ? { deprecations: true } : {}),
    ...(all ? { all: true } : {}),
    ...(format === undefined ? {} : { format }),
    ...(signal instanceof AbortSignal ? { signal } : {}),
  };
};

const renderDoctorReportForInput = (report: DoctorReport, input: unknown, ctx?: RenderContext): string => {
  const options = inputDoctorOptions(input);
  const format = ctx?.format ?? options.format;
  if (format === "ndjson") return renderDoctorReportAsNdjson(report);
  return renderDoctorReport(report, ctx, { all: options.all });
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
export const metaDoctorSpec: LandoCommandSpec<DoctorReport, unknown, RuntimeLayerFactory> = {
  resultSchema: DoctorReportSchema,
  id: "meta:doctor",
  resultFormats: ["ndjson"],
  helpGroup: "common",
  mcpAllowed: true,
  summary: "Run diagnostics for app config, host/provider setup, and plugin-contributed checks.",
  description: "Run diagnostics for app config, host/provider setup, and plugin-contributed checks.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "none",
  flags: {
    section: Flags.string({
      description: "Run only the selected diagnostic sections (repeatable); always report global config.",
      multiple: true,
      options: DOCTOR_SECTION_IDS,
    }),
    provider: Flags.string({
      description: "Report what would be selected if `--provider=…` were used (e.g. lando, docker, podman).",
    }),
    fix: Flags.boolean({
      description: "Re-run the setup step of each degraded subsystem whose recovery is safe to automate.",
      default: false,
    }),
    app: Flags.boolean({
      description: "Also lint the current app's Landofile and check its running services' listeners.",
      default: false,
    }),
    deprecations: Flags.boolean({
      description: "Also report deprecated surfaces used by the current app and loaded plugins.",
      default: false,
    }),
    all: Flags.boolean({
      description: "List every check, including passing ones, instead of only degraded checks.",
      default: false,
    }),
    format: Flags.string({
      description: "Output format for doctor reports.",
      default: "text",
    }),
  },
  run: (input) =>
    Effect.try({
      try: () => inputDoctorOptions(input),
      catch: (error) => error,
    }).pipe(Effect.flatMap(resilientDoctorReport)),
  render: (result, input, ctx) => renderDoctorReportForInput(result, input, ctx),
  // Findings retain the completed report; self failures also fail command completion.
  completion: doctorCompletion,
  suppressDeprecationDiagnostics: suppressDeprecationDiagnosticsForInput,
};
