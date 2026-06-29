/**
 * Combined `lando doctor` report.
 *
 * Merges provider, subsystem, and global-app diagnostics into a single report
 * without requiring app bootstrap.
 */
import { Effect, Option, Schema } from "effect";

import { emitLandofileYaml } from "@lando/sdk/landofile";
import {
  ConfigLintResult,
  type DeprecationNotice,
  DeprecationSeverity,
  DeprecationSurfaceKind,
} from "@lando/sdk/schema";
import { type ConfigService, DeprecationService, type RuntimeProviderRegistry } from "@lando/sdk/services";

import { lintLandofile } from "../../landofile/lint.ts";
import { type RenderContext, isDecoratedContext } from "../renderer-boundary.ts";
import {
  type SummaryDocument,
  type SummaryRow,
  type SummarySection,
  type SummaryTone,
  formatSummary,
  worstSummaryTone,
} from "../renderer/summary.ts";
import { renderConfigLintViolation } from "./config-lint-rendering.ts";
import {
  DefaultGlobalAppDoctorLayer,
  type GlobalAppDoctorResult,
  globalAppDoctor,
  renderGlobalAppDoctorResult,
  renderGlobalAppDoctorResultAsNdjson,
} from "./doctor-global-app.ts";
import {
  DefaultSubsystemDoctorLayer,
  type SubsystemDoctorResult,
  renderSubsystemDoctorResult,
  renderSubsystemDoctorResultAsNdjson,
  subsystemDoctor,
} from "./doctor-subsystems.ts";
import {
  type DoctorError,
  type DoctorOptions,
  type DoctorResult,
  doctor,
  renderDoctorResult,
  renderDoctorResultAsNdjson,
} from "./doctor.ts";

export interface DoctorReport {
  readonly provider: DoctorResult;
  readonly subsystems: SubsystemDoctorResult;
  readonly globalApp: GlobalAppDoctorResult;
  readonly deprecations?: DoctorDeprecationReport;
  /** Present only under `lando doctor --app`; reuses the `app:config:lint` pass. */
  readonly appConfig?: ConfigLintResult;
}

export interface DoctorDeprecationEntry {
  readonly kind: DeprecationSurfaceKind;
  readonly id: string;
  readonly severity: DeprecationNotice["severity"];
  readonly since: string;
  readonly removeIn?: string;
  readonly replacement?: string;
  readonly note: string;
  readonly docsUrl?: string;
  readonly source: string;
  readonly count: number;
}

export interface DoctorDeprecationReport {
  readonly entries: ReadonlyArray<DoctorDeprecationEntry>;
}

const DoctorStatusSchema = Schema.Literal("pass", "warn", "fail");
const DoctorSeveritySchema = Schema.Literal("info", "warn", "error");
const DoctorSolutionSchema = Schema.Struct({
  kind: Schema.Literal("automatic", "manual"),
  description: Schema.String,
  command: Schema.optional(Schema.String),
});
const DoctorRuntimeSchema = Schema.Struct({
  running: Schema.Boolean,
  message: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
});
const DoctorSelectionRecordSchema = Schema.Struct({
  providerId: Schema.String,
  source: Schema.Literal("flag", "landofile", "env", "config", "default"),
  inputs: Schema.Struct({
    flag: Schema.optional(Schema.String),
    landofile: Schema.optional(Schema.String),
    env: Schema.optional(Schema.String),
    config: Schema.optional(Schema.String),
    capabilityDefault: Schema.String,
  }),
});
const DoctorCheckSchema = Schema.Struct({
  name: Schema.String,
  status: DoctorStatusSchema,
  severity: DoctorSeveritySchema,
  providerId: Schema.String,
  providerName: Schema.String,
  providerVersion: Schema.String,
  providerKind: Schema.Literal("managed", "user-installed"),
  runtimeStatus: Schema.String,
  runtime: DoctorRuntimeSchema,
  capabilities: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  context: Schema.Record({ key: Schema.String, value: Schema.String }),
  solutions: Schema.Array(DoctorSolutionSchema),
  selection: Schema.optional(DoctorSelectionRecordSchema),
});
const DoctorResultSchema = Schema.Struct({
  checks: Schema.Array(DoctorCheckSchema),
});
const DoctorSubsystemCheckSchema = Schema.Struct({
  name: Schema.String,
  status: DoctorStatusSchema,
  severity: DoctorSeveritySchema,
  recovery: Schema.Literal("automatic", "manual"),
  context: Schema.Record({ key: Schema.String, value: Schema.String }),
  solutions: Schema.Array(DoctorSolutionSchema),
});
const SubsystemDoctorResultSchema = Schema.Struct({
  checks: Schema.Array(DoctorSubsystemCheckSchema),
});
const GlobalAppDoctorCheckSchema = Schema.Struct({
  name: Schema.Literal("global-app"),
  status: DoctorStatusSchema,
  severity: DoctorSeveritySchema,
  context: Schema.Record({ key: Schema.String, value: Schema.String }),
  solutions: Schema.Array(DoctorSolutionSchema),
});
const GlobalAppDoctorResultSchema = Schema.Struct({
  checks: Schema.Array(GlobalAppDoctorCheckSchema),
});
const DoctorDeprecationEntrySchema = Schema.Struct({
  kind: DeprecationSurfaceKind,
  id: Schema.String,
  severity: DeprecationSeverity,
  since: Schema.String,
  removeIn: Schema.optional(Schema.String),
  replacement: Schema.optional(Schema.String),
  note: Schema.String,
  docsUrl: Schema.optional(Schema.String),
  source: Schema.String,
  count: Schema.Number,
});
const DoctorDeprecationReportSchema = Schema.Struct({
  entries: Schema.Array(DoctorDeprecationEntrySchema),
});

export const DoctorReportSchema = Schema.Struct({
  provider: DoctorResultSchema,
  subsystems: SubsystemDoctorResultSchema,
  globalApp: GlobalAppDoctorResultSchema,
  deprecations: Schema.optional(DoctorDeprecationReportSchema),
  appConfig: Schema.optional(ConfigLintResult),
});

const appConfigForReport = (): Effect.Effect<ConfigLintResult, never, never> =>
  lintLandofile().pipe(
    Effect.catchTag("LandofileNotFoundError", (error) =>
      Effect.succeed({
        app: "",
        file: "(none)",
        valid: false,
        violations: [{ path: "", message: error.message }],
      } satisfies ConfigLintResult),
    ),
  );

const sourceForDeprecation = (entry: {
  readonly app?: string | undefined;
  readonly plugin?: string | undefined;
}): string => {
  if (entry.plugin !== undefined && entry.plugin.length > 0) return `plugin:${entry.plugin}`;
  if (entry.app !== undefined && entry.app.length > 0) return `app:${entry.app}`;
  return "core";
};

const doctorDeprecations = (): Effect.Effect<DoctorDeprecationReport, never, never> =>
  Effect.gen(function* () {
    const maybeDeprecations = yield* Effect.serviceOption(DeprecationService);
    if (Option.isNone(maybeDeprecations)) return { entries: [] };
    const deprecations = maybeDeprecations.value;
    const summary = yield* deprecations.summary();
    const entries: DoctorDeprecationEntry[] = [];
    for (const entry of summary) {
      const lookup = yield* deprecations.lookup(entry.kind, entry.id);
      const notice = Option.getOrElse(lookup, () => entry.notice);
      entries.push({
        kind: entry.kind,
        id: entry.id,
        severity: notice.severity,
        since: notice.since,
        ...(notice.removeIn === undefined ? {} : { removeIn: notice.removeIn }),
        ...(notice.replacement === undefined ? {} : { replacement: notice.replacement }),
        note: notice.note,
        ...(notice.docsUrl === undefined ? {} : { docsUrl: notice.docsUrl }),
        source: sourceForDeprecation(entry),
        count: entry.count,
      });
    }
    entries.sort((left, right) =>
      left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind.localeCompare(right.kind),
    );
    return { entries };
  });

export const doctorReport = (
  options: DoctorOptions = {},
): Effect.Effect<DoctorReport, DoctorError, ConfigService | RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const provider = yield* doctor(options);
    const subsystems = yield* subsystemDoctor({ fix: options.fix === true }).pipe(
      Effect.provide(DefaultSubsystemDoctorLayer),
    );
    const globalApp = yield* globalAppDoctor().pipe(Effect.provide(DefaultGlobalAppDoctorLayer));
    const deprecations = options.deprecations === true ? yield* doctorDeprecations() : undefined;
    const appConfig = options.app === true ? yield* appConfigForReport() : undefined;
    return {
      provider,
      subsystems,
      globalApp,
      ...(deprecations === undefined ? {} : { deprecations }),
      ...(appConfig === undefined ? {} : { appConfig }),
    };
  });

interface DoctorCheckLike {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail";
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<{
    readonly kind: string;
    readonly description: string;
    readonly command?: string;
  }>;
}

const doctorStatusTone = (status: DoctorCheckLike["status"]): SummaryTone =>
  status === "pass" ? "ok" : status === "warn" ? "warn" : "error";

const checkToRow = (check: DoctorCheckLike): SummaryRow => {
  const solutions = check.solutions.map(
    (solution) => `${solution.description}${solution.command === undefined ? "" : ` (${solution.command})`}`,
  );
  return {
    label: check.name,
    tone: doctorStatusTone(check.status),
    value: check.status,
    fields: Object.entries(check.context).map(([label, value]) => ({ label, value })),
    ...(solutions.length === 0 ? {} : { detail: solutions.join(" · ") }),
  };
};

const checkSection = (title: string, checks: ReadonlyArray<DoctorCheckLike>): SummarySection => ({
  title,
  rows: checks.map(checkToRow),
  ...(checks.length === 0 ? { notes: ["No checks reported."] } : {}),
});

const deprecationsSection = (report: DoctorDeprecationReport): SummarySection => ({
  title: "deprecations",
  rows: report.entries.map((entry) => ({
    label: `${entry.kind} ${entry.id}`,
    tone: entry.severity === "error" ? "error" : entry.severity === "warn" ? "warn" : "info",
    value: `${entry.count} ${entry.count === 1 ? "use" : "uses"}`,
    fields: [
      { label: "since", value: entry.since },
      { label: "removeIn", value: valueOrDash(entry.removeIn) },
      { label: "replacement", value: valueOrDash(entry.replacement) },
      { label: "source", value: entry.source },
    ],
    detail: entry.note,
  })),
  ...(report.entries.length === 0
    ? { notes: ["No deprecations were used or triggered at runtime for the app."] }
    : {}),
});

const appConfigSection = (result: ConfigLintResult): SummarySection => ({
  title: "app config",
  rows: [
    {
      label: "lint",
      tone: result.valid ? "ok" : "error",
      value: result.valid ? "pass" : "fail",
      fields: [{ label: "file", value: result.file }],
    },
  ],
  ...(result.violations.length === 0 ? {} : { notes: result.violations.map(renderConfigLintViolation) }),
});

const countByStatus = (report: DoctorReport): { readonly checks: number; readonly failed: number } => {
  const checks = [...report.provider.checks, ...report.subsystems.checks, ...report.globalApp.checks];
  const appConfigInvalid = report.appConfig !== undefined && !report.appConfig.valid;
  return {
    checks: checks.length + (report.appConfig === undefined ? 0 : 1),
    failed: checks.filter((check) => check.status === "fail").length + (appConfigInvalid ? 1 : 0),
  };
};

export const buildDoctorReportSummary = (report: DoctorReport): SummaryDocument => {
  const sections: SummarySection[] = [
    checkSection("provider", report.provider.checks),
    checkSection("subsystems", report.subsystems.checks),
    checkSection("global app", report.globalApp.checks),
  ];
  if (report.deprecations !== undefined) sections.push(deprecationsSection(report.deprecations));
  if (report.appConfig !== undefined) sections.push(appConfigSection(report.appConfig));
  const counts = countByStatus(report);
  const rowTones = sections.flatMap((section) => section.rows.map((row) => row.tone ?? "info"));
  return {
    title: "DOCTOR",
    tone: rowTones.length === 0 ? "info" : worstSummaryTone(rowTones),
    sections,
    footer: `${counts.checks} checks · ${counts.failed} failed`,
  };
};

export const renderDoctorReport = (report: DoctorReport, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx))
    return formatSummary(buildDoctorReportSummary(report), { columns: ctx?.columns });
  const provider = renderDoctorResult(report.provider);
  const subsystems = renderSubsystemDoctorResult(report.subsystems);
  const globalApp = renderGlobalAppDoctorResult(report.globalApp);
  const deprecations =
    report.deprecations === undefined ? "" : renderDeprecationsSection(report.deprecations);
  const appConfig = report.appConfig === undefined ? "" : renderAppConfigSection(report.appConfig);
  const parts = [provider, subsystems, globalApp, deprecations, appConfig].filter((part) => part.length > 0);
  return parts.join("\n");
};

const valueOrDash = (value: string | undefined): string =>
  value === undefined || value === "" ? "-" : value;

const renderDeprecationsSection = (report: DoctorDeprecationReport): string => {
  const lines = ["deprecations:"];
  if (report.entries.length === 0) {
    lines.push("No deprecations were used or triggered at runtime for the app.");
    return lines.join("\n");
  }
  lines.push("kind | id | severity | since | removeIn | replacement | note | docsUrl | source | count");
  for (const entry of report.entries) {
    lines.push(
      [
        entry.kind,
        entry.id,
        entry.severity,
        entry.since,
        valueOrDash(entry.removeIn),
        valueOrDash(entry.replacement),
        entry.note,
        valueOrDash(entry.docsUrl),
        entry.source,
        String(entry.count),
      ].join(" | "),
    );
  }
  return lines.join("\n");
};

export const renderDoctorReportAsYaml = (report: DoctorReport): string =>
  emitLandofileYaml(report as unknown as Record<string, unknown>);

const renderAppConfigSection = (result: ConfigLintResult): string => {
  const lines = [`app-config-lint: ${result.valid ? "pass" : "fail"}`, `file: ${result.file}`];
  lines.push(...result.violations.map(renderConfigLintViolation));
  return lines.join("\n");
};

const doctorCheckFrameLine = (payload: Record<string, unknown>): string =>
  JSON.stringify({ _tag: "event", event: "doctor.check", payload });

const appConfigCheckLine = (result: ConfigLintResult): string =>
  doctorCheckFrameLine({
    _tag: "doctor.check",
    name: "app-config-lint",
    status: result.valid ? "pass" : "fail",
    severity: result.valid ? "info" : "error",
    context: {
      file: result.file,
      valid: String(result.valid),
      violations: String(result.violations.length),
    },
    violations: result.violations,
  });

const deprecationsCheckLine = (result: DoctorDeprecationReport): string =>
  doctorCheckFrameLine({
    _tag: "doctor.check",
    name: "deprecations",
    status: "pass",
    severity: "info",
    context: { entries: String(result.entries.length) },
    entries: result.entries,
  });

export interface DoctorReportNdjsonOptions {
  readonly now?: Date;
}

const checkLinesFromNdjson = (ndjson: string): ReadonlyArray<string> =>
  ndjson
    .trimEnd()
    .split("\n")
    .filter((line) => (JSON.parse(line) as { readonly _tag?: unknown })._tag === "event");

export const renderDoctorReportAsNdjson = (
  report: DoctorReport,
  options: DoctorReportNdjsonOptions = {},
): string => {
  const timestamp = (options.now ?? new Date()).toISOString();
  const now = new Date(timestamp);
  const lines: string[] = [];
  lines.push(
    ...checkLinesFromNdjson(renderDoctorResultAsNdjson(report.provider, { now })),
    ...checkLinesFromNdjson(renderSubsystemDoctorResultAsNdjson(report.subsystems, { now })),
    ...checkLinesFromNdjson(renderGlobalAppDoctorResultAsNdjson(report.globalApp, { now })),
  );
  if (report.deprecations !== undefined) lines.push(deprecationsCheckLine(report.deprecations));
  if (report.appConfig !== undefined) lines.push(appConfigCheckLine(report.appConfig));
  const checks = [...report.provider.checks, ...report.subsystems.checks, ...report.globalApp.checks];
  const deprecationsCheckCount = report.deprecations === undefined ? 0 : 1;
  const appConfigInvalid = report.appConfig !== undefined && !report.appConfig.valid;
  lines.push(
    JSON.stringify({
      _tag: "result",
      envelope: {
        apiVersion: "v4",
        command: "meta:doctor",
        ok: true,
        result: {
          timestamp,
          checks: checks.length + deprecationsCheckCount + (report.appConfig === undefined ? 0 : 1),
          failed: checks.filter((check) => check.status === "fail").length + (appConfigInvalid ? 1 : 0),
          warned: checks.filter((check) => check.status === "warn").length,
        },
        warnings: [],
        deprecations: [],
      },
    }),
  );
  return `${lines.join("\n")}\n`;
};
