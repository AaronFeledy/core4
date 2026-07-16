import { resolve } from "node:path";

import { Clock, Duration, Effect, Option } from "effect";

import { makeLandoPaths, sanitizeAppName } from "../../config/paths.ts";
import { RedactionService, createStandaloneRedactor } from "../../redaction/service.ts";
import { readWorkerRecordStateAt } from "../../subsystems/host-proxy/worker-state-file.ts";
import {
  buildHostProxyAllowlistDoctorCheck,
  currentHostProxyAllowlistFreshness,
} from "./doctor-host-proxy-allowlist.ts";
import { HostProxyDoctorFileSystem } from "./doctor-host-proxy-filesystem.ts";
import { compareCodePointStrings } from "./doctor-host-proxy-order.ts";
import {
  type HostProxyDoctorLimits,
  type HostProxyDoctorProvider,
  diagnoseHostProxyWorker,
} from "./doctor-host-proxy-worker.ts";
import type {
  DoctorCheck,
  DoctorProviderKind,
  DoctorRuntime,
  DoctorSelectionRecord,
  DoctorSolution,
} from "./doctor.ts";

const DEFAULT_LIMITS: HostProxyDoctorLimits = {
  maxWorkers: 32,
  maxProbeServices: 8,
  budgetMs: 15_000,
};

export interface HostProxyTransportDoctorOptions {
  readonly userDataRoot?: string;
  readonly provider: HostProxyDoctorProvider;
  readonly providerKind: DoctorProviderKind;
  readonly runtimeStatus: string;
  readonly runtime: DoctorRuntime;
  readonly selection: DoctorSelectionRecord;
  readonly sourceEnv?: Record<string, string | undefined>;
  readonly limits?: HostProxyDoctorLimits;
}

const HOST_PROXY_STATE_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description:
    "The persisted host-proxy worker state is unreadable or malformed. Inspect or remove that worker state, then retry.",
};

export const hostProxyTransportDoctorChecks = (
  options: HostProxyTransportDoctorOptions,
): Effect.Effect<ReadonlyArray<DoctorCheck>, never, HostProxyDoctorFileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* HostProxyDoctorFileSystem;
    const paths = makeLandoPaths(
      options.userDataRoot === undefined ? {} : { userDataRoot: options.userDataRoot },
    );
    const redactionService = yield* Effect.serviceOption(RedactionService);
    const redactor = Option.isSome(redactionService)
      ? yield* redactionService.value.forProfile("secrets", { sourceEnv: options.sourceEnv })
      : createStandaloneRedactor("secrets", { sourceEnv: options.sourceEnv });
    const freshness = currentHostProxyAllowlistFreshness();
    const checks: DoctorCheck[] = [];
    const allowlistCheck = buildHostProxyAllowlistDoctorCheck(freshness, options);
    if (allowlistCheck !== undefined) checks.push(allowlistCheck);
    const limits = options.limits ?? DEFAULT_LIMITS;
    const deadline = (yield* Clock.currentTimeMillis) + limits.budgetMs;
    const rootStateOption = yield* fileSystem
      .readRoot(paths.hostProxyRunRoot)
      .pipe(Effect.timeoutOption(Duration.millis(Math.max(0, deadline - (yield* Clock.currentTimeMillis)))));
    if (Option.isNone(rootStateOption)) return checks;
    const rootState = rootStateOption.value;
    switch (rootState._tag) {
      case "absent":
        return checks;
      case "unreadable": {
        const rawContext = {
          workerState: "unreadable",
          statePath: paths.hostProxyRunRoot,
          reason: "worker-root-unreadable",
          errorCode: rootState.errorCode,
        };
        checks.push({
          name: "host-proxy-state",
          status: "warn",
          severity: "warn",
          providerId: options.provider.id,
          providerName: options.provider.displayName,
          providerVersion: options.provider.version,
          providerKind: options.providerKind,
          runtimeStatus: options.runtimeStatus,
          runtime: options.runtime,
          capabilities: {},
          context: Object.fromEntries(
            Object.entries(rawContext).map(([key, value]) => [key, redactor.redactString(value)]),
          ),
          solutions: [HOST_PROXY_STATE_REMEDIATION],
          selection: options.selection,
        });
        return checks;
      }
      case "entries":
        break;
      default: {
        const exhaustive: never = rootState;
        return exhaustive;
      }
    }
    const workerEntries = rootState.entries
      .filter((entry) => entry.isDirectory)
      .sort((left, right) => compareCodePointStrings(left.name, right.name))
      .slice(0, limits.maxWorkers);
    for (const entry of workerEntries) {
      const remainingMs = deadline - (yield* Clock.currentTimeMillis);
      if (remainingMs <= 0) break;
      const runDir = resolve(paths.hostProxyRunRoot, entry.name);
      const recordPath = resolve(runDir, "worker.json");
      const diagnoseEntry = Effect.gen(function* () {
        const state = yield* readWorkerRecordStateAt(recordPath);
        switch (state._tag) {
          case "absent":
            return undefined;
          case "malformed":
            return {
              name: "host-proxy-state",
              status: "warn",
              severity: "warn",
              providerId: options.provider.id,
              providerName: options.provider.displayName,
              providerVersion: options.provider.version,
              providerKind: options.providerKind,
              runtimeStatus: options.runtimeStatus,
              runtime: options.runtime,
              capabilities: {},
              context: { workerState: "malformed", statePath: recordPath },
              solutions: [HOST_PROXY_STATE_REMEDIATION],
              selection: options.selection,
            } satisfies DoctorCheck;
          case "current": {
            const ownedRunDir = resolve(paths.hostProxyRunDir(state.record.appId, state.record.appRoot));
            if (ownedRunDir !== runDir) return undefined;
            return yield* diagnoseHostProxyWorker({
              doctor: options,
              record: state.record,
              current: true,
              maxProbeServices: limits.maxProbeServices,
            });
          }
          case "legacy": {
            const ownedRunDir = resolve(paths.hostProxyRunRoot, sanitizeAppName(state.record.appId));
            if (ownedRunDir !== runDir) return undefined;
            return yield* diagnoseHostProxyWorker({
              doctor: options,
              record: state.record,
              current: false,
              maxProbeServices: limits.maxProbeServices,
            });
          }
          default: {
            const exhaustive: never = state;
            return exhaustive;
          }
        }
      });
      const bounded = yield* diagnoseEntry.pipe(Effect.timeoutOption(Duration.millis(remainingMs)));
      if (Option.isNone(bounded)) break;
      if (bounded.value === undefined) continue;
      checks.push({
        ...bounded.value,
        context: Object.fromEntries(
          Object.entries(bounded.value.context).map(([key, value]) => [key, redactor.redactString(value)]),
        ),
      });
    }
    return checks;
  });
