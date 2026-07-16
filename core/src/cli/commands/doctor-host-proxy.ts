import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { Effect } from "effect";

import { makeLandoPaths } from "../../config/paths.ts";
import { readWorkerRecordAt } from "../../subsystems/host-proxy/worker-state-file.ts";
import { probeWorker } from "../../subsystems/host-proxy/worker-state.ts";
import type {
  DoctorCheck,
  DoctorProviderKind,
  DoctorRuntime,
  DoctorSelectionRecord,
  DoctorSolution,
} from "./doctor.ts";

interface HostProxyDoctorProvider {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly tcpHostGateway?: string;
}

export interface HostProxyTransportDoctorOptions {
  readonly userDataRoot?: string;
  readonly provider: HostProxyDoctorProvider;
  readonly providerKind: DoctorProviderKind;
  readonly runtimeStatus: string;
  readonly runtime: DoctorRuntime;
  readonly selection: DoctorSelectionRecord;
}

const HOST_PROXY_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description:
    "The app's host-proxy transport is unreachable. Run `lando restart` from the app to recreate its authenticated bridge.",
  command: "lando restart",
};

export const hostProxyTransportDoctorChecks = (
  options: HostProxyTransportDoctorOptions,
): Effect.Effect<ReadonlyArray<DoctorCheck>> =>
  Effect.gen(function* () {
    const paths = makeLandoPaths(
      options.userDataRoot === undefined ? {} : { userDataRoot: options.userDataRoot },
    );
    const entries = yield* Effect.promise(() =>
      readdir(paths.hostProxyRunRoot, { withFileTypes: true }).catch(() => []),
    );
    const checks: DoctorCheck[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = resolve(paths.hostProxyRunRoot, entry.name);
      const record = yield* readWorkerRecordAt(resolve(runDir, "worker.json"));
      if (record === undefined) continue;
      if (resolve(paths.hostProxyRunDir(record.appId, record.appRoot)) !== runDir) continue;

      const probe = yield* probeWorker(record);
      const gatewayAvailable =
        record.transport === "unix-socket" || options.provider.tcpHostGateway !== undefined;
      const reachable = probe === "live" && gatewayAvailable;
      const endpoint = record.transport === "unix-socket" ? record.socketPath : record.url;
      const context: Record<string, string> = {
        providerId: options.provider.id,
        providerKind: options.providerKind,
        providerVersion: options.provider.version,
        appId: record.appId,
        transport: record.transport,
        reachability: reachable ? "reachable" : "unreachable",
        endpoint: endpoint ?? "missing",
        ...(record.transport === "tcp-host-gateway" && options.provider.tcpHostGateway !== undefined
          ? { containerGateway: options.provider.tcpHostGateway }
          : {}),
        ...(!gatewayAvailable ? { failure: "container-gateway-unavailable" } : {}),
      };
      checks.push({
        name: "host-proxy-transport",
        status: reachable ? "pass" : "warn",
        severity: reachable ? "info" : "warn",
        providerId: options.provider.id,
        providerName: options.provider.displayName,
        providerVersion: options.provider.version,
        providerKind: options.providerKind,
        runtimeStatus: options.runtimeStatus,
        runtime: options.runtime,
        capabilities: {},
        context,
        solutions: reachable ? [] : [HOST_PROXY_REMEDIATION],
        selection: options.selection,
      });
    }
    return checks;
  });
