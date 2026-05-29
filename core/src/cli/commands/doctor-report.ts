/**
 * Combined `lando doctor` report.
 *
 * Merges provider and subsystem diagnostics into a single report without
 * requiring app bootstrap.
 */
import { Effect } from "effect";

import type { ConfigService, RuntimeProviderRegistry } from "@lando/sdk/services";

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
}

export const doctorReport = (
  options: DoctorOptions = {},
): Effect.Effect<DoctorReport, DoctorError, ConfigService | RuntimeProviderRegistry> =>
  Effect.gen(function* () {
    const provider = yield* doctor(options);
    const subsystems = yield* subsystemDoctor().pipe(Effect.provide(DefaultSubsystemDoctorLayer));
    return { provider, subsystems };
  });

export const renderDoctorReport = (report: DoctorReport): string => {
  const provider = renderDoctorResult(report.provider);
  const subsystems = renderSubsystemDoctorResult(report.subsystems);
  if (subsystems.length === 0) return provider;
  if (provider.length === 0) return subsystems;
  return `${provider}\n${subsystems}`;
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
  );
  const checks = [...report.provider.checks, ...report.subsystems.checks];
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
