import {
  EXEC_UMASK_COMPENSATION,
  EXEC_UMASK_PROBE_COMMAND,
  isWorldWritableUmask,
  parseProcSelfStatusUmask,
} from "@lando/container-runtime/podman/exec-umask";
import type { AppId, ServiceName } from "@lando/sdk/schema";
import type { CommandSpec, ExecResult, ListFilter, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect } from "effect";

import type { DoctorFinding, DoctorSeverity, DoctorSolution, DoctorStatus } from "./doctor-contract";

export const EXEC_UMASK_CHECK_NAME = "exec-umask";

export interface ExecUmaskDoctorProvider {
  readonly list: (filter: ListFilter) => Effect.Effect<ReadonlyArray<ServiceRuntimeInfo>, unknown>;
  readonly exec: (
    target: { readonly app: AppId; readonly service: ServiceName },
    command: CommandSpec,
  ) => Effect.Effect<ExecResult, unknown>;
}

export type ExecUmaskProbeStatus = "ok" | "unprobed";

export interface ExecUmaskDiagnosis {
  readonly engineVersion: string;
  readonly execUmask: string;
  readonly effectiveExecUmask: string;
  readonly compensating: boolean;
  readonly probeStatus: ExecUmaskProbeStatus;
}

const COMPENSATING_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description:
    "The raw exec probe reported umask 0000. A probe through Lando's exec wrapper reported 0022. Commands that set their own umask can produce different permissions.",
};

export const diagnoseExecUmask = (input: {
  readonly engineVersion: string | undefined;
  readonly stdout: string | undefined;
  readonly effectiveStdout?: string;
}): ExecUmaskDiagnosis => {
  const engineVersion =
    input.engineVersion === undefined || input.engineVersion.length === 0 ? "unknown" : input.engineVersion;
  const umask = parseProcSelfStatusUmask(input.stdout ?? "");
  if (umask === undefined) {
    return {
      engineVersion,
      execUmask: "unprobed",
      effectiveExecUmask: "unprobed",
      compensating: false,
      probeStatus: "unprobed",
    };
  }
  const effectiveExecUmask = isWorldWritableUmask(umask)
    ? (parseProcSelfStatusUmask(input.effectiveStdout ?? "") ?? "unprobed")
    : umask;
  return {
    engineVersion,
    execUmask: umask,
    effectiveExecUmask,
    compensating: isWorldWritableUmask(umask) && effectiveExecUmask === EXEC_UMASK_COMPENSATION,
    probeStatus: "ok",
  };
};

export const buildExecUmaskDoctorCheck = (diagnosis: ExecUmaskDiagnosis): DoctorFinding => {
  const status: DoctorStatus =
    diagnosis.probeStatus === "unprobed" || isWorldWritableUmask(diagnosis.execUmask) ? "warn" : "pass";
  const severity: DoctorSeverity = status === "warn" ? "warn" : "info";
  return {
    name: EXEC_UMASK_CHECK_NAME,
    status,
    severity,
    context: {
      engineVersion: diagnosis.engineVersion,
      execUmask: diagnosis.execUmask,
      effectiveExecUmask: diagnosis.effectiveExecUmask,
      compensating: String(diagnosis.compensating),
      probeStatus: diagnosis.probeStatus,
    },
    solutions: diagnosis.compensating ? [COMPENSATING_REMEDIATION] : [],
  };
};

const runningService = (entries: ReadonlyArray<ServiceRuntimeInfo>): ServiceRuntimeInfo | undefined =>
  entries.find((entry) => entry.status === "running");

export const collectExecUmaskDoctorCheck = Effect.fnUntraced(function* (input: {
  readonly provider: ExecUmaskDoctorProvider;
  readonly engineVersion: string | undefined;
  /** A runtime that is not running (including idle) is never listed or exec'd. */
  readonly running: boolean;
}): Effect.fn.Return<DoctorFinding> {
  const listed = input.running
    ? yield* input.provider.list({}).pipe(Effect.catch(() => Effect.succeed([])))
    : [];
  const service = runningService(listed);
  const probed =
    service === undefined || service.containerId === undefined
      ? undefined
      : yield* input.provider
          .exec(
            { app: service.app, service: service.service },
            { command: [...EXEC_UMASK_PROBE_COMMAND], raw: true },
          )
          .pipe(
            Effect.map((result) => (result.exitCode === 0 ? result.stdout : undefined)),
            Effect.catch(() => Effect.succeed(undefined)),
          );
  const effectiveStdout =
    service !== undefined && isWorldWritableUmask(parseProcSelfStatusUmask(probed ?? "") ?? "")
      ? yield* input.provider
          .exec({ app: service.app, service: service.service }, { command: [...EXEC_UMASK_PROBE_COMMAND] })
          .pipe(
            Effect.map((result) => (result.exitCode === 0 ? result.stdout : undefined)),
            Effect.catch(() => Effect.succeed(undefined)),
          )
      : undefined;
  return buildExecUmaskDoctorCheck(
    diagnoseExecUmask({
      engineVersion: input.engineVersion,
      stdout: probed,
      ...(effectiveStdout === undefined ? {} : { effectiveStdout }),
    }),
  );
});
