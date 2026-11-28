import { dirname, join, resolve } from "node:path";
import {
  HOST_PROXY_SOCKET_NAME,
  hostProxyContainerDirectory,
} from "@lando/engine/subsystems/host-proxy/run-directory";
import type {
  HostProxyWorkerRecord,
  LegacyHostProxyWorkerRecord,
} from "@lando/engine/subsystems/host-proxy/worker-records";
import { probeWorker } from "@lando/engine/subsystems/host-proxy/worker-state";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";
import type { DoctorFinding, DoctorSkipInput, DoctorSolution } from "./doctor-contract";
import type { HostProxyTransportDoctorOptions } from "./doctor-host-proxy";
import { probeHostProxyContainer } from "./doctor-host-proxy-container-probe";
import { HostProxyDoctorFileSystem } from "./doctor-host-proxy-filesystem";

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
const WORKER_STOPPED: DoctorSolution = {
  kind: "manual",
  description: "The app's host-proxy worker is not running. Run `lando start` in the app to restart it.",
  command: "lando start",
};
const PRIVATE_DIRECTORY_REQUIRED: DoctorSolution = {
  kind: "manual",
  description:
    "Run `lando start` from the app if the only change was granting extra read or traverse access to its own run or container directory. Lando recreates that layout. Otherwise, inspect the path first: restore missing directories, replace symlinks with real directories, and correct ownership or access before starting.",
};
const LEGACY_PRIVATE_DIRECTORY_REQUIRED: DoctorSolution = {
  kind: "manual",
  description:
    "Inspect the legacy host-proxy run directory. Restore an owner-only directory owned by you, not a symlink, before running `lando start` from the app.",
};
const SOCKET_PATH_REQUIRED: DoctorSolution = {
  kind: "manual",
  description:
    "The host-proxy worker record does not name a socket in the expected location. Inspect the worker state before starting the app.",
};
const SOCKET_REQUIRED: DoctorSolution = {
  kind: "manual",
  description:
    "The host-proxy endpoint is not a socket owned by you. Inspect the endpoint's type and ownership before starting the app.",
};

const containerGatewayMatches = (containerUrl: string, gateway: string): boolean => {
  try {
    return new URL(containerUrl).hostname === gateway;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
};

type DiagnoseWorkerOptions = {
  readonly doctor: HostProxyTransportDoctorOptions;
  readonly runDir: string;
  readonly maxProbeServices: number;
} & (
  | {
      readonly record: HostProxyWorkerRecord;
      readonly current: true;
    }
  | {
      readonly record: LegacyHostProxyWorkerRecord;
      readonly current: false;
    }
);

const baseCheck = (
  context: Record<string, string>,
  status: "pass" | "warn",
  solutions: ReadonlyArray<DoctorSolution>,
): DoctorFinding => ({
  name: "host-proxy-transport",
  status,
  severity: status === "pass" ? "info" : "warn",
  context,
  solutions,
});

export const diagnoseHostProxyWorker = Effect.fnUntraced(function* (
  options: DiagnoseWorkerOptions,
): Effect.fn.Return<DoctorFinding | DoctorSkipInput, never, HostProxyDoctorFileSystem> {
  const fileSystem = yield* HostProxyDoctorFileSystem;
  const { doctor, record } = options;
  const currentRecord = options.current ? options.record : undefined;
  const containerUrl = currentRecord?.containerUrl;
  const rawProbeServices = currentRecord?.probeServices;
  const endpoint = record.transport === "unix-socket" ? record.socketPath : containerUrl;
  const context: Record<string, string> = {
    appId: record.appId,
    transport: record.transport,
    endpoint: endpoint ?? "missing",
  };
  const skipped = (reason: string): DoctorSkipInput => ({
    check: `host-proxy-transport:${record.appId}`,
    reason,
  });

  if (currentRecord?.providerId !== undefined && currentRecord.providerId !== doctor.provider.id) {
    return skipped("provider-mismatch");
  }

  // A Windows bridge advertises a guest Unix socket but controls the worker
  // through its host loopback URL. The guest path must be probed in a service,
  // never stat'ed on the Windows host.
  const bridgedGuestSocket = record.transport === "unix-socket" && record.url !== undefined;
  if (bridgedGuestSocket && record.socketPath === undefined) {
    return baseCheck({ ...context, reachability: "unreachable", failure: "guest-socket-missing" }, "warn", [
      HOST_PROXY_REMEDIATION,
    ]);
  }
  if (record.transport === "unix-socket" && !bridgedGuestSocket) {
    const { socketPath } = record;
    const layout = options.current ? "container" : "run-directory";
    const endpointMatches =
      socketPath !== undefined &&
      (options.current
        ? socketPath === join(hostProxyContainerDirectory(options.runDir), HOST_PROXY_SOCKET_NAME)
        : dirname(socketPath) === options.runDir && resolve(socketPath) === socketPath);
    const directoryPrivate =
      endpointMatches && (yield* fileSystem.socketDirectoryPrivate(socketPath, layout));
    const directorySolution = endpointMatches
      ? options.current
        ? PRIVATE_DIRECTORY_REQUIRED
        : LEGACY_PRIVATE_DIRECTORY_REQUIRED
      : SOCKET_PATH_REQUIRED;
    const privacyContext = {
      ...context,
      privateRunDirectory: String(directoryPrivate),
      ...(endpointMatches
        ? {}
        : { failure: socketPath === undefined ? "socket-path-missing" : "socket-path-mismatch" }),
    };
    if (doctor.runtimeIdle === true)
      return {
        ...baseCheck(
          { ...privacyContext, reachability: "skipped" },
          directoryPrivate ? "pass" : "warn",
          directoryPrivate ? [] : [directorySolution],
        ),
        name: "host-proxy-privacy",
      };
    const socketMetadata = endpointMatches ? yield* fileSystem.socketMetadata(socketPath) : undefined;
    const controlProbe =
      directoryPrivate && socketMetadata?.type === "socket" && socketMetadata.owned
        ? yield* probeWorker(record)
        : undefined;
    const reachable = controlProbe === "live";
    return baseCheck(
      {
        ...privacyContext,
        reachability: reachable ? "reachable" : "unreachable",
        socketType: socketMetadata?.type ?? "missing",
        socketMode:
          socketMetadata === undefined ? "missing" : socketMetadata.mode.toString(8).padStart(4, "0"),
        socketOwned: String(socketMetadata?.owned ?? false),
        ...(controlProbe === "dead" ? { failure: "control-probe-failed" } : {}),
      },
      reachable ? "pass" : "warn",
      reachable
        ? []
        : !directoryPrivate
          ? [directorySolution]
          : socketMetadata !== undefined && (socketMetadata.type !== "socket" || !socketMetadata.owned)
            ? [SOCKET_REQUIRED]
            : [WORKER_STOPPED],
    );
  }

  if (doctor.runtimeIdle === true)
    return skipped(`Provider ${doctor.provider.id} is idle; host-proxy reachability was not probed.`);

  const containerTarget = bridgedGuestSocket
    ? record.socketPath === undefined
      ? undefined
      : { kind: "unix-socket" as const }
    : containerUrl === undefined
      ? undefined
      : { kind: "tcp-host-gateway" as const, containerUrl };
  if (
    currentRecord?.providerId === undefined ||
    containerTarget === undefined ||
    rawProbeServices === undefined
  ) {
    return skipped("pre-upgrade-record");
  }

  const controlProbe = yield* probeWorker(record);
  const gateway = doctor.provider.tcpHostGateway;
  const gatewayContext = bridgedGuestSocket || gateway === undefined ? {} : { containerGateway: gateway };
  if (controlProbe !== "live") {
    return baseCheck({ ...context, reachability: "unreachable", failure: "control-probe-failed" }, "warn", [
      WORKER_STOPPED,
    ]);
  }
  if (!bridgedGuestSocket && gateway === undefined) {
    return baseCheck(
      { ...context, reachability: "unreachable", failure: "container-gateway-unavailable" },
      "warn",
      [HOST_PROXY_REMEDIATION],
    );
  }
  if (
    containerTarget.kind === "tcp-host-gateway" &&
    gateway !== undefined &&
    !containerGatewayMatches(containerTarget.containerUrl, gateway)
  ) {
    return baseCheck(
      {
        ...context,
        reachability: "unreachable",
        ...gatewayContext,
        failure: "container-gateway-mismatch",
      },
      "warn",
      [HOST_PROXY_REMEDIATION],
    );
  }

  const containerProbe = yield* probeHostProxyContainer({
    providerExec: doctor.provider.exec,
    appId: record.appId,
    target: containerTarget,
    probeServices: rawProbeServices,
    maxProbeServices: options.maxProbeServices,
  });
  switch (containerProbe) {
    case "reachable":
      return baseCheck({ ...context, reachability: "reachable", ...gatewayContext }, "pass", []);
    case "cap-exhausted":
      return skipped("probe-service-cap-exhausted");
    case "failed":
      return baseCheck(
        {
          ...context,
          reachability: "unreachable",
          ...gatewayContext,
          failure: "container-probe-failed",
        },
        "warn",
        [HOST_PROXY_REMEDIATION],
      );
    case "inconclusive":
      return skipped("probe-services-inconclusive");
    default: {
      const exhaustive: never = containerProbe;
      return exhaustive;
    }
  }
});

export type HostProxyDoctorProvider = {
  readonly id: string;
  readonly tcpHostGateway?: string;
  readonly exec: RuntimeProviderShape["exec"];
};
