import { Effect } from "effect";

import {
  EXEC_UMASK_PROBE_COMMAND,
  isWorldWritableUmask,
  parseProcSelfStatusUmask,
} from "@lando/container-runtime/podman/exec-umask";
import type { AppId, ServiceName } from "@lando/sdk/schema";
import type { CommandSpec, ExecResult, ListFilter, ServiceRuntimeInfo } from "@lando/sdk/services";

import type {
  DoctorCheck,
  DoctorRuntime,
  DoctorSelectionRecord,
  DoctorSeverity,
  DoctorSolution,
  DoctorStatus,
} from "./doctor-contract";
import { providerKindFor } from "./doctor-contract";

export const EXEC_UMASK_CHECK_NAME = "exec-umask";

export interface ExecUmaskDoctorProvider {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
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
  readonly compensating: boolean;
  readonly probeStatus: ExecUmaskProbeStatus;
}

const COMPENSATING_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description:
    "The container engine inherits umask 0000 for exec processes. Lando wraps exec with umask 0022 so created files are not world-writable.",
};

export const diagnoseExecUmask = (input: {
  readonly engineVersion: string | undefined;
  readonly stdout: string | undefined;
}): ExecUmaskDiagnosis => {
  const engineVersion =
    input.engineVersion === undefined || input.engineVersion.length === 0 ? "unknown" : input.engineVersion;
  if (input.stdout === undefined) {
    return { engineVersion, execUmask: "unprobed", compensating: false, probeStatus: "unprobed" };
  }
  const umask = parseProcSelfStatusUmask(input.stdout);
  if (umask === undefined) {
    return { engineVersion, execUmask: "unprobed", compensating: false, probeStatus: "unprobed" };
  }
  return {
    engineVersion,
    execUmask: umask,
    compensating: isWorldWritableUmask(umask),
    probeStatus: "ok",
  };
};

export const buildExecUmaskDoctorCheck = (
  diagnosis: ExecUmaskDiagnosis,
  provider: { readonly id: string; readonly displayName: string; readonly version: string },
  runtime: DoctorRuntime,
  runtimeStatus: string,
  selection?: DoctorSelectionRecord,
): DoctorCheck => {
  const status: DoctorStatus = diagnosis.compensating ? "warn" : "pass";
  const severity: DoctorSeverity = diagnosis.compensating ? "warn" : "info";
  return {
    name: EXEC_UMASK_CHECK_NAME,
    status,
    severity,
    providerId: provider.id,
    providerName: provider.displayName,
    providerVersion: provider.version,
    providerKind: providerKindFor(provider.id),
    runtimeStatus,
    runtime,
    capabilities: {},
    context: {
      providerId: provider.id,
      providerKind: providerKindFor(provider.id),
      providerVersion: provider.version,
      engineVersion: diagnosis.engineVersion,
      execUmask: diagnosis.execUmask,
      compensating: String(diagnosis.compensating),
      probeStatus: diagnosis.probeStatus,
    },
    solutions: diagnosis.compensating ? [COMPENSATING_REMEDIATION] : [],
    ...(selection === undefined ? {} : { selection }),
  };
};

const runningService = (entries: ReadonlyArray<ServiceRuntimeInfo>): ServiceRuntimeInfo | undefined =>
  entries.find((entry) => entry.status === "running" || entry.state === "running");

export const collectExecUmaskDoctorCheck = Effect.fnUntraced(function* (input: {
  readonly provider: ExecUmaskDoctorProvider;
  readonly engineVersion: string | undefined;
  readonly runtime: DoctorRuntime;
  readonly runtimeStatus: string;
  readonly selection: DoctorSelectionRecord;
}): Effect.fn.Return<DoctorCheck> {
  const listed = yield* input.provider.list({}).pipe(Effect.catch(() => Effect.succeed([])));
  const service = runningService(listed);
  const probed =
    service === undefined
      ? undefined
      : yield* input.provider
          .exec({ app: service.app, service: service.service }, { command: [...EXEC_UMASK_PROBE_COMMAND] })
          .pipe(
            Effect.map((result) => (result.exitCode === 0 ? `${result.stdout}${result.stderr}` : undefined)),
            Effect.catch(() => Effect.succeed(undefined)),
          );
  return buildExecUmaskDoctorCheck(
    diagnoseExecUmask({ engineVersion: input.engineVersion, stdout: probed }),
    input.provider,
    input.runtime,
    input.runtimeStatus,
    input.selection,
  );
});
