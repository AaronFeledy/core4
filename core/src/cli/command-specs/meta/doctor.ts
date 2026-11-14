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
import { type DoctorViewOptions, selectDoctorView } from "../../commands/doctor-view";
import type { RenderContext } from "../../renderer-boundary";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";
import { specFlagsOf, stringArrayFlag, stringFlag } from "../../spec/input-coercion";
import { Flags } from "../../spec/metadata";

export const inputDoctorOptions = (input: unknown): DoctorOptions & DoctorViewOptions => {
  const signal = extractSpecAbortSignal(input);
  const flags = specFlagsOf(input);
  const sections = stringArrayFlag(flags, "section");
  const statuses = stringArrayFlag(flags, "status").map((status) => {
    if (status === "pass" || status === "warn" || status === "fail") return status;
    throw new MalformedCliFlagValueError({
      message: "--status has a malformed value.",
      flag: "status",
      issue: "invalid_option",
      remediation: "Supply --status with one of: pass, warn, fail.",
    });
  });
  const rawLimit = flags.limit;
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000))
    throw new MalformedCliFlagValueError({
      message: "--limit has a malformed value.",
      flag: "limit",
      issue: "invalid_integer",
      remediation: "Supply --limit with a whole integer from 1 to 1000.",
    });
  const after = stringFlag(flags, "after");
  if (
    after !== undefined &&
    (limit === undefined || !DOCTOR_SECTION_IDS.some((id) => id === after.split("/", 1)[0]))
  )
    throw new MalformedCliFlagValueError({
      message: "--after has a malformed value.",
      flag: "after",
      issue: "invalid_option",
      remediation: "Supply --after with a check id beginning with a valid section id, together with --limit.",
    });
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
    ...(statuses.length === 0 ? {} : { statuses }),
    ...(limit === undefined ? {} : { limit }),
    ...(after === undefined ? {} : { after }),
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
  return renderDoctorReport(report, ctx, {
    all: options.all || options.statuses !== undefined || options.limit !== undefined,
    selection: [
      ...(options.sections ?? []).flatMap((section) => ["--section", section]),
      ...(options.app === true ? ["--app"] : []),
      ...(options.deprecations === true ? ["--deprecations"] : []),
      ...(options.flagProviderId === undefined ? [] : ["--provider", options.flagProviderId]),
      ...(options.statuses ?? []).flatMap((status) => ["--status", status]),
    ],
  });
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
    status: Flags.string({
      description: "Include checks with this status (repeatable).",
      multiple: true,
      options: ["pass", "warn", "fail"],
    }),
    limit: Flags.integer({ description: "Return at most this many checks (1 to 1000).", min: 1 }),
    after: Flags.string({ description: "Return checks strictly after this check id; requires --limit." }),
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
    }).pipe(
      Effect.flatMap((options) =>
        resilientDoctorReport(options).pipe(Effect.map((report) => selectDoctorView(report, options))),
      ),
    ),
  render: (result, input, ctx) => renderDoctorReportForInput(result, input, ctx),
  // Findings retain the completed report; self failures also fail command completion.
  completion: doctorCompletion,
  suppressDeprecationDiagnostics: suppressDeprecationDiagnosticsForInput,
};
