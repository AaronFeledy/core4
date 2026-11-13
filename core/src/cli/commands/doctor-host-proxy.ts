import { resolve } from "node:path";
import { readWorkerRecordStateAt } from "@lando/engine/subsystems/host-proxy/worker-state-file";
import { sanitizeAppName } from "@lando/paths";
import { PathsService } from "@lando/sdk/services";
import { Clock, Duration, Effect, Option } from "effect";
import { CliInvocation } from "../../runtime/invocation-context";
import type { DoctorFinding, DoctorSectionResult, DoctorSkipInput, DoctorSolution } from "./doctor-contract";
import {
  buildHostProxyAllowlistDoctorCheck,
  currentHostProxyAllowlistFreshness,
} from "./doctor-host-proxy-allowlist";
import { HostProxyDoctorFileSystem } from "./doctor-host-proxy-filesystem";
import { compareCodePointStrings } from "./doctor-host-proxy-order";
import {
  type HostProxyDoctorLimits,
  type HostProxyDoctorProvider,
  diagnoseHostProxyWorker,
} from "./doctor-host-proxy-worker";
import { resolveSecretsRedactor } from "./secrets-redactor";

const DEFAULT_LIMITS: HostProxyDoctorLimits = {
  maxWorkers: 32,
  maxProbeServices: 8,
  budgetMs: 15_000,
};

export interface HostProxyTransportDoctorOptions {
  readonly provider: HostProxyDoctorProvider;
  readonly sourceEnv?: Record<string, string | undefined>;
  readonly limits?: HostProxyDoctorLimits;
  readonly runtimeIdle?: boolean;
}

const HOST_PROXY_STATE_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description:
    "The persisted host-proxy worker state is unreadable or malformed. Inspect or remove that worker state, then retry.",
};

export const hostProxyTransportDoctorChecks = Effect.fnUntraced(function* (
  options: HostProxyTransportDoctorOptions,
): Effect.fn.Return<DoctorSectionResult, never, HostProxyDoctorFileSystem | PathsService> {
  const fileSystem = yield* HostProxyDoctorFileSystem;
  const paths = yield* PathsService;
  const { redactor } = yield* resolveSecretsRedactor({
    sourceEnv: { ...(options.sourceEnv ?? (yield* CliInvocation).env) },
  });
  const freshness = currentHostProxyAllowlistFreshness();
  const checks: DoctorFinding[] = [];
  const skipped: DoctorSkipInput[] = [];
  const result = (): DoctorSectionResult => ({ checks, ...(skipped.length === 0 ? {} : { skipped }) });
  const allowlistCheck = buildHostProxyAllowlistDoctorCheck(freshness);
  if (allowlistCheck !== undefined) checks.push(allowlistCheck);
  const limits = options.limits ?? DEFAULT_LIMITS;
  const deadline = (yield* Clock.currentTimeMillis) + limits.budgetMs;
  const rootStateOption = yield* fileSystem
    .readRoot(paths.hostProxyRunRoot)
    .pipe(Effect.timeoutOption(Duration.millis(Math.max(0, deadline - (yield* Clock.currentTimeMillis)))));
  if (Option.isNone(rootStateOption)) {
    skipped.push({ reason: "worker-root-budget-exhausted" });
    return result();
  }
  const rootState = rootStateOption.value;
  switch (rootState._tag) {
    case "absent":
      return result();
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
        context: Object.fromEntries(
          Object.entries(rawContext).map(([key, value]) => [key, redactor.redactString(value)]),
        ),
        solutions: [HOST_PROXY_STATE_REMEDIATION],
      });
      return result();
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
    if (remainingMs <= 0) {
      skipped.push({ reason: "worker-budget-exhausted" });
      break;
    }
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
            context: { workerState: "malformed", statePath: recordPath },
            solutions: [HOST_PROXY_STATE_REMEDIATION],
          } satisfies DoctorFinding;
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
          if (state.appRoot === null) return undefined;
          const ownedRunDir =
            state.appRoot === undefined
              ? resolve(paths.hostProxyRunRoot, sanitizeAppName(state.record.appId))
              : resolve(paths.hostProxyRunDir(state.record.appId, state.appRoot));
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
    if (Option.isNone(bounded)) {
      skipped.push({ reason: "worker-budget-exhausted" });
      break;
    }
    if (bounded.value === undefined) continue;
    if (!("name" in bounded.value)) {
      skipped.push({
        ...bounded.value,
        ...(bounded.value.check === undefined ? {} : { check: redactor.redactString(bounded.value.check) }),
        reason: redactor.redactString(bounded.value.reason),
      });
      continue;
    }
    if (bounded.value.context.reachability === "skipped")
      skipped.push({
        check: `host-proxy-transport:${redactor.redactString(bounded.value.context.appId ?? "unknown")}`,
        reason: `Provider ${options.provider.id} is idle; host-proxy reachability was not probed.`,
      });
    checks.push({
      ...bounded.value,
      context: Object.fromEntries(
        Object.entries(bounded.value.context).map(([key, value]) => [key, redactor.redactString(value)]),
      ),
    });
  }
  if (rootState.entries.filter((entry) => entry.isDirectory).length > workerEntries.length)
    skipped.push({ reason: "worker-cap-exhausted" });
  return result();
});
