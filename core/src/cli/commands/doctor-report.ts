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
  subsystemDoctor,
} from "./doctor-subsystems.ts";
import {
  type DoctorError,
  type DoctorOptions,
  type DoctorResult,
  doctor,
  renderDoctorResult,
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
