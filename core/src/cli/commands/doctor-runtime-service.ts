import { Effect } from "effect";

import type {
  DoctorCheck,
  DoctorSelectionRecord,
  DoctorSeverity,
  DoctorSolution,
  DoctorStatus,
} from "./doctor-contract";
import { providerKindFor } from "./doctor-contract";
import type { SetupReadinessRuntimeService } from "./setup-readiness";

export interface RuntimeServiceStatusShape {
  readonly running: boolean;
  readonly socketReachable: boolean;
  readonly pid?: number;
  readonly ownedServiceProcess: boolean;
  readonly orphanPids?: ReadonlyArray<number>;
}

export interface RuntimeServiceCapableProvider {
  readonly id: string;
  readonly getRuntimeServiceStatus?: Effect.Effect<RuntimeServiceStatusShape, unknown>;
}

export interface ContainerDiedEventCapableProvider {
  readonly id: string;
  readonly getContainerDiedEvents?: Effect.Effect<ReadonlyArray<unknown>, unknown>;
}

export const runtimeServiceStatusFromProviderStatus = (status: {
  readonly running: boolean;
}): RuntimeServiceStatusShape => ({
  running: status.running,
  socketReachable: status.running,
  ownedServiceProcess: false,
});

export const runtimeServiceStatusFor = (
  provider: RuntimeServiceCapableProvider,
  status: { readonly running: boolean },
): Effect.Effect<RuntimeServiceStatusShape, unknown> =>
  provider.getRuntimeServiceStatus ?? Effect.succeed(runtimeServiceStatusFromProviderStatus(status));

export const containerDiedEventPayloadsFor = (
  provider: ContainerDiedEventCapableProvider,
  payloads: ReadonlyArray<unknown> | undefined,
): Effect.Effect<ReadonlyArray<unknown>> => {
  if (payloads !== undefined) return Effect.succeed(payloads);
  const candidate = provider.getContainerDiedEvents;
  if (candidate !== undefined) return candidate.pipe(Effect.catchAll(() => Effect.succeed([])));
  return Effect.succeed([]);
};

const orphanRemediation = (orphanPids: ReadonlyArray<number>): DoctorSolution => ({
  kind: "manual",
  description: `Found orphaned runtime-service process(es) ${orphanPids.join(
    ",",
  )} not owned by Lando. Terminate them manually before retrying.`,
});

export const buildRuntimeServiceDoctorCheck = (
  status: RuntimeServiceStatusShape,
  provider: { readonly id: string; readonly displayName: string; readonly version: string },
  runtimeVersion: string | undefined,
  readinessRuntimeService: SetupReadinessRuntimeService | undefined,
  selection?: DoctorSelectionRecord,
): DoctorCheck => {
  const hasOrphans = status.orphanPids !== undefined && status.orphanPids.length > 0;
  const checkStatus: DoctorStatus = status.running && !hasOrphans ? "pass" : "warn";
  const severity: DoctorSeverity = checkStatus === "pass" ? "info" : "warn";
  const context: Record<string, string> = {
    providerId: provider.id,
    providerKind: providerKindFor(provider.id),
    providerVersion: provider.version,
    runtimeRunning: String(status.running),
    socketReachable: String(status.socketReachable),
    ownedServiceProcess: String(status.ownedServiceProcess),
  };
  if (status.pid !== undefined) context.runtimePid = String(status.pid);
  if (hasOrphans) context.orphanPids = (status.orphanPids ?? []).join(",");
  if (readinessRuntimeService !== undefined) {
    context.lastRecordedRunning = String(readinessRuntimeService.running);
    context.lastRecordedSocketPath = readinessRuntimeService.socketPath;
    if (readinessRuntimeService.pid !== undefined) {
      context.lastRecordedPid = String(readinessRuntimeService.pid);
    }
    if (readinessRuntimeService.runtimeVersion !== undefined) {
      context.lastRecordedRuntimeVersion = readinessRuntimeService.runtimeVersion;
    }
  }

  return {
    name: "runtime-service",
    status: checkStatus,
    severity,
    providerId: provider.id,
    providerName: provider.displayName,
    providerVersion: provider.version,
    providerKind: providerKindFor(provider.id),
    runtimeStatus: status.running ? "running" : "stopped",
    runtime: {
      running: status.running,
      ...(runtimeVersion === undefined ? {} : { version: runtimeVersion }),
    },
    capabilities: {},
    context,
    solutions: hasOrphans ? [orphanRemediation(status.orphanPids ?? [])] : [],
    ...(selection === undefined ? {} : { selection }),
  };
};
