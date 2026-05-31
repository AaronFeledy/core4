/**
 * Combined `lando doctor` report.
 *
 * Merges provider, subsystem, and global-app diagnostics into a single report
 * without requiring app bootstrap.
 */
import { Effect } from "effect";

import type { ConfigService, RuntimeProviderRegistry } from "@lando/sdk/services";

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
}

export const doctorReport = (
  options: DoctorOptions = {},
): Effect.Effect<DoctorReport, DoctorError, ConfigService | RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const provider = yield* doctor(options);
    const subsystems = yield* subsystemDoctor({ fix: options.fix === true }).pipe(
      Effect.provide(DefaultSubsystemDoctorLayer),
    );
    const globalApp = yield* globalAppDoctor().pipe(Effect.provide(DefaultGlobalAppDoctorLayer));
    return { provider, subsystems, globalApp };
  });

export const renderDoctorReport = (report: DoctorReport): string => {
  const provider = renderDoctorResult(report.provider);
  const subsystems = renderSubsystemDoctorResult(report.subsystems);
  const globalApp = renderGlobalAppDoctorResult(report.globalApp);
  const parts = [provider, subsystems, globalApp].filter((part) => part.length > 0);
  return parts.join("\n");
};

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
  const checks = [...report.provider.checks, ...report.subsystems.checks, ...report.globalApp.checks];
  lines.push(
    JSON.stringify({
      _tag: "doctor.complete",
      timestamp,
      checks: checks.length,
      failed: checks.filter((check) => check.status === "fail").length,
      warned: checks.filter((check) => check.status === "warn").length,
    }),
  );
  return `${lines.join("\n")}\n`;
};
