/**
 * Combined `lando doctor` report.
 *
 * Merges provider, subsystem, and global-app diagnostics into a single report
 * without requiring app bootstrap.
 */
import { Effect, Option } from "effect";

import type { DeprecationNotice, DeprecationSurfaceKind } from "@lando/sdk/schema";
import type { ConfigLintResult } from "@lando/sdk/schema";
import { type ConfigService, DeprecationService, type RuntimeProviderRegistry } from "@lando/sdk/services";

import { lintLandofile } from "../../landofile/lint.ts";
import { emitLandofileYaml } from "../../landofile/yaml-emit.ts";
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

export const renderDoctorReport = (report: DoctorReport): string => {
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

export const renderDoctorReportAsJson = (report: DoctorReport): string => JSON.stringify(report, null, 2);

export const renderDoctorReportAsYaml = (report: DoctorReport): string =>
  emitLandofileYaml(report as unknown as Record<string, unknown>);

const renderAppConfigSection = (result: ConfigLintResult): string => {
  const lines = [`app-config-lint: ${result.valid ? "pass" : "fail"}`, `file: ${result.file}`];
  lines.push(...result.violations.map(renderConfigLintViolation));
  return lines.join("\n");
};

const appConfigCheckLine = (result: ConfigLintResult): string =>
  JSON.stringify({
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
  JSON.stringify({
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
  ndjson.trimEnd().split("\n").slice(1, -1);

export const renderDoctorReportAsNdjson = (
  report: DoctorReport,
  options: DoctorReportNdjsonOptions = {},
): string => {
  const timestamp = (options.now ?? new Date()).toISOString();
  const now = new Date(timestamp);
  const lines: string[] = [JSON.stringify({ _tag: "doctor.start", timestamp })];
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
      _tag: "doctor.complete",
      timestamp,
      checks: checks.length + deprecationsCheckCount + (report.appConfig === undefined ? 0 : 1),
      failed: checks.filter((check) => check.status === "fail").length + (appConfigInvalid ? 1 : 0),
      warned: checks.filter((check) => check.status === "warn").length,
    }),
  );
  return `${lines.join("\n")}\n`;
};
