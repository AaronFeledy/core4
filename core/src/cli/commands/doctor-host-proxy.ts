import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { Duration, Effect, Either, Option, Schema } from "effect";

import { runProbe } from "@lando/sdk/probe";
import { AppId, CommandResultEnvelope, ServiceName } from "@lando/sdk/schema";
import type { ExecResult, ProviderError, RuntimeProviderShape } from "@lando/sdk/services";

import { makeLandoPaths } from "../../config/paths.ts";
import { RedactionService, createStandaloneRedactor } from "../../redaction/service.ts";
import { readWorkerRecordAt } from "../../subsystems/host-proxy/worker-state-file.ts";
import { probeWorker } from "../../subsystems/host-proxy/worker-state.ts";
import {
  buildHostProxyAllowlistDoctorCheck,
  currentHostProxyAllowlistFreshness,
} from "./doctor-host-proxy-allowlist.ts";
import type {
  DoctorCheck,
  DoctorProviderKind,
  DoctorRuntime,
  DoctorSelectionRecord,
  DoctorSolution,
} from "./doctor.ts";
import { OpenAppResultSchema } from "./open.ts";

interface HostProxyDoctorProvider {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly tcpHostGateway?: string;
  readonly exec: RuntimeProviderShape["exec"];
}

export interface HostProxyTransportDoctorOptions {
  readonly userDataRoot?: string;
  readonly provider: HostProxyDoctorProvider;
  readonly providerKind: DoctorProviderKind;
  readonly runtimeStatus: string;
  readonly runtime: DoctorRuntime;
  readonly selection: DoctorSelectionRecord;
  readonly sourceEnv?: Record<string, string | undefined>;
}

const HOST_PROXY_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description:
    "The app's host-proxy transport is unreachable. Run `lando restart` from the app to recreate its authenticated bridge.",
  command: "lando restart",
};

const successfulOpenOutput = (stdout: string): boolean => {
  try {
    const envelope = Schema.decodeUnknownEither(CommandResultEnvelope)(JSON.parse(stdout.trim()));
    if (Either.isLeft(envelope)) return false;
    if (envelope.right.command !== "app:open" || !envelope.right.ok) return false;
    return Either.isRight(Schema.decodeUnknownEither(OpenAppResultSchema)(envelope.right.result));
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
};

const unixSocketMetadata = (socketPath: string) =>
  Effect.promise(async () => {
    try {
      const metadata = await lstat(socketPath);
      return { type: metadata.isSocket() ? "socket" : "other", mode: metadata.mode & 0o777 } as const;
    } catch {
      return undefined;
    }
  });

const containerGatewayMatches = (containerUrl: string, gateway: string): boolean => {
  try {
    return new URL(containerUrl).hostname === gateway;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
};

export const hostProxyTransportDoctorChecks = (
  options: HostProxyTransportDoctorOptions,
): Effect.Effect<ReadonlyArray<DoctorCheck>> =>
  Effect.gen(function* () {
    const paths = makeLandoPaths(
      options.userDataRoot === undefined ? {} : { userDataRoot: options.userDataRoot },
    );
    const redactionService = yield* Effect.serviceOption(RedactionService);
    const redactor = Option.isSome(redactionService)
      ? yield* redactionService.value.forProfile("secrets", { sourceEnv: options.sourceEnv })
      : createStandaloneRedactor("secrets", { sourceEnv: options.sourceEnv });
    const freshness = currentHostProxyAllowlistFreshness();
    const entries = yield* Effect.promise(() =>
      readdir(paths.hostProxyRunRoot, { withFileTypes: true }).catch(() => []),
    );
    const checks: DoctorCheck[] = [];
    const allowlistCheck = buildHostProxyAllowlistDoctorCheck(freshness, options);
    if (allowlistCheck !== undefined) checks.push(allowlistCheck);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = resolve(paths.hostProxyRunRoot, entry.name);
      const record = yield* readWorkerRecordAt(resolve(runDir, "worker.json"));
      if (record === undefined) continue;
      if (resolve(paths.hostProxyRunDir(record.appId, record.appRoot)) !== runDir) continue;

      const probe = yield* probeWorker(record);
      const socketMetadata =
        record.transport === "unix-socket" && record.socketPath !== undefined
          ? yield* unixSocketMetadata(record.socketPath)
          : undefined;
      const socketReady = socketMetadata?.type === "socket" && socketMetadata.mode === 0o600;
      const gatewayAvailable = options.provider.tcpHostGateway !== undefined;
      const gatewayMatches =
        record.transport === "tcp-host-gateway" &&
        record.containerUrl !== undefined &&
        options.provider.tcpHostGateway !== undefined &&
        containerGatewayMatches(record.containerUrl, options.provider.tcpHostGateway);
      const containerProbeReady =
        record.transport === "tcp-host-gateway" &&
        probe === "live" &&
        gatewayAvailable &&
        gatewayMatches &&
        record.containerUrl !== undefined &&
        record.probeService !== undefined
          ? yield* runProbe<ExecResult, ProviderError, never>(
              {
                id: `doctor:host-proxy:${record.appId}`,
                policy: { maxAttempts: 1, timeout: Duration.seconds(5), backoff: "fixed" },
                classify: {
                  success: (result) =>
                    typeof result === "object" &&
                    result !== null &&
                    "exitCode" in result &&
                    result.exitCode === 0 &&
                    "stdout" in result &&
                    typeof result.stdout === "string" &&
                    successfulOpenOutput(result.stdout)
                      ? "green"
                      : "red",
                  failure: () => "red",
                },
              },
              options.provider.exec(
                { app: AppId.make(record.appId), service: ServiceName.make(record.probeService) },
                {
                  command: ["/usr/local/bin/lando", "open", "--print"],
                  env: { LANDO_HOST_PROXY_URL: record.containerUrl },
                  stdin: "ignore",
                  tty: false,
                },
              ),
            ).pipe(
              Effect.map((result) => result.outcome === "green"),
              Effect.catchAll(() => Effect.succeed(false)),
            )
          : false;
      const reachable =
        probe === "live" && (record.transport === "unix-socket" ? socketReady : containerProbeReady);
      const endpoint = record.transport === "unix-socket" ? record.socketPath : record.containerUrl;
      const rawContext: Record<string, string> = {
        providerId: options.provider.id,
        providerKind: options.providerKind,
        providerVersion: options.provider.version,
        appId: record.appId,
        transport: record.transport,
        reachability: reachable ? "reachable" : "unreachable",
        endpoint: endpoint ?? "missing",
        ...(record.transport === "unix-socket"
          ? {
              socketType: socketMetadata?.type ?? "missing",
              socketMode:
                socketMetadata === undefined ? "missing" : socketMetadata.mode.toString(8).padStart(4, "0"),
            }
          : {}),
        ...(record.transport === "tcp-host-gateway" && options.provider.tcpHostGateway !== undefined
          ? { containerGateway: options.provider.tcpHostGateway }
          : {}),
        ...(record.transport === "tcp-host-gateway" && !gatewayAvailable
          ? { failure: "container-gateway-unavailable" }
          : record.transport === "tcp-host-gateway" && !gatewayMatches
            ? { failure: "container-gateway-mismatch" }
            : record.transport === "tcp-host-gateway" && !containerProbeReady
              ? { failure: "container-probe-failed" }
              : {}),
      };
      const context = Object.fromEntries(
        Object.entries(rawContext).map(([key, value]) => [key, redactor.redactString(value)]),
      );
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
