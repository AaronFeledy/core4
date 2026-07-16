import { Effect } from "effect";

import type { RuntimeProviderShape } from "@lando/sdk/services";

import type {
  HostProxyWorkerRecord,
  LegacyHostProxyWorkerRecord,
} from "../../subsystems/host-proxy/worker-records.ts";
import { probeWorker } from "../../subsystems/host-proxy/worker-state.ts";
import { probeHostProxyContainer } from "./doctor-host-proxy-container-probe.ts";
import { HostProxyDoctorFileSystem } from "./doctor-host-proxy-filesystem.ts";
import type { HostProxyTransportDoctorOptions } from "./doctor-host-proxy.ts";
import type { DoctorCheck, DoctorSolution } from "./doctor.ts";

export interface HostProxyDoctorLimits {
  readonly maxWorkers: number;
  readonly maxProbeServices: number;
  readonly budgetMs: number;
}

const HOST_PROXY_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description:
    "The app's host-proxy transport is unreachable. Run `lando restart` from the app to recreate its authenticated bridge.",
  command: "lando restart",
};

const containerGatewayMatches = (containerUrl: string, gateway: string): boolean => {
  try {
    return new URL(containerUrl).hostname === gateway;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
};

type DiagnoseWorkerOptions =
  | {
      readonly doctor: HostProxyTransportDoctorOptions;
      readonly record: HostProxyWorkerRecord;
      readonly current: true;
      readonly maxProbeServices: number;
    }
  | {
      readonly doctor: HostProxyTransportDoctorOptions;
      readonly record: LegacyHostProxyWorkerRecord;
      readonly current: false;
      readonly maxProbeServices: number;
    };

const baseCheck = (
  options: HostProxyTransportDoctorOptions,
  context: Record<string, string>,
  status: "pass" | "warn",
  solutions: ReadonlyArray<DoctorSolution>,
): DoctorCheck => ({
  name: "host-proxy-transport",
  status,
  severity: status === "pass" ? "info" : "warn",
  providerId: options.provider.id,
  providerName: options.provider.displayName,
  providerVersion: options.provider.version,
  providerKind: options.providerKind,
  runtimeStatus: options.runtimeStatus,
  runtime: options.runtime,
  capabilities: {},
  context,
  solutions,
  selection: options.selection,
});

export const diagnoseHostProxyWorker = (
  options: DiagnoseWorkerOptions,
): Effect.Effect<DoctorCheck, never, HostProxyDoctorFileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* HostProxyDoctorFileSystem;
    const { doctor, record } = options;
    const currentRecord = options.current ? options.record : undefined;
    const containerUrl = currentRecord?.containerUrl;
    const rawProbeServices = currentRecord?.probeServices;
    const endpoint = record.transport === "unix-socket" ? record.socketPath : containerUrl;
    const context: Record<string, string> = {
      providerId: doctor.provider.id,
      providerKind: doctor.providerKind,
      providerVersion: doctor.provider.version,
      appId: record.appId,
      transport: record.transport,
      endpoint: endpoint ?? "missing",
    };

    if (currentRecord?.providerId !== undefined && currentRecord.providerId !== doctor.provider.id) {
      return baseCheck(
        doctor,
        {
          ...context,
          reachability: "not-probed",
          reason: "provider-mismatch",
          workerProviderId: currentRecord.providerId,
        },
        "pass",
        [],
      );
    }

    if (record.transport === "unix-socket") {
      const controlProbe = yield* probeWorker(record);
      const socketMetadata =
        record.socketPath === undefined ? undefined : yield* fileSystem.socketMetadata(record.socketPath);
      const reachable =
        controlProbe === "live" && socketMetadata?.type === "socket" && socketMetadata.mode === 0o600;
      return baseCheck(
        doctor,
        {
          ...context,
          reachability: reachable ? "reachable" : "unreachable",
          socketType: socketMetadata?.type ?? "missing",
          socketMode:
            socketMetadata === undefined ? "missing" : socketMetadata.mode.toString(8).padStart(4, "0"),
          ...(!reachable && controlProbe !== "live" ? { failure: "control-probe-failed" } : {}),
        },
        reachable ? "pass" : "warn",
        reachable ? [] : [HOST_PROXY_REMEDIATION],
      );
    }

    if (
      currentRecord?.providerId === undefined ||
      containerUrl === undefined ||
      rawProbeServices === undefined
    ) {
      return baseCheck(
        doctor,
        {
          ...context,
          reachability: "not-probed",
          ...(doctor.provider.tcpHostGateway === undefined
            ? {}
            : { containerGateway: doctor.provider.tcpHostGateway }),
          reason: "pre-upgrade-record",
        },
        "pass",
        [],
      );
    }

    const controlProbe = yield* probeWorker(record);
    const gateway = doctor.provider.tcpHostGateway;
    if (controlProbe !== "live") {
      return baseCheck(
        doctor,
        { ...context, reachability: "unreachable", failure: "control-probe-failed" },
        "warn",
        [HOST_PROXY_REMEDIATION],
      );
    }
    if (gateway === undefined) {
      return baseCheck(
        doctor,
        { ...context, reachability: "unreachable", failure: "container-gateway-unavailable" },
        "warn",
        [HOST_PROXY_REMEDIATION],
      );
    }
    if (!containerGatewayMatches(containerUrl, gateway)) {
      return baseCheck(
        doctor,
        {
          ...context,
          reachability: "unreachable",
          containerGateway: gateway,
          failure: "container-gateway-mismatch",
        },
        "warn",
        [HOST_PROXY_REMEDIATION],
      );
    }

    const containerProbe = yield* probeHostProxyContainer({
      providerExec: doctor.provider.exec,
      appId: record.appId,
      containerUrl,
      probeServices: rawProbeServices,
      maxProbeServices: options.maxProbeServices,
    });
    switch (containerProbe) {
      case "reachable":
        return baseCheck(
          doctor,
          { ...context, reachability: "reachable", containerGateway: gateway },
          "pass",
          [],
        );
      case "cap-exhausted":
        return baseCheck(
          doctor,
          {
            ...context,
            reachability: "not-probed",
            containerGateway: gateway,
            reason: "probe-service-cap-exhausted",
          },
          "pass",
          [],
        );
      case "failed":
        return baseCheck(
          doctor,
          {
            ...context,
            reachability: "unreachable",
            containerGateway: gateway,
            failure: "container-probe-failed",
          },
          "warn",
          [HOST_PROXY_REMEDIATION],
        );
      case "inconclusive":
        return baseCheck(
          doctor,
          {
            ...context,
            reachability: "not-probed",
            containerGateway: gateway,
            reason: "probe-services-inconclusive",
          },
          "pass",
          [],
        );
      default: {
        const exhaustive: never = containerProbe;
        return exhaustive;
      }
    }
  });

export type HostProxyDoctorProvider = {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly tcpHostGateway?: string;
  readonly exec: RuntimeProviderShape["exec"];
};
