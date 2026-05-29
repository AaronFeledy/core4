/**
 * Combined `lando doctor` report.
 *
 * Aggregates the provider diagnostics (`doctor`) with the per-subsystem
 * diagnostics (`subsystemDoctor`) so a single `lando doctor` run reports every
 * subsystem's status alongside the selected provider. The subsystem layer
 * dependencies are satisfied internally with the bundled default Live Layers,
 * so the combined report keeps the same `ConfigService | RuntimeProviderRegistry`
 * requirement (and the same `provider` bootstrap level) as the provider-only
 * `doctor` — it never requires app bootstrap.
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
