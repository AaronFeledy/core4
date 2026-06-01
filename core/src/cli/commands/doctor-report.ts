/**
 * Combined `lando doctor` report.
 *
 * Merges provider, subsystem, and global-app diagnostics into a single report
 * without requiring app bootstrap.
 */
import { Effect } from "effect";

import type { ConfigLintResult } from "@lando/sdk/schema";
import type { ConfigService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { lintLandofile } from "../../landofile/lint.ts";
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
  /** Present only under `lando doctor --app`; reuses the `app:config:lint` pass. */
  readonly appConfig?: ConfigLintResult;
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

export const doctorReport = (
  options: DoctorOptions = {},
): Effect.Effect<DoctorReport, DoctorError, ConfigService | RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const provider = yield* doctor(options);
    const subsystems = yield* subsystemDoctor({ fix: options.fix === true }).pipe(
      Effect.provide(DefaultSubsystemDoctorLayer),
    );
    const globalApp = yield* globalAppDoctor().pipe(Effect.provide(DefaultGlobalAppDoctorLayer));
    const appConfig = options.app === true ? yield* appConfigForReport() : undefined;
    return { provider, subsystems, globalApp, ...(appConfig === undefined ? {} : { appConfig }) };
  });

export const renderDoctorReport = (report: DoctorReport): string => {
  const provider = renderDoctorResult(report.provider);
  const subsystems = renderSubsystemDoctorResult(report.subsystems);
  const globalApp = renderGlobalAppDoctorResult(report.globalApp);
  const appConfig = report.appConfig === undefined ? "" : renderAppConfigSection(report.appConfig);
  const parts = [provider, subsystems, globalApp, appConfig].filter((part) => part.length > 0);
  return parts.join("\n");
};

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
  if (report.appConfig !== undefined) lines.push(appConfigCheckLine(report.appConfig));
  const checks = [...report.provider.checks, ...report.subsystems.checks, ...report.globalApp.checks];
  const appConfigInvalid = report.appConfig !== undefined && !report.appConfig.valid;
  lines.push(
    JSON.stringify({
      _tag: "doctor.complete",
      timestamp,
      checks: checks.length + (report.appConfig === undefined ? 0 : 1),
      failed: checks.filter((check) => check.status === "fail").length + (appConfigInvalid ? 1 : 0),
      warned: checks.filter((check) => check.status === "warn").length,
    }),
  );
  return `${lines.join("\n")}\n`;
};
